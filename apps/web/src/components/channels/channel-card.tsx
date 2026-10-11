import { accountLabel, type ChannelKind, type ChannelRecord } from "@invisible-dots/shared/browser";
import { MessageCircleIcon, SendIcon } from "lucide-react";
import type { ReactNode } from "react";
import { accountHref, CHANNEL_LABELS } from "../../lib/channels";
import { ChannelStateChip } from "./state-chip";

const ICONS = { telegram: SendIcon, whatsapp: MessageCircleIcon } as const satisfies Record<ChannelKind, unknown>;

/** One channel of the Dot: its name, how it stands, the account it is on, and whatever the channel's own parts put in `children`. */
export function ChannelCard({ kind, record, children }: { kind: ChannelKind; record: ChannelRecord | undefined; children: ReactNode }) {
  const Icon = ICONS[kind];
  const name = CHANNEL_LABELS[kind];
  const account = record ? accountLabel(kind, record.account) : null;
  const href = record ? accountHref(kind, record.account) : null;
  return (
    <section aria-labelledby={`channel-${kind}`} className="space-y-5 rounded-lg border bg-card p-5 text-card-foreground">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Icon aria-hidden="true" className="size-5 text-muted-foreground" />
        <h2 id={`channel-${kind}`} className="text-base font-semibold">
          {name}
        </h2>
        {record ? <ChannelStateChip record={record} /> : <span className="text-xs text-muted-foreground">Not connected</span>}
        {account ? (
          href ? (
            <a href={href} target="_blank" rel="noreferrer" className="min-w-0 text-sm break-all text-muted-foreground underline-offset-4 hover:underline">
              {account}
            </a>
          ) : (
            <span className="min-w-0 text-sm break-all text-muted-foreground">{account}</span>
          )
        ) : null}
      </header>
      {children}
    </section>
  );
}
