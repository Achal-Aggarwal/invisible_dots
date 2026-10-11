import { ClockIcon, FileTextIcon, FilePenIcon, FingerprintIcon, GlobeIcon, MonitorIcon, TerminalIcon, WrenchIcon, type LucideIcon } from "lucide-react";
import type { ToolFamily } from "@invisible-dots/shared/browser";

/** One icon per family of the Dot's tools: the chat's steps and the approval cards draw the same one for the same kind of call. */
export const FAMILY_ICON: Record<ToolFamily, LucideIcon> = {
  command: TerminalIcon,
  read: FileTextIcon,
  write: FilePenIcon,
  automation: ClockIcon,
  screen: MonitorIcon,
  "browser-identity": FingerprintIcon,
  browser: GlobeIcon,
  other: WrenchIcon,
};
