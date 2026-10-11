// Derived from nanobot webui/src/components/settings/channels/ChannelQrConnectFlow.tsx at 9dc0aba, MIT; changed: the flow reads the host's stream of frames instead of polling a session (its states are the pure reducer in lib/channel-link.ts), the code is drawn as an SVG from the QR modules instead of a canvas data URL, there is no i18n and no client provider, and cancelling removes the channel the start created, or only pauses one that holds people.
"use client";

import { accountLabel, type ChannelRecord } from "@invisible-dots/shared/browser";
import { CheckIcon, Loader2Icon, RotateCcwIcon, SmartphoneIcon } from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { IDLE, linkEnded, reduceLink, STREAM_LOST, type LinkView } from "../../lib/channel-link";
import { ErrorAlert } from "../ErrorAlert";
import { useAction } from "../ui";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

/** Blank modules around the code that scanners need, in modules. */
const QUIET_ZONE = 2;
const DARK = "#111827";
const LIGHT = "#ffffff";

/** The path of a code's dark modules, one unit square each, inside a square of `size` units. */
function modulesPath(text: string): { path: string; size: number } | null {
  try {
    const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
    let path = "";
    for (let row = 0; row < modules.size; row++) {
      for (let col = 0; col < modules.size; col++) {
        if (modules.get(row, col)) path += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
      }
    }
    return { path, size: modules.size + 2 * QUIET_ZONE };
  } catch {
    // Longer than a code can hold.
    return null;
  }
}

/**
 * A QR code of `text`, drawn here from its modules (no image is fetched and the text goes nowhere), always dark on
 * light so that a scanner reads it in the dark theme too. `label` is what a screen reader hears.
 */
export function QrCode({ text, label, className }: { text: string; label: string; className?: string }) {
  const drawn = useMemo(() => modulesPath(text), [text]);
  if (drawn === null) return <p className="text-sm text-danger">The code could not be drawn.</p>;
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${drawn.size} ${drawn.size}`} shapeRendering="crispEdges" className={className ?? "size-48 rounded-md border"}>
      <rect width={drawn.size} height={drawn.size} fill={LIGHT} />
      <path d={drawn.path} fill={DARK} />
    </svg>
  );
}

function Step({ children }: { children: string }) {
  return <li>{children}</li>;
}

/**
 * Links WhatsApp: asks the host to start, shows each code it makes (they are replaced every few seconds) for the phone
 * to scan, and says how it ended. The host's stream is followed from here; when the page opens while a link is
 * already going on, it follows that one. A link that failed or needs doing again starts over with "Link again".
 */
export function QrConnect({ dotId, record, onChanged }: { dotId: string; record: ChannelRecord | undefined; onChanged: () => void }) {
  const [view, dispatch] = useReducer(reduceLink, IDLE);
  const watcher = useRef<AbortController | null>(null);
  const start = useAction();
  const cancel = useAction();

  const watch = useCallback(async () => {
    watcher.current?.abort();
    const controller = new AbortController();
    watcher.current = controller;
    let ended = false;
    try {
      for await (const frame of api.whatsappLink(dotId, { signal: controller.signal })) {
        if (controller.signal.aborted) return;
        ended = frame.state === "linked" || frame.state === "failed";
        dispatch({ type: "frame", frame });
        if (frame.state === "linked") toast.success(`WhatsApp is linked${frame.account ? ` as ${accountLabel("whatsapp", frame.account)}` : ""}.`);
      }
      if (!controller.signal.aborted && !ended) dispatch({ type: "error", message: STREAM_LOST });
    } catch (error) {
      if (!controller.signal.aborted) dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      // The record is what is true now: linked, or not.
      if (!controller.signal.aborted) onChanged();
    }
  }, [dotId, onChanged]);

  // Opened while a link is going on (a reload, another tab started it): follow it.
  const resume = record?.enabled === true && record.status === "connecting";
  useEffect(() => {
    if (resume) {
      dispatch({ type: "start" });
      void watch();
    }
    return () => watcher.current?.abort();
    // Only the page opening decides this: a later change of the record is what the stream itself reports.
  }, []);

  async function begin() {
    dispatch({ type: "start" });
    const ok = await start.run(() => api.linkWhatsApp(dotId));
    if (!ok) {
      dispatch({ type: "reset" });
      return;
    }
    void watch();
  }

  // What a link attempt must not take with it: a number linked before (Link again) and the people paired to it.
  const holdsSomething = record !== undefined && (record.account !== null || record.peers.length > 0);

  async function giveUp() {
    watcher.current?.abort();
    // The channel this page's own start made is removed; one that holds people is only stopped (paused), never deleted without asking.
    const ok = await cancel.run(() => (holdsSomething ? api.patchChannel(dotId, "whatsapp", { enabled: false }) : api.removeChannel(dotId, "whatsapp")));
    if (ok) dispatch({ type: "reset" });
    onChanged();
  }

  // A channel the host says needs linking again, shown before anything was started on this page.
  const shown: LinkView = view.phase === "idle" && record !== undefined && record.status === "needs_relink" ? { phase: "failed", detail: record.status_detail ?? "WhatsApp needs to be linked again." } : view;
  const busy = shown.phase === "starting" || shown.phase === "waiting" || shown.phase === "scan";

  return (
    <div className="space-y-4">
      {shown.phase === "starting" || shown.phase === "waiting" ? (
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2Icon aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
          Starting WhatsApp. The code to scan appears here in a moment.
          {shown.phase === "waiting" && shown.detail ? <span className="sr-only">{shown.detail}</span> : null}
        </div>
      ) : null}

      {shown.phase === "scan" ? (
        <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)]">
          <QrCode text={shown.code} label="QR code to link WhatsApp" />
          <div className="space-y-2">
            <p className="text-sm font-medium">Scan this code with the phone that has the number</p>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <Step>Open WhatsApp on that phone.</Step>
              <Step>Go to Settings, then Linked devices, then Link a device.</Step>
              <Step>Point the phone at this code.</Step>
            </ol>
            <p role="status" className="text-xs text-muted-foreground">
              The code is renewed every few seconds. Waiting for the scan...
            </p>
          </div>
        </div>
      ) : null}

      {shown.phase === "linked" ? (
        <p role="status" className="flex items-center gap-2 text-sm font-medium text-ok">
          <CheckIcon aria-hidden="true" className="size-4" />
          WhatsApp is linked{shown.account ? ` as ${accountLabel("whatsapp", shown.account)}` : ""}.
        </p>
      ) : null}

      {shown.phase === "failed" ? (
        <Alert variant="destructive">
          <SmartphoneIcon />
          <AlertTitle>WhatsApp is not linked</AlertTitle>
          <AlertDescription>
            <p>{shown.detail}</p>
          </AlertDescription>
        </Alert>
      ) : null}

      <ErrorAlert error={start.error} title="Could not start linking" />
      <ErrorAlert error={cancel.error} title="Could not cancel" />

      <div className="flex flex-wrap gap-2">
        {busy ? (
          <Button type="button" variant="outline" size="sm" disabled={cancel.pending || shown.phase === "starting"} onClick={() => void giveUp()}>
            Cancel
          </Button>
        ) : null}
        {!busy && !linkEnded(shown) ? (
          <Button type="button" size="sm" disabled={start.pending} onClick={() => void begin()}>
            <SmartphoneIcon />
            Link WhatsApp
          </Button>
        ) : null}
        {shown.phase === "failed" ? (
          <Button type="button" size="sm" disabled={start.pending} onClick={() => void begin()}>
            <RotateCcwIcon />
            Link again
          </Button>
        ) : null}
      </div>
    </div>
  );
}
