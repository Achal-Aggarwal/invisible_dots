"use client";

import { useState, type FocusEvent, type KeyboardEvent } from "react";
import { askTitle, isDestructive, type ApprovalAsk } from "../../lib/approval-view";
import type { Answers } from "../approvals/use-answers";

/** Whether a key press is meant for a field (or a menu, a dialog) and not for the list. */
function forTheFocus(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return true;
  return target.closest("[role=dialog], [role=menu], [role=listbox]") !== null;
}

/** The element of an approval's card (found by comparing the attribute: an id needs no escaping that way). */
function cardOf(id: string): Element | null {
  return Array.from(document.querySelectorAll("[data-approval-id]")).find((card) => card.getAttribute("data-approval-id") === id) ?? null;
}

export interface InboxKeys {
  /** The card the keys act on: the first until the person moves. */
  selectedId: string | null;
  /** What to say to a person who cannot see the selection move or the card take the focus: which card is selected now, and that a destructive "allow" waits for a confirmation. */
  announcement: string;
  /** For the list of the cards: the keys act only while the focus is in it, and a card the focus enters is selected. */
  listProps: { onKeyDown: (event: KeyboardEvent<HTMLElement>) => void; onFocus: (event: FocusEvent<HTMLElement>) => void };
}

/**
 * The Inbox from the keyboard: `j` and `k` move between the cards, `a` allows the one selected once and `d` denies it.
 * The keys are the list's, not the page's: they act only while the focus is in the list of the cards (WCAG 2.1.4), so
 * a "d" typed with the focus anywhere else denies nothing. A card the focus enters (a click on it, Tab to one of its
 * buttons) is the one selected. A card that is destructive (a command, a deleted identity, a file outside the
 * workspace) is not allowed by a key press alone: `a` moves the focus to its "Allow once" button, and the press of
 * that button is the confirmation. A key meant for a field, a menu or a dialog is left to it. A move says which card
 * is selected now ("fares: Wants to run a command. 2 of 3."), since the selection is drawn and not focused: a screen
 * reader would otherwise not hear it.
 */
export function useInboxKeys(asks: readonly ApprovalAsk[], answers: Answers, nameOf: (dotId: string) => string): InboxKeys {
  const [selected, setSelected] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const selectedId = asks.some((ask) => ask.id === selected) ? selected : (asks[0]?.id ?? null);

  const onFocus = (event: FocusEvent<HTMLElement>) => {
    const id = (event.target as Element).closest("[data-approval-id]")?.getAttribute("data-approval-id");
    if (id && asks.some((ask) => ask.id === id)) setSelected(id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (!["j", "k", "a", "d"].includes(event.key) || forTheFocus(event.target) || document.querySelector("[role=dialog]") !== null) return;
    const index = asks.findIndex((ask) => ask.id === selectedId);
    if (index < 0) return;
    const ask = asks[index]!;
    setAnnouncement("");
    if (event.key === "j" || event.key === "k") {
      event.preventDefault();
      const at = Math.min(asks.length - 1, Math.max(0, index + (event.key === "j" ? 1 : -1)));
      const next = asks[at]!;
      setSelected(next.id);
      setAnnouncement(`${nameOf(next.dotId)}: ${askTitle(next)}. ${at + 1} of ${asks.length}.`);
      cardOf(next.id)?.scrollIntoView?.({ block: "nearest" });
      return;
    }
    if (answers.settled.has(ask.id) || answers.sending.has(ask.id)) return;
    event.preventDefault();
    if (event.key === "d") void answers.answer(ask, "reject");
    else if (!isDestructive(ask)) void answers.answer(ask, "approve");
    else {
      cardOf(ask.id)?.querySelector<HTMLElement>("[data-action=allow]")?.focus();
      setAnnouncement("This can do real harm. Press Enter on Allow once to confirm.");
    }
  };

  return { selectedId, announcement, listProps: { onKeyDown, onFocus } };
}
