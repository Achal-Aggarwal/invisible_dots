"use client";

import { useCallback, useEffect, useRef } from "react";
import { api } from "../../lib/api";
import { isReady, preflightItems, type HealthResult, type HostResult, type PreflightItem } from "../../lib/preflight";
import { useResource } from "../ui";
import { useHealth } from "../shell/attention";

export interface HostChecks {
  /** Null until both answers are in (or have failed). */
  items: PreflightItem[] | null;
  loading: boolean;
  /** Ask both again. */
  reload: () => void;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What the host needs for a Dot to run, as the list every setup surface draws: the control plane's own answer (the
 * shell's, so a saved key shows at once) and the host report of `GET /api/doctor` (QEMU, the accelerator, disk, the
 * images), which runs the accelerator probe and is the slower of the two.
 *
 * The fixes are commands the person runs in a terminal, so when they come back to this window, and something is
 * still not ready, the checks run again by themselves.
 */
export function useHostChecks(): HostChecks {
  const health = useHealth();
  const doctor = useResource(() => api.doctor(), "host:doctor");

  const healthResult: HealthResult | null = health.error !== null ? { error: reason(health.error) } : health.data ? { health: health.data } : null;
  const hostResult: HostResult | null = doctor.error !== null ? { error: reason(doctor.error) } : doctor.data ? { checks: doctor.data.checks } : null;
  const items = healthResult && hostResult ? preflightItems({ health: healthResult, host: hostResult }) : null;
  const loading = health.loading || doctor.loading;

  const reloadHealth = health.reload;
  const reloadDoctor = doctor.reload;
  const reload = useCallback(() => {
    reloadHealth();
    reloadDoctor();
  }, [reloadHealth, reloadDoctor]);

  const latest = useRef({ items, loading, reload });
  useEffect(() => {
    latest.current = { items, loading, reload };
  });
  useEffect(() => {
    const onReturn = () => {
      const now = latest.current;
      if (document.visibilityState === "visible" && now.items !== null && !isReady(now.items) && !now.loading) now.reload();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, []);

  return { items, loading, reload };
}
