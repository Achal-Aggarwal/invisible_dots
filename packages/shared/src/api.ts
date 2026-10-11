/**
 * The wire format of the control-plane API (architecture section 9.6). The
 * database repositories return these shapes and the API serializes them as
 * they are, so a record looks the same in PostgreSQL, over HTTP and in the
 * clients. Timestamps are ISO 8601 strings in UTC.
 *
 * Browser-safe: type imports only. The SDK re-exports this module.
 */
import type { DotConfig } from "./config.js";
import type { ChannelKind, ChannelStatus, MessageOrigin, StoredEvent } from "./events.js";
import type { BrowserIdentity, FileEntry, SystemAnswer } from "./protocol.js";
import type { ApprovalStatus, DotState, StopReason, TaskState, VmState } from "./states.js";

export interface DotRecord {
  id: string;
  name: string;
  config: DotConfig;
  status: DotState;
  /** Why the Dot is in ERROR; null otherwise. */
  error: string | null;
  /**
   * The version of the saved config: it grows by one with every save of the config (a PATCH, an "always allow") and
   * with nothing else, so `expected_config_version` of a PATCH can tell a form that is out of date from one that is not.
   */
  config_version: number;
  created_at: string;
  updated_at: string;
}

/** A Dot as the list and detail routes return it: the record plus its computer state. */
export interface DotSummary extends DotRecord {
  computer_state: VmState | null;
}

export interface ComputerRecord {
  dot_id: string;
  /** The QEMU `-name` of the VM (see vmName in protocol.ts). */
  vm_name: string;
  /** The host's 127.0.0.1 port forwarded to dot-agentd, chosen at each start; null while no QEMU process runs. */
  guest_port: number | null;
  /** The QEMU process id; null while none runs. */
  pid: number | null;
  state: VmState;
  golden_image: string | null;
  runtime_image: string | null;
  event_cursor: number;
  last_active_at: string | null;
  /**
   * When the Dot's earliest enabled automation is next due, as its guest last reported it; null when none is due or
   * nothing was reported. A computer that is stopped is started shortly before this time (architecture section 9.5).
   */
  next_automation_at: string | null;
  /**
   * Why the computer is off (or going off): set while it is STOPPING or STOPPED, null otherwise. A computer the person
   * stopped (`user`) is not started for its automations until the person starts it again (architecture section 9.5).
   */
  stop_reason: StopReason | null;
  /** The last lifecycle failure (start, READY procedure, stop), null after a success. */
  last_error: string | null;
  updated_at: string;
}

/** `GET /api/dots/:id/computer`: the stored record plus what the control plane knows live. */
export interface ComputerAnswer extends ComputerRecord {
  /** Whether the READY procedure (section 9.3) completed since the computer last started. */
  ready: boolean;
  /** `GET /v1/system` of the guest while it is READY; null when stopped or when the guest did not answer. */
  system: SystemAnswer | null;
}

export interface TaskRecord {
  id: string;
  dot_id: string;
  description: string;
  priority: number;
  status: TaskState;
  created_at: string;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  summary: string | null;
  error: string | null;
  /** Model spend of the task in USD, as the guest last reported it (architecture section 5.4); 0 until it reports. */
  spent_usd: number;
}

export interface TaskRunRecord {
  id: string;
  task_id: string;
  started_at: string;
  delivered_at: string | null;
  finished_at: string | null;
  outcome: string | null;
}

export interface ApprovalRecord {
  id: string;
  dot_id: string;
  task_id: string | null;
  tool: string;
  permission: string;
  arguments: Record<string, unknown>;
  reason: string;
  status: ApprovalStatus;
  note: string | null;
  created_at: string;
  resolved_at: string | null;
}

/** One turn of the Dot's conversation, rebuilt from the event log. */
export interface ConversationMessage {
  event_id: number;
  role: "user" | "assistant";
  text: string;
  in_reply_to: string | null;
  /** The channel chat a user message came from; absent for the web, the CLI and the SDK, and for every assistant message. */
  origin?: MessageOrigin;
  created_at: string;
}

export interface CreateDotRequest {
  /** YAML text or an already-decoded object (section 7). */
  config: string | Record<string, unknown>;
}

export interface PatchDotRequest {
  config: string | Record<string, unknown>;
  /**
   * The `config_version` of the Dot as the caller read it. The save is then conditional: a Dot whose config changed
   * since is a 409 `dot_changed` and nothing is written. Absent, the save is unconditional.
   */
  expected_config_version?: number;
}

export interface CreateTaskRequest {
  description: string;
  /** Higher runs first; default 0. */
  priority?: number;
  /** ISO 8601; the task is not dispatched before this time. */
  scheduled_at?: string;
}

export interface MessageAnswer {
  /** The id of the `user.message` event the message was delivered as. */
  message_id: string;
  event_id: number;
  /** `queued` when the computer has to wake up first. */
  delivery: "delivered" | "queued";
}

export interface ApproveRequest {
  note?: string;
  /** Also set the approval's permission to `allow` in the Dot's config, so the Dot is not asked for it again. */
  always?: true;
}

export interface RejectRequest {
  note?: string;
}

export interface PutOpenRouterSecretRequest {
  value: string;
  dot_id?: string;
}

/** What a channel sends to the person without being asked (decisions of 2026-10-05: replies to the person's own messages always, the rest switchable). */
export interface ChannelSettings {
  /** Approvals are asked in the chat, with Approve and Reject buttons, for the paired owner. */
  approvals: boolean;
  /** What the Dot says on its own goes to the owner's chat: `task.completed` and `task.failed`, and an answer that answers no message (an automation's). */
  notify_tasks: boolean;
  /** An approval prompt in the chat shows the tool's arguments (cut to 300 characters). Off, it shows the tool and the reason only. */
  show_arguments: boolean;
}

export interface ChannelPeerRecord {
  /** The channel's own id for the person (a Telegram user id, a WhatsApp phone number). */
  peer_id: string;
  role: "owner" | "user";
  label: string;
  created_at: string;
}

/** A Dot's binding to one channel. Never carries a token or any other credential. */
export interface ChannelRecord {
  kind: ChannelKind;
  enabled: boolean;
  status: ChannelStatus;
  /** Why the status is `error`, or null. */
  status_detail: string | null;
  /** The channel's public name for the account: a Telegram bot's username, the phone number linked to WhatsApp. Null until the channel reports one. */
  account: string | null;
  settings: ChannelSettings;
  peers: ChannelPeerRecord[];
  created_at: string;
}

/** A channel and the Dot it belongs to, as `GET /api/channels` lists the channels of every Dot. */
export type DotChannelRecord = ChannelRecord & { dot_id: string };

export interface EveryChannelAnswer {
  channels: DotChannelRecord[];
}

export interface ChannelsAnswer {
  channels: ChannelRecord[];
  /** The kinds of channel this server can run: WhatsApp is on only when the server was started with it (opt-in). */
  available: ChannelKind[];
}

/**
 * One frame of `GET /api/dots/:id/channels/whatsapp/qr` while a person links WhatsApp: `waiting` until the first
 * code, `code` with what the phone scans (replaced every few seconds, never stored), then one last frame,
 * `linked` or `failed`, and the stream ends. `detail` says why a connection is retried; it never holds a credential.
 */
export type ChannelLinkFrame =
  | { state: "waiting"; detail?: string }
  | { state: "code"; code: string }
  | { state: "linked"; account: string | null }
  | { state: "failed"; detail: string };

export interface PutTelegramChannelRequest {
  /** The bot token from @BotFather; checked with Telegram, stored encrypted, never returned. */
  token: string;
}

export interface PatchChannelRequest {
  /** Only the settings named change. */
  settings?: Partial<ChannelSettings>;
  /** `false` pauses the channel (its people and its token stay), `true` starts it again. */
  enabled?: boolean;
}

/** A one-time code that pairs a person's chat to the Dot (valid for ten minutes, stored hashed). */
export interface ChannelPairingAnswer {
  code: string;
  /** `https://t.me/<bot>?start=<code>` for Telegram, `https://wa.me/<number>?text=pair%20<code>` for WhatsApp; null where the account is not known yet. */
  deep_link: string | null;
  /** The words that pair when sent to the channel's account: `/start <code>` on Telegram, `pair <code>` on WhatsApp. */
  message: string;
  expires_at: string;
}

/** Where this control plane keeps its state: what the web client's host settings page tells the person, who otherwise has to know `INVISIBLE_DOTS_HOME`. */
export interface HostFacts {
  /** The database behind it: PGlite inside the server, or an external PostgreSQL (`DATABASE_URL`). */
  database_kind: "pglite" | "pg";
  /** `INVISIBLE_DOTS_HOME`, as the server resolved it. */
  data_dir: string;
  /** Where QEMU's own output of every Dot is written (`logs/qemu-<dot_id>.log`). */
  logs_dir: string;
}

export interface HealthResponse extends HostFacts {
  status: "ok";
  database: "ok";
  version: string;
  /** Whether a global OpenRouter key is stored; `invisible-dots doctor` reports it (section 11.1). */
  openrouter_configured: boolean;
}

/**
 * One row of the host report (`GET /api/doctor` and `invisible-dots doctor`, architecture section 11.1):
 * - ok: present and working.
 * - missing: absent; `fix` installs or creates it.
 * - failed: present but not working, or the check itself could not tell.
 */
export type DoctorStatus = "ok" | "missing" | "failed";

export type DoctorCheckId =
  | "node"
  | "qemu"
  | "qemu-img"
  | "accelerator"
  | "accelerator-probe"
  | "disk"
  | "golden-image"
  | "runtime-image"
  | "web"
  | "openrouter";

export interface DoctorCheck {
  id: DoctorCheckId;
  label: string;
  status: DoctorStatus;
  detail: string;
  /** The command or action that fixes a check that is not ok. */
  fix?: string;
}

/** Every check in the contract's order; `ok` is true only when every check is ok. */
export interface DoctorAnswer {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DotsAnswer {
  dots: DotSummary[];
}

export interface TasksAnswer {
  tasks: TaskRecord[];
}

export interface ApprovalsAnswer {
  approvals: ApprovalRecord[];
}

export interface MessagesAnswer {
  messages: ConversationMessage[];
}

export interface EventsAnswer {
  events: StoredEvent[];
}

/**
 * `GET /api/dots/:id/files/list`: the directory as dot-agentd lists it, with the normalized absolute `path`
 * that was listed (what the caller asked for may have been relative or `~`).
 */
export interface FilesListAnswer {
  path: string;
  entries: FileEntry[];
}

/**
 * `GET /api/dots/:id/usage`: the model spend the Dot's guest reported since `since` (null: since
 * the first event), in USD. It sums `spent_usd` over the events that end a unit of spend: a task's
 * `task.completed` and `task.failed` (each carries the whole task) and the chat's `message.assistant`
 * (each carries its turn). Work that never reported an end (a cancelled task, a chat turn cut by a
 * restart) is not in it.
 */
export interface UsageAnswer {
  dot_id: string;
  since: string | null;
  spent_usd: number;
}

export interface IdentitiesAnswer {
  identities: BrowserIdentity[];
}

/** Lifecycle requests are accepted and run in the background; progress arrives as `computer.state` events. */
export interface AcceptedAnswer {
  accepted: true;
}
