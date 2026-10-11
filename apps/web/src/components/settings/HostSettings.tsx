"use client";

import { aboutRows } from "../../lib/host-settings";
import { isReady, notReadyCount } from "../../lib/preflight";
import type { ThemePreference } from "../../lib/theme";
import { useThemePreference } from "../../lib/use-theme";
import { cn } from "../../lib/utils";
import { ErrorAlert } from "../ErrorAlert";
import { useHealth } from "../shell/attention";
import { CheckAgainButton, CheckList, CheckListSkeleton } from "../setup/CheckList";
import { KeyForm } from "../setup/KeyForm";
import { Section } from "../setup/Section";
import { useHostChecks } from "../setup/use-host-checks";
import { Skeleton } from "../ui/skeleton";

/**
 * The host settings (S13): whether this computer can run a Dot and what to run when it cannot, the OpenRouter key,
 * the look of the page, the session, and where the control plane keeps its state. Settings of one Dot live on that
 * Dot's page, not here.
 */
export function HostSettings() {
  return (
    <div className="max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">This computer and this browser. What a single Dot may do is set on its own page.</p>
      </div>
      <HostChecks />
      <Section id="key" title="OpenRouter key" description="Every Dot's model requests are paid with it. A new key is pushed to the running Dots at once.">
        <KeyForm />
      </Section>
      <Appearance />
      <About />
    </div>
  );
}

function HostChecks() {
  const checks = useHostChecks();
  const items = checks.items;
  const summary =
    items === null
      ? "Checking this computer..."
      : isReady(items)
        ? "Everything a Dot needs is in place."
        : `${notReadyCount(items)} ${notReadyCount(items) === 1 ? "thing needs" : "things need"} attention. Setup needs an elevated terminal and an image build takes a long time, so these stay commands: run the one shown, then check again. The page also checks when you come back to it.`;
  return (
    <Section id="checks" title="Host checks" description={summary} busy={checks.loading} action={<CheckAgainButton onClick={checks.reload} loading={checks.loading} />}>
      {items === null ? <CheckListSkeleton /> : <CheckList items={items} />}
    </Section>
  );
}

const THEMES: { value: ThemePreference; label: string; description: string }[] = [
  { value: "light", label: "Light", description: "Warm off-white." },
  { value: "dark", label: "Dark", description: "Near black." },
  { value: "system", label: "System", description: "Follows the device." },
];

function Appearance() {
  const [preference, setPreference] = useThemePreference();
  return (
    <Section id="appearance" title="Appearance" description="Kept in this browser only.">
      <fieldset className="grid gap-2 sm:grid-cols-3">
        <legend className="sr-only">Theme</legend>
        {THEMES.map((theme) => (
          <label
            key={theme.value}
            className={cn(
              "flex cursor-pointer flex-col gap-1 rounded-lg border bg-background p-3 text-sm transition-colors hover:bg-accent has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring has-[:focus-visible]:outline-hidden",
              preference === theme.value && "border-primary bg-accent",
            )}
          >
            <span className="flex items-center gap-2 font-medium">
              <input type="radio" name="theme" value={theme.value} checked={preference === theme.value} onChange={() => setPreference(theme.value)} className="accent-primary" />
              {theme.label}
            </span>
            <span className="text-xs text-muted-foreground">{theme.description}</span>
          </label>
        ))}
      </fieldset>
    </Section>
  );
}

function About() {
  const health = useHealth();
  return (
    <Section id="about" title="About" busy={health.loading && health.data === undefined}>
      {health.error !== null && health.data === undefined ? <ErrorAlert error={health.error} title="The control plane does not answer" /> : null}
      {health.data === undefined && health.error === null ? (
        <div className="space-y-2" aria-hidden="true">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-full" />
        </div>
      ) : null}
      {health.data ? (
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
          {aboutRows(health.data).map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className={cn("min-w-0 break-words", row.code && "font-mono text-xs leading-5")}>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </Section>
  );
}
