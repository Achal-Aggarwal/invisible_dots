/** What the chat says around the conversation: whether the person can write, what to tell them about the computer, and what to offer as a first message. */
import type { Dot } from "./types";

export interface ComposerState {
  /** Why the person cannot send; null when they can. */
  blocked: string | null;
  /** What is good to know before sending; null when nothing. */
  hint: string | null;
}

/**
 * A message is accepted whenever the Dot exists: the control plane stores it and delivers it once the computer is
 * up (`delivery: "queued"`), waking it if it sleeps. So the person is stopped only for a Dot that is being deleted,
 * and told in a sentence when the answer will take a while.
 */
export function composerState(dot: Pick<Dot, "status" | "computer_state"> | undefined): ComposerState {
  if (dot === undefined) return { blocked: null, hint: null };
  if (dot.computer_state === "DELETING") return { blocked: "This Dot is being deleted.", hint: null };
  switch (dot.computer_state) {
    case "PROVISIONING":
    case "STARTING":
      return { blocked: null, hint: "The computer is getting ready. Your message is delivered as soon as it is." };
    case "STOPPED":
      return { blocked: null, hint: "The computer is stopped. Sending a message wakes it, and the Dot answers once it is up." };
    case "STOPPING":
      return { blocked: null, hint: "The computer is shutting down. Your message is delivered when it is up again." };
    default:
      return { blocked: null, hint: null };
  }
}

/** Three first messages to offer in an empty chat. */
export const SUGGESTIONS: readonly string[] = ["What can you do on your computer?", "Open a browser and tell me what is on example.com.", "What do you need from me to get started?"];

/** The note under a message the computer had to wake up for: the Dot answers once it is up. */
export const QUEUED_NOTE = "Queued: the computer is waking up, and the Dot answers once it is.";

/**
 * The note under a message by the event it was stored as (null while the control plane has not answered), given the
 * ones still queued. "Sending..." is only true until the answer: after it the message was accepted, whether or not
 * the conversation list shows it yet (the host's list can be cut before it).
 */
export function messageNote(eventId: number | null, queued: ReadonlySet<number>): string | undefined {
  if (eventId === null) return "Sending...";
  return queued.has(eventId) ? QUEUED_NOTE : undefined;
}
