"""MCP client and dynamic tool-provider lifecycle."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import re
import sys
import urllib.parse
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import AsyncExitStack, suppress
from typing import TYPE_CHECKING, Any, Literal, Protocol, TextIO, cast

import httpx
from loguru import logger
from pydantic import BaseModel, Field

from nanobot.agent.tools.base import Tool, ToolResult
from nanobot.agent.tools.context import tool_log_content_allowed
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.utils.cancellation import task_is_cancelling

if TYPE_CHECKING:
    from mcp import ClientSession
    from mcp.types import Prompt, Resource
    from mcp.types import Tool as MCPToolDefinition



class MCPServerConfig(BaseModel):
    """MCP server connection configuration (stdio or HTTP)."""

    type: Literal["stdio", "sse", "streamableHttp"] | None = None  # auto-detected if omitted
    command: str = ""  # Stdio: command to run (e.g. "npx")
    args: list[str] = Field(default_factory=list)  # Stdio: command arguments
    env: dict[str, str] = Field(default_factory=dict)  # Stdio: extra env vars
    cwd: str = ""  # Stdio: working directory for MCP server runtime artifacts
    url: str = ""  # HTTP/SSE: endpoint URL
    headers: dict[str, str] = Field(default_factory=dict)  # HTTP/SSE: custom headers
    tool_timeout: int = 30  # seconds before a tool call is cancelled (per server)
    # Tool results keep their image blocks as image_url content blocks; off, an image
    # is reported by its MIME type and its bytes are dropped.
    images: bool = False


# Connection errors: the server's process or connection is gone. A call that fails with one is not
# repeated: the server may have run it before the connection broke.
_TRANSIENT_EXC_NAMES: frozenset[str] = frozenset((
    "ClosedResourceError",
    "BrokenResourceError",
    "EndOfStream",
    "BrokenPipeError",
    "ConnectionResetError",
    "ConnectionRefusedError",
    "ConnectionAbortedError",
    "ConnectionError",
))

# Characters allowed in tool names by model providers.
# Replace anything outside [a-zA-Z0-9_-] with underscore and collapse runs.
_SANITIZE_RE = re.compile(r"_+")
# Called with a server's name when its session is found ended.
_EndedCallback = Callable[[str], None]


class MCPConnection(Protocol):
    async def aclose(self) -> None: ...


async def _close_mcp_connection(name: str, connection: MCPConnection) -> None:
    try:
        await connection.aclose()
    except asyncio.CancelledError:
        if task_is_cancelling():
            raise
        logger.debug("MCP server '{}' cleanup error (can be ignored)", name)
    except (RuntimeError, BaseExceptionGroup):
        logger.debug("MCP server '{}' cleanup error (can be ignored)", name)


async def _close_mcp_connections(connections: Mapping[str, MCPConnection]) -> None:
    cancellation: asyncio.CancelledError | None = None
    for name, connection in connections.items():
        try:
            await _close_mcp_connection(name, connection)
        except asyncio.CancelledError as exc:
            cancellation = cancellation or exc
    if cancellation is not None:
        raise cancellation


class _OwnedMCPConnection:
    """Close an MCP transport from the task that originally opened it."""

    def __init__(self, owner: asyncio.Task[None], close_requested: asyncio.Event) -> None:
        self._owner = owner
        self._close_requested = close_requested
        # What the server said at initialize for the model: how to use its tools (empty when it said nothing).
        self.instructions = ""

    async def aclose(self) -> None:
        self._close_requested.set()
        try:
            await asyncio.shield(self._owner)
        except asyncio.CancelledError:
            if not self._owner.cancelled():
                raise


def _is_malformed_mcp_progress_notification(message: Any) -> bool:
    payload = _mcp_jsonrpc_payload(message)
    if _payload_value(payload, "method") != "notifications/progress":
        return False

    params = _payload_value(payload, "params")
    return not _progress_params_have_token(params)


def _mcp_jsonrpc_payload(message: Any) -> Any:
    """Return the JSON-RPC payload across current and future MCP SDK shapes."""
    envelope = getattr(message, "message", message)
    return getattr(envelope, "root", None) or envelope


def _payload_value(payload: Any, key: str) -> Any:
    if isinstance(payload, Mapping):
        return cast(Mapping[str, Any], payload).get(key)
    return getattr(payload, key, None)


def _progress_params_have_token(params: Any) -> bool:
    if isinstance(params, Mapping):
        return "progressToken" in params
    return hasattr(params, "progressToken") or hasattr(params, "progress_token")


class _MalformedProgressNotificationFilter:
    def __init__(
        self, read_stream: Any, server_name: str, on_end: Callable[[], None] | None = None
    ) -> None:
        self._read_stream = read_stream
        self._server_name = server_name
        # Called when the transport ends by itself (the process exited, the connection dropped).
        self._on_end = on_end
        self._iterator: AsyncIterator[Any] | None = None

    async def __aenter__(self) -> "_MalformedProgressNotificationFilter":
        await self._read_stream.__aenter__()
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> Any:
        return await self._read_stream.__aexit__(exc_type, exc, tb)

    def __aiter__(self) -> "_MalformedProgressNotificationFilter":
        self._iterator = self._read_stream.__aiter__()
        return self

    async def __anext__(self) -> Any:
        iterator = self._iterator
        if iterator is None:
            iterator = self._read_stream.__aiter__()
            self._iterator = iterator

        while True:
            try:
                message = await anext(iterator)
            except StopAsyncIteration:
                if self._on_end is not None:
                    self._on_end()
                raise
            if _is_malformed_mcp_progress_notification(message):
                logger.debug(
                    "MCP server '{}': dropped progress notification without progressToken",
                    self._server_name,
                )
                continue
            return message

    async def aclose(self) -> None:
        close = getattr(self._read_stream, "aclose", None)
        if close is not None:
            await close()


def _filter_malformed_mcp_progress_notifications(
    read_stream: Any, server_name: str, on_end: Callable[[], None] | None = None
) -> Any:
    if not all(hasattr(read_stream, name) for name in ("__aenter__", "__aexit__", "__aiter__")):
        return read_stream
    return _MalformedProgressNotificationFilter(read_stream, server_name, on_end)


def _sanitize_name(name: str) -> str:
    """Sanitize an MCP-derived name for model API compatibility."""
    return _SANITIZE_RE.sub("_", re.sub(r"[^a-zA-Z0-9_-]", "_", name))


_MAX_TOOL_NAME_LENGTH = 64
_HASH_LENGTH = 8


def _limit_tool_name(name: str, max_length: int = _MAX_TOOL_NAME_LENGTH) -> str:
    """Limit a tool name while keeping short names unchanged."""
    if len(name) <= max_length:
        return name

    digest = hashlib.sha1(name.encode("utf-8")).hexdigest()[:_HASH_LENGTH]
    prefix_length = max_length - _HASH_LENGTH - 1
    return f"{name[:prefix_length]}_{digest}"


def _sanitize_mcp_tool_name(name: str) -> str:
    """Sanitize and limit an MCP-derived tool name."""
    return _limit_tool_name(_sanitize_name(name))


def _is_transient(exc: BaseException) -> bool:
    """Check if an exception looks like a transient connection error."""
    return type(exc).__name__ in _TRANSIENT_EXC_NAMES


def _is_transient_connection_failure(exc: BaseException) -> bool:
    if isinstance(exc, BaseExceptionGroup):
        group = cast(BaseExceptionGroup[BaseException], exc)
        return bool(group.exceptions) and all(
            _is_transient_connection_failure(nested) for nested in group.exceptions
        )
    return isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout)) or _is_transient(exc)


def _failure_text(exc: BaseException) -> str:
    """One line of why a connection failed: the innermost error of a group, by its type and its message."""
    while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
        exc = exc.exceptions[0]
    message = str(exc).strip()
    return f"{type(exc).__name__}: {message}" if message else type(exc).__name__


def _log_mcp_connection_failure(name: str, exc: BaseException, hint: str = "") -> None:
    exception = exc if tool_log_content_allowed() else False
    if _is_transient_connection_failure(exc):
        logger.warning("MCP server '{}': transient connection failure", name)
        logger.opt(exception=exception).debug(
            "MCP server '{}' transient connection failure details", name
        )
        return
    logger.opt(exception=exception).error("MCP server '{}': failed to connect: {}", name, hint)


def _is_session_terminated(exc: BaseException) -> bool:
    """Return True when the MCP SDK reports a dead client session."""
    if _is_transient(exc):
        return True
    messages = [str(exc)]
    error = getattr(exc, "error", None)
    if error is not None:
        messages.append(str(getattr(error, "message", "")))
    return any(
        marker in message.lower()
        for marker in ("session terminated", "connection closed")
        for message in messages
    )


async def _probe_http_url(url: str, timeout: float = 3.0) -> bool:
    """Quick TCP probe to check if an HTTP MCP server is reachable.

    Avoids entering ``streamable_http_client`` / ``sse_client`` when the port is
    closed - those transports use anyio task groups whose cleanup can raise
    ``RuntimeError`` / ``ExceptionGroup`` that escape the caller's try/except
    and crash the event loop.
    """
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port
    if not port:
        port = 443 if parsed.scheme == "https" else 80
    try:
        _reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port),
            timeout=timeout,
        )
        writer.close()
        with suppress(OSError, asyncio.TimeoutError):
            await asyncio.wait_for(writer.wait_closed(), timeout=0.2)
        return True
    except (OSError, asyncio.TimeoutError):
        return False


def _redact_url(url: str) -> str:
    """Strip credentials and query/fragment before logging an MCP URL.

    Server URLs may embed secrets (``https://user:token@host/sse`` or a
    ``?token=`` query). Some deployments also put opaque tokens in the path, so
    log only the origin and a path placeholder.
    """
    try:
        parts = urllib.parse.urlsplit(url)
        hostname = parts.hostname or ""
        netloc = f"[{hostname}]" if ":" in hostname else hostname
        if parts.port:
            netloc = f"{netloc}:{parts.port}"
        path = "/..." if parts.path and parts.path != "/" else parts.path
        return urllib.parse.urlunsplit((parts.scheme, netloc, path, "", ""))
    except Exception:
        return "<redacted-url>"


def _extract_nullable_branch(options: Any) -> tuple[dict[str, Any], bool] | None:
    """Return the single non-null branch for nullable unions."""
    if not isinstance(options, list):
        return None

    non_null: list[dict[str, Any]] = []
    saw_null = False
    for option in cast(list[object], options):
        if not isinstance(option, dict):
            return None
        option_schema = cast(dict[str, Any], option)
        if option_schema.get("type") == "null":
            saw_null = True
            continue
        non_null.append(option_schema)

    if saw_null and len(non_null) == 1:
        return non_null[0], True
    return None


def _resolve_local_schema_ref(root: dict[str, Any], ref: str) -> Any:
    """Resolve a local JSON Pointer without accepting remote references."""
    if not ref.startswith("#"):
        raise ValueError("not a local JSON Pointer")

    pointer = urllib.parse.unquote(ref[1:], errors="strict")
    if not pointer:
        return root
    if not pointer.startswith("/"):
        raise ValueError("not a local JSON Pointer")

    current: Any = root
    for raw_part in pointer[1:].split("/"):
        part = raw_part.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict):
            current = cast(dict[str, Any], current)[part]
        elif isinstance(current, list):
            current = cast(list[Any], current)[int(part)]
        else:
            raise KeyError(part)
    return current


def _rewrite_local_schema_refs(schema: dict[str, Any]) -> dict[str, Any]:
    """Hoist arbitrary local JSON-Pointer refs into provider-compatible ``$defs``."""
    rewritten_refs: dict[str, str] = {}
    generated_defs: dict[str, Any] = {}

    def rewrite(value: Any) -> Any:
        if isinstance(value, list):
            return [rewrite(item) for item in cast(list[Any], value)]
        if not isinstance(value, dict):
            return value

        rewritten = dict(cast(dict[str, Any], value))
        raw_ref = rewritten.get("$ref")
        ref = raw_ref if isinstance(raw_ref, str) else None
        is_rewritable_ref = False
        if ref is not None and not ref.startswith("#/$defs/"):
            try:
                pointer = urllib.parse.unquote(ref[1:], errors="strict")
            except (UnicodeDecodeError, ValueError):
                pass
            else:
                is_rewritable_ref = ref.startswith("#") and (
                    not pointer or pointer.startswith("/")
                )
        if is_rewritable_ref:
            assert ref is not None
            name = rewritten_refs.get(ref)
            if name is None:
                try:
                    target = _resolve_local_schema_ref(schema, ref)
                except (KeyError, IndexError, TypeError, UnicodeDecodeError, ValueError):
                    logger.warning("MCP tool schema contains an unresolved local $ref: {}", ref)
                else:
                    name = f"ref_{hashlib.sha256(ref.encode()).hexdigest()[:12]}"
                    existing_defs = schema.get("$defs")
                    while isinstance(existing_defs, dict) and name in existing_defs:
                        name += "_"
                    rewritten_refs[ref] = name
                    # Reserve the name before descending so recursive refs terminate.
                    generated_defs[name] = {}
                    generated_defs[name] = rewrite(target)
            if name is not None:
                rewritten["$ref"] = f"#/$defs/{name}"

        return {key: rewrite(item) for key, item in rewritten.items()}

    result = cast(dict[str, Any], rewrite(schema))
    if generated_defs:
        existing_defs = result.get("$defs")
        result["$defs"] = {
            **(existing_defs if isinstance(existing_defs, dict) else {}),
            **generated_defs,
        }
    return result


def _normalize_nullable_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Normalize nullable forms in structural subschemas only."""
    normalized = dict(schema)
    raw_type = normalized.get("type")
    if isinstance(raw_type, list):
        type_values = cast(list[Any], raw_type)
        non_null = [item for item in type_values if item != "null"]
        if "null" in type_values and len(non_null) == 1:
            normalized["type"] = non_null[0]
            normalized["nullable"] = True

    for key in ("oneOf", "anyOf"):
        nullable_branch = _extract_nullable_branch(normalized.get(key))
        if nullable_branch is not None:
            branch, _ = nullable_branch
            merged = {k: v for k, v in normalized.items() if k != key}
            merged.update(branch)
            normalized = merged
            normalized["nullable"] = True
            break

    properties = normalized.get("properties")
    if isinstance(properties, dict):
        property_schemas = cast(dict[str, Any], properties)
        normalized["properties"] = {
            name: (
                _normalize_nullable_schema(cast(dict[str, Any], prop))
                if isinstance(prop, dict)
                else prop
            )
            for name, prop in property_schemas.items()
        }
    items = normalized.get("items")
    if isinstance(items, dict):
        normalized["items"] = _normalize_nullable_schema(cast(dict[str, Any], items))
    definitions = normalized.get("$defs")
    if isinstance(definitions, dict):
        definition_schemas = cast(dict[str, Any], definitions)
        normalized["$defs"] = {
            name: _normalize_nullable_schema(cast(dict[str, Any], definition))
            if isinstance(definition, dict)
            else definition
            for name, definition in definition_schemas.items()
        }

    if normalized.get("type") == "object":
        normalized.setdefault("properties", {})
        normalized.setdefault("required", [])
    return normalized


def _normalize_schema_for_openai(schema: Any) -> dict[str, Any]:
    """Normalize MCP JSON Schema patterns for tool definitions."""
    if not isinstance(schema, dict):
        return {"type": "object", "properties": {}}
    schema_mapping = cast(dict[str, Any], schema)
    return _normalize_nullable_schema(_rewrite_local_schema_refs(schema_mapping))


class _MCPWrapperBase(Tool):
    """A wrapper bound to one MCP server session, which reports the session's end and never reconnects."""

    _session: ClientSession
    _server_name: str
    _name: str

    def _set_mcp_connection(
        self, session: ClientSession, server_name: str, on_ended: _EndedCallback | None
    ) -> None:
        self._session = session
        self._server_name = server_name
        self._on_ended = on_ended

    def _report_if_ended(self, exc: BaseException) -> None:
        """A call that found the session gone says so; the call is not repeated, it fails with its error."""
        if self._on_ended is not None and _is_session_terminated(exc):
            self._on_ended(self._server_name)


def _image_block(block: Any, types: Any) -> tuple[str, str] | None:
    """Return ``(mime type, base64 data)`` of an MCP image-bearing content block, or ``None``.

    Handles ``ImageContent`` directly and ``EmbeddedResource`` wrapping a binary
    blob with an ``image/*`` MIME type. ``getattr`` guards keep this safe when
    the installed/faked ``mcp`` SDK does not expose a given type.
    """
    image_cls = getattr(types, "ImageContent", None)
    if image_cls is not None and isinstance(block, image_cls):
        return getattr(block, "mimeType", None) or "image/png", _base64_text(block.data)

    embedded_cls = getattr(types, "EmbeddedResource", None)
    blob_cls = getattr(types, "BlobResourceContents", None)
    if embedded_cls is not None and isinstance(block, embedded_cls):
        resource = getattr(block, "resource", None)
        if blob_cls is not None and isinstance(resource, blob_cls):
            mime = getattr(cast(Any, resource), "mimeType", None) or ""
            if isinstance(mime, str) and mime.startswith("image/"):
                return mime, _base64_text(cast(Any, resource).blob)
    return None


def _base64_text(data: str | bytes) -> str:
    """The SDK carries image data as base64 text; raw bytes are encoded to match."""
    return data if isinstance(data, str) else base64.b64encode(data).decode("ascii")


class MCPToolWrapper(_MCPWrapperBase):
    """Wraps a single MCP server tool as a nanobot Tool."""


    def __init__(
        self,
        session: ClientSession,
        server_name: str,
        tool_def: MCPToolDefinition,
        tool_timeout: int = 30,
        images: bool = False,
        on_ended: _EndedCallback | None = None,
    ):
        self._set_mcp_connection(session, server_name, on_ended)
        self._images = images
        self._original_name = tool_def.name
        self._name = _sanitize_mcp_tool_name(f"mcp_{server_name}_{tool_def.name}")
        self._description = tool_def.description or tool_def.name
        raw_schema = tool_def.inputSchema or {"type": "object", "properties": {}}
        self._parameters = _normalize_schema_for_openai(raw_schema)
        self._tool_timeout = tool_timeout

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._description

    @property
    def parameters(self) -> dict[str, Any]:
        return self._parameters

    async def execute(self, **kwargs: Any) -> str:
        try:
            result = await asyncio.wait_for(
                self._session.call_tool(self._original_name, arguments=kwargs),
                timeout=self._tool_timeout,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "MCP tool '{}' timed out after {}s", self._name, self._tool_timeout
            )
            return ToolResult.error(
                f"(MCP tool call timed out after {self._tool_timeout}s)"
            )
        except asyncio.CancelledError:
            # MCP SDK's anyio cancel scopes can leak CancelledError on timeout/failure.
            # Re-raise only if our task was externally cancelled (e.g. /stop).
            if task_is_cancelling():
                raise
            logger.warning("MCP tool '{}' was cancelled by server/SDK", self._name)
            return ToolResult.error("(MCP tool call was cancelled)")
        except Exception as exc:
            self._report_if_ended(exc)
            logger.opt(exception=tool_log_content_allowed()).error(
                "MCP tool '{}' failed: {}: {}",
                self._name,
                type(exc).__name__,
                exc if tool_log_content_allowed() else "[content hidden]",
            )
            return ToolResult.error(
                f"(MCP tool call failed: {type(exc).__name__})"
            )
        # Success: render the content blocks as text.
        try:
            if getattr(result, "isError", False):
                # An error is text for the model; images are not kept in it.
                rendered = self._render_call_result(result.content, images=False)
                return ToolResult.error(str(rendered))
            return self._render_call_result(result.content, images=self._images)
        except Exception as exc:
            logger.opt(exception=tool_log_content_allowed()).error(
                "MCP tool '{}' failed while rendering result: {}: {}",
                self._name,
                type(exc).__name__,
                exc if tool_log_content_allowed() else "[content hidden]",
            )
            return ToolResult.error(
                f"(MCP tool returned malformed content: {type(exc).__name__})"
            )

    @staticmethod
    def _render_call_result(content: Any, *, images: bool = False) -> str | list[dict[str, Any]]:
        """Turn MCP content blocks into a tool result.

        Text is concatenated into a string. An image block is reported by MIME
        type and its bytes are dropped, unless ``images`` is set: then a result
        with an image is a list of content blocks in the server's order, text as
        ``{"type": "text"}`` and each image as an ``image_url`` data URL. A
        result without an image stays a string either way.
        """
        from mcp import types

        parts: list[dict[str, Any]] = []
        has_image = False
        for block in content:
            if isinstance(block, types.TextContent):
                parts.append({"type": "text", "text": block.text})
                continue
            image = _image_block(block, types)
            if image is None:
                parts.append({"type": "text", "text": str(block)})
            elif images:
                mime, data = image
                has_image = True
                parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}})
            else:
                note = f"(MCP tool returned an image ({image[0]}); images are not supported)"
                parts.append({"type": "text", "text": note})
        if has_image:
            return parts
        return "\n".join(part["text"] for part in parts) or "(no output)"


class MCPResourceWrapper(_MCPWrapperBase):
    """Wraps an MCP resource URI as a read-only nanobot Tool."""


    def __init__(
        self,
        session: ClientSession,
        server_name: str,
        resource_def: Resource,
        resource_timeout: int = 30,
        on_ended: _EndedCallback | None = None,
    ):
        self._set_mcp_connection(session, server_name, on_ended)
        self._uri = resource_def.uri
        self._name = _sanitize_mcp_tool_name(f"mcp_{server_name}_resource_{resource_def.name}")
        desc = resource_def.description or resource_def.name
        self._description = f"[MCP Resource] {desc}\nURI: {self._uri}"
        self._parameters: dict[str, Any] = {
            "type": "object",
            "properties": {},
            "required": [],
        }
        self._resource_timeout = resource_timeout

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._description

    @property
    def parameters(self) -> dict[str, Any]:
        return self._parameters

    async def execute(self, **kwargs: Any) -> str:
        from mcp import types

        try:
            result = await asyncio.wait_for(
                self._session.read_resource(self._uri),
                timeout=self._resource_timeout,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "MCP resource '{}' timed out after {}s", self._name, self._resource_timeout
            )
            return f"(MCP resource read timed out after {self._resource_timeout}s)"
        except asyncio.CancelledError:
            if task_is_cancelling():
                raise
            logger.warning("MCP resource '{}' was cancelled by server/SDK", self._name)
            return "(MCP resource read was cancelled)"
        except Exception as exc:
            self._report_if_ended(exc)
            logger.opt(exception=tool_log_content_allowed()).error(
                "MCP resource '{}' failed: {}: {}",
                self._name,
                type(exc).__name__,
                exc if tool_log_content_allowed() else "[content hidden]",
            )
            return f"(MCP resource read failed: {type(exc).__name__})"
        parts: list[str] = []
        for block in result.contents:
            if isinstance(block, types.TextResourceContents):
                parts.append(block.text)
            elif isinstance(cast(object, block), types.BlobResourceContents):
                parts.append(f"[Binary resource: {len(block.blob)} bytes]")
            else:
                parts.append(str(block))
        return "\n".join(parts) or "(no output)"


class MCPPromptWrapper(_MCPWrapperBase):
    """Wraps an MCP prompt as a read-only nanobot Tool."""


    def __init__(
        self,
        session: ClientSession,
        server_name: str,
        prompt_def: Prompt,
        prompt_timeout: int = 30,
        on_ended: _EndedCallback | None = None,
    ):
        self._set_mcp_connection(session, server_name, on_ended)
        self._prompt_name = prompt_def.name
        self._name = _sanitize_mcp_tool_name(f"mcp_{server_name}_prompt_{prompt_def.name}")
        desc = prompt_def.description or prompt_def.name
        self._description = (
            f"[MCP Prompt] {desc}\n"
            "Returns a filled prompt template that can be used as a workflow guide."
        )
        self._prompt_timeout = prompt_timeout

        # Build parameters from prompt arguments
        properties: dict[str, Any] = {}
        required: list[str] = []
        for arg in prompt_def.arguments or []:
            prop: dict[str, Any] = {"type": "string"}
            if getattr(arg, "description", None):
                prop["description"] = arg.description
            properties[arg.name] = prop
            if arg.required:
                required.append(arg.name)
        self._parameters: dict[str, Any] = {
            "type": "object",
            "properties": properties,
            "required": required,
        }

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._description

    @property
    def parameters(self) -> dict[str, Any]:
        return self._parameters

    async def execute(self, **kwargs: Any) -> str:
        from mcp import types
        from mcp.shared.exceptions import McpError

        try:
            result = await asyncio.wait_for(
                self._session.get_prompt(self._prompt_name, arguments=kwargs),
                timeout=self._prompt_timeout,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "MCP prompt '{}' timed out after {}s", self._name, self._prompt_timeout
            )
            return f"(MCP prompt call timed out after {self._prompt_timeout}s)"
        except asyncio.CancelledError:
            if task_is_cancelling():
                raise
            logger.warning("MCP prompt '{}' was cancelled by server/SDK", self._name)
            return "(MCP prompt call was cancelled)"
        except McpError as exc:
            self._report_if_ended(exc)
            logger.opt(exception=tool_log_content_allowed()).error(
                "MCP prompt '{}' failed: code={} message={}",
                self._name,
                exc.error.code,
                exc.error.message if tool_log_content_allowed() else "[content hidden]",
            )
            return f"(MCP prompt call failed: {exc.error.message} [code {exc.error.code}])"
        except Exception as exc:
            self._report_if_ended(exc)
            logger.opt(exception=tool_log_content_allowed()).error(
                "MCP prompt '{}' failed: {}: {}",
                self._name,
                type(exc).__name__,
                exc if tool_log_content_allowed() else "[content hidden]",
            )
            return f"(MCP prompt call failed: {type(exc).__name__})"
        parts: list[str] = []
        for message in result.messages:
            content = message.content
            if isinstance(content, types.TextContent):
                parts.append(content.text)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, types.TextContent):
                        parts.append(block.text)
                    else:
                        parts.append(str(block))
            else:
                parts.append(str(content))
        return "\n".join(parts) or "(no output)"


async def connect_mcp_servers(
    mcp_servers: dict[str, MCPServerConfig],
    registry: ToolRegistry,
    on_ended: Callable[[str], None] | None = None,
    *,
    errlogs: Mapping[str, TextIO] | None = None,
    failures: dict[str, str] | None = None,
) -> dict[str, MCPConnection]:
    """Connect to configured MCP servers and register their tools, resources, prompts.

    `on_ended` is called with a server's name when its session ends by itself: its transport ended (its
    process exited or its connection dropped), or a call found the session gone. It is not called for a
    connection this module closes.

    `errlogs` gives a stdio server, by name, the file its standard error goes to (the engine's own
    otherwise). `failures` receives, by name, one line of why each server that did not connect did not.
    A connection's `instructions` are what its server said at initialize.

    Returns one connection handle per server.  Each handle keeps the task that
    entered the MCP SDK contexts alive so shutdown can close AnyIO cancel
    scopes from their owning task.
    """
    from mcp import ClientSession, StdioServerParameters, types
    from mcp.client.sse import sse_client
    from mcp.client.stdio import stdio_client
    from mcp.client.streamable_http import streamable_http_client

    def failed(name: str, reason: str) -> None:
        if failures is not None:
            failures[name] = reason

    served_instructions: dict[str, str] = {}

    async def open_single_server(
        name: str, cfg: MCPServerConfig, server_stack: AsyncExitStack
    ) -> bool:
        try:
            transport_type = cfg.type
            if not transport_type:
                if cfg.command:
                    transport_type = "stdio"
                elif cfg.url:
                    transport_type = (
                        "sse" if cfg.url.rstrip("/").endswith("/sse") else "streamableHttp"
                    )
                else:
                    logger.warning("MCP server '{}': no command or url configured, skipping", name)
                    failed(name, "it has no command or url")
                    return False

            if transport_type == "stdio":
                params = StdioServerParameters(
                    command=cfg.command,
                    args=cfg.args,
                    env=cfg.env or None,
                    cwd=cfg.cwd or None,
                )
                errlog = (errlogs or {}).get(name, sys.stderr)
                read, write = await server_stack.enter_async_context(stdio_client(params, errlog=errlog))
            elif transport_type == "sse":
                if not await _probe_http_url(cfg.url):
                    logger.warning("MCP server '{}': {} unreachable, skipping", name, _redact_url(cfg.url))
                    failed(name, f"{_redact_url(cfg.url)} is unreachable")
                    return False

                def httpx_client_factory(
                    headers: dict[str, str] | None = None,
                    timeout: httpx.Timeout | None = None,
                    auth: httpx.Auth | None = None,
                ) -> httpx.AsyncClient:
                    merged_headers = {
                        "Accept": "application/json, text/event-stream",
                        **(cfg.headers or {}),
                        **(headers or {}),
                    }
                    return httpx.AsyncClient(
                        headers=merged_headers or None,
                        follow_redirects=True,
                        timeout=timeout,
                        auth=auth,
                    )

                read, write = await server_stack.enter_async_context(
                    sse_client(cfg.url, httpx_client_factory=httpx_client_factory)
                )
            elif transport_type == "streamableHttp":
                if not await _probe_http_url(cfg.url):
                    logger.warning("MCP server '{}': {} unreachable, skipping", name, _redact_url(cfg.url))
                    failed(name, f"{_redact_url(cfg.url)} is unreachable")
                    return False

                http_client = await server_stack.enter_async_context(
                    httpx.AsyncClient(
                        headers=cfg.headers or None,
                        follow_redirects=True,
                        timeout=httpx.Timeout(30.0, connect=10.0),
                    )
                )
                read, write, _ = await server_stack.enter_async_context(
                    streamable_http_client(cfg.url, http_client=http_client)
                )
            else:
                logger.warning("MCP server '{}': unknown transport type '{}'", name, transport_type)
                failed(name, f"unknown transport type {transport_type}")
                return False

            read = _filter_malformed_mcp_progress_notifications(
                read, name, (lambda: on_ended(name)) if on_ended is not None else None
            )
            session = await server_stack.enter_async_context(ClientSession(read, write))
            started = await session.initialize()
            served_instructions[name] = (getattr(started, "instructions", None) or "").strip()

            # Finish discovery before registering tools so a failed page leaves no partial set.
            page = await session.list_tools()
            tool_defs = list(page.tools)
            seen_cursors: set[str] = set()
            while page.nextCursor is not None:
                cursor = page.nextCursor
                if cursor in seen_cursors:
                    raise ValueError("MCP tools/list returned a repeated pagination cursor")
                seen_cursors.add(cursor)
                page = await session.list_tools(params=types.PaginatedRequestParams(cursor=cursor))
                tool_defs.extend(page.tools)

            registered_count = 0
            for tool_def in tool_defs:
                wrapper = MCPToolWrapper(
                    session, name, tool_def, tool_timeout=cfg.tool_timeout, images=cfg.images,
                    on_ended=on_ended,
                )
                registry.register(wrapper)
                logger.debug("MCP: registered tool '{}' from server '{}'", wrapper.name, name)
                registered_count += 1

            try:
                resources_result = await session.list_resources()
                for resource in resources_result.resources:
                    wrapper = MCPResourceWrapper(
                        session, name, resource, resource_timeout=cfg.tool_timeout, on_ended=on_ended
                    )
                    registry.register(wrapper)
                    registered_count += 1
                    logger.debug(
                        "MCP: registered resource '{}' from server '{}'",
                        wrapper.name,
                        name,
                    )
            except Exception as e:
                logger.debug(
                    "MCP server '{}': resources not supported or failed: {}", name, e
                )

            try:
                prompts_result = await session.list_prompts()
                for prompt in prompts_result.prompts:
                    wrapper = MCPPromptWrapper(
                        session, name, prompt, prompt_timeout=cfg.tool_timeout, on_ended=on_ended
                    )
                    registry.register(wrapper)
                    registered_count += 1
                    logger.debug(
                        "MCP: registered prompt '{}' from server '{}'",
                        wrapper.name,
                        name,
                    )
            except Exception as e:
                logger.debug(
                    "MCP server '{}': prompts not supported or failed: {}", name, e
                )

            logger.info(
                "MCP server '{}': connected, {} capabilities registered", name, registered_count
            )
            return True

        except Exception as e:
            hint = ""
            text = str(e).lower()
            if any(
                marker in text
                for marker in (
                    "parse error",
                    "invalid json",
                    "unexpected token",
                    "jsonrpc",
                    "content-length",
                )
            ):
                hint = (
                    " Hint: this looks like stdio protocol pollution. Make sure the MCP server writes "
                    "only JSON-RPC to stdout and sends logs/debug output to stderr instead."
                )
            _log_mcp_connection_failure(name, e, hint)
            failed(name, _failure_text(e) + hint)
            return False

    async def connect_single_server(
        name: str, cfg: MCPServerConfig
    ) -> tuple[str, MCPConnection | None]:
        loop = asyncio.get_running_loop()
        ready: asyncio.Future[bool] = loop.create_future()
        close_requested = asyncio.Event()

        async def own_connection() -> None:
            try:
                async with AsyncExitStack() as stack:
                    connected = await open_single_server(name, cfg, stack)
                    if not ready.done():
                        ready.set_result(connected)
                    if connected:
                        await close_requested.wait()
            except BaseException as exc:
                if not ready.done():
                    ready.set_exception(exc)
                raise

        owner = asyncio.create_task(own_connection(), name=f"mcp:{name}")
        connection = _OwnedMCPConnection(owner, close_requested)
        try:
            connected = await ready
        except BaseException as exc:
            close_requested.set()
            owner.cancel()
            with suppress(BaseException):
                await asyncio.shield(owner)
            if isinstance(exc, asyncio.CancelledError) and not task_is_cancelling():
                logger.warning("MCP server '{}': connection cancelled by server/SDK", name)
                failed(name, "the connection was cancelled by the server")
                return name, None
            raise
        if not connected:
            await connection.aclose()
            return name, None
        connection.instructions = served_instructions.get(name, "")
        return name, connection

    server_stacks: dict[str, MCPConnection] = {}
    attempted_names: list[str] = []

    try:
        for name, cfg in mcp_servers.items():
            attempted_names.append(name)
            try:
                result = await connect_single_server(name, cfg)
            except Exception as e:
                _log_mcp_connection_failure(name, e)
                failed(name, _failure_text(e))
                continue
            if result[1] is not None:
                server_stacks[result[0]] = result[1]
    except BaseException:
        # Callers can bound readiness/reload with a timeout. If cancellation
        # interrupts a later server, ownership of earlier connections has not
        # transferred yet, so roll the whole batch back before propagating it.
        for name in attempted_names:
            _unregister_server_tools(registry, name)
        try:
            await _close_mcp_connections(server_stacks)
        except BaseException as cleanup_exc:
            logger.debug("MCP batch rollback cleanup error (can be ignored): {}", cleanup_exc)
        raise

    return server_stacks


class MCPProvider:
    """Own configured MCP connections and their dynamic tool registrations."""

    def __init__(
        self,
        servers: Mapping[str, MCPServerConfig],
        registry: ToolRegistry,
        on_terminated: _EndedCallback,
        errlogs: Mapping[str, TextIO] | None = None,
    ) -> None:
        """Own `servers`, registering their tools on `registry`.

        A server whose session ended (its process exited, its connection dropped) is not
        reconnected: a restarted server has lost its state. `on_terminated` is called with
        the server's name, both when a call finds out (the call fails with its error and is
        not repeated) and when the transport ends with no call in flight, so an idle
        server's end is reported at once.

        `errlogs` gives a stdio server, by name, the file its standard error goes to.
        """
        self._servers = dict(servers)
        self._registry = registry
        self._on_terminated = on_terminated
        self._errlogs = dict(errlogs or {})
        self._connections: dict[str, MCPConnection] = {}
        self._failures: dict[str, str] = {}
        self._lock = asyncio.Lock()
        self._closing = False

    async def connect(self) -> list[str]:
        """Connect configured servers that are not currently live.

        Returns the configured servers that are not connected when it returns, in
        configuration order: empty when every server is live. Why one failed is
        `failure(name)`.
        """
        async with self._lock:
            await self._connect_missing()
            return [name for name in self._servers if name not in self._connections]

    def instructions(self, name: str) -> str:
        """What a connected server said at initialize for the model; empty when it said nothing or is not connected."""
        return str(getattr(self._connections.get(name), "instructions", ""))

    def failure(self, name: str) -> str | None:
        """One line of why the last attempt to connect a server failed; None when it is connected or was not tried."""
        return None if name in self._connections else self._failures.get(name)

    async def _connect_missing(self) -> None:
        if self._closing:
            return
        missing_servers = {
            name: cfg
            for name, cfg in self._servers.items()
            if name not in self._connections
        }
        if not missing_servers:
            return
        try:
            connected = await connect_mcp_servers(
                missing_servers,
                self._registry,
                self._transport_ended,
                errlogs=self._errlogs,
                failures=self._failures,
            )
            if self._closing:
                await _close_mcp_connections(connected)
                return
            self._connections.update(connected)
            if connected:
                logger.info("MCP connected servers: {}", sorted(connected))
            else:
                logger.warning(
                    "No MCP servers connected successfully "
                    "(will retry on the next readiness check)"
                )
        except asyncio.CancelledError:
            if task_is_cancelling():
                raise
            logger.warning(
                "MCP connection cancelled (will retry on the next readiness check)"
            )
        except BaseException as exc:
            logger.warning(
                "Failed to connect MCP servers "
                "(will retry on the next readiness check): {}",
                exc,
            )

    def _transport_ended(self, server_name: str) -> None:
        """A live server's session ended by itself: tell the caller."""
        if not self._closing and server_name in self._connections:
            self._on_terminated(server_name)

    async def aclose(self) -> None:
        """Close every connection while excluding a concurrent connect."""
        self._closing = True
        async with self._lock:
            connections = dict(self._connections)
            self._connections.clear()
            for name in self._servers:
                _unregister_server_tools(self._registry, name)
            await _close_mcp_connections(connections)


def _tool_prefix(server_name: str) -> str:
    return _sanitize_name(f"mcp_{server_name}_")


def _tool_belongs_to_server(tool: Tool | None, tool_name: str, server_name: str) -> bool:
    if isinstance(tool, _MCPWrapperBase):
        return getattr(tool, "_server_name", None) == server_name
    return tool_name.startswith(_tool_prefix(server_name))


def _unregister_server_tools(registry: ToolRegistry, server_name: str) -> int:
    removed = 0
    for tool_name in list(registry.tool_names):
        tool = registry.get(tool_name)
        if _tool_belongs_to_server(tool, tool_name, server_name):
            registry.unregister(tool_name)
            removed += 1
    return removed
