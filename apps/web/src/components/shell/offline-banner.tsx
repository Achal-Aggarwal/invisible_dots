"use client";

import { WifiOffIcon } from "lucide-react";
import { offlineOf } from "../../lib/offline";
import { useStreamStatus } from "../events";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { useHealth } from "./attention";

/**
 * Says so, at the top of every page, when the control plane does not answer: the live stream is down or the health
 * check fails. It is an alert, so a screen reader hears it as it appears; it goes away by itself when the connection is back.
 */
export function OfflineBanner() {
  const stream = useStreamStatus();
  const health = useHealth();
  const offline = offlineOf({ stream: stream.status, streamDetail: stream.detail, apiError: health.error });
  if (offline === null) return null;
  return (
    <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
      <WifiOffIcon />
      <AlertTitle>{offline.title}</AlertTitle>
      <AlertDescription>
        <p>{offline.detail}</p>
      </AlertDescription>
    </Alert>
  );
}
