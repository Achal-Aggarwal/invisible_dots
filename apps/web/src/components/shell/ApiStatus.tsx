"use client";

import { ServerIcon } from "lucide-react";
import Link from "next/link";
import { cn } from "../../lib/utils";
import { useHealth } from "./attention";
import { StatusIcon } from "./StatusIcon";

type ApiState = "checking" | "ok" | "down";

function useApiState(): ApiState {
  const health = useHealth();
  return health.error !== null ? "down" : health.data ? "ok" : "checking";
}

/** Whether the control plane answers through the proxy, with its version (the shell asks every 30 seconds): an icon, said in full on hover. */
export function ApiStatus() {
  const health = useHealth();
  const state = useApiState();
  const label = state === "checking" ? "API: checking" : state === "ok" ? "API: ok" : "API: unreachable";
  const version = state === "ok" && health.data ? `v${health.data.version}` : null;
  const detail = state === "down" ? String(health.error instanceof Error ? health.error.message : health.error) : null;
  return (
    <StatusIcon icon={ServerIcon} dotClassName={cn(state === "ok" ? "bg-ok" : state === "down" ? "bg-danger" : "bg-muted-foreground")} tooltip={[label, version, detail].filter(Boolean).join(" · ")}>
      {label}
      {version ? <span> {version}</span> : null}
    </StatusIcon>
  );
}

/** While the control plane has no OpenRouter key: a link to where it is entered, on a line of its own under the statuses. */
export function MissingKeyNotice({ onNavigate }: { onNavigate?: () => void }) {
  const health = useHealth();
  const state = useApiState();
  if (state !== "ok" || !health.data || health.data.openrouter_configured) return null;
  return (
    <p className="text-xs text-warn">
      <Link href="/settings" onClick={onNavigate} className="underline underline-offset-2">
        No OpenRouter key stored yet
      </Link>
    </p>
  );
}
