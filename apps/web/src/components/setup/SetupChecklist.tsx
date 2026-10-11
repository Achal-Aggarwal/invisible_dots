"use client";

import { useState } from "react";
import { isReady, notReadyCount } from "../../lib/preflight";
import { useHealth } from "../shell/attention";
import { CheckAgainButton, CheckList } from "./CheckList";
import { KeyForm } from "./KeyForm";
import { Section } from "./Section";
import { useHostChecks } from "./use-host-checks";

/**
 * The first-run checklist of Home: what this computer still needs before a Dot can run, each item with the command
 * that fixes it, and the key field when no key is stored. A host that is ready shows nothing. One that was not
 * stays on the page after the person fixes it, turned green, so that the last thing they see is that it worked,
 * not the checklist vanishing.
 */
export function SetupChecklist() {
  const checks = useHostChecks();
  const health = useHealth();
  const [needed, setNeeded] = useState<{ key: boolean } | null>(null);
  const items = checks.items;
  const ready = items !== null && isReady(items);

  // Latched during the render that first sees something missing, not in an effect after it: the checklist and its key
  // field then reach the page in the same commit, and nothing can find the one without the other.
  if (items !== null && !ready && needed === null) setNeeded({ key: health.data?.openrouter_configured === false });

  if (items === null) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Checking this computer...
      </p>
    );
  }
  if (ready && needed === null) return null;

  const missing = notReadyCount(items);
  return (
    <div className="w-full max-w-xl text-left">
      <Section
        id="setup"
        title={ready ? "This computer is ready" : "Get this computer ready"}
        description={
          ready
            ? "Everything a Dot needs is in place."
            : `${missing} ${missing === 1 ? "thing needs" : "things need"} attention. Run each command in a terminal, then check again; this page also checks when you come back to it.`
        }
        busy={checks.loading}
        action={<CheckAgainButton onClick={checks.reload} loading={checks.loading} />}
      >
        <CheckList items={items} />
        {needed?.key ? <KeyForm /> : null}
      </Section>
    </div>
  );
}
