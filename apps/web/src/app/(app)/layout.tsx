import type { ReactNode } from "react";
import { EventStreamProvider } from "../../components/events";
import { AttentionProvider } from "../../components/shell/attention";
import { AppShell } from "../../components/shell/AppShell";

/**
 * Every page of the app: one live stream, what needs the person, and the frame with the rail. The page for an address
 * with nothing behind it lives outside this group, so it shows without them.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <EventStreamProvider>
      <AttentionProvider>
        <AppShell>{children}</AppShell>
      </AttentionProvider>
    </EventStreamProvider>
  );
}
