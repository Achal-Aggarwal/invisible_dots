import { describe, expect, it } from "vitest";
import { composerState, messageNote, QUEUED_NOTE, SUGGESTIONS } from "../src/lib/chat-view";

describe("what the composer says", () => {
  it("lets the person write to a Dot whose computer is up, and says nothing", () => {
    expect(composerState({ status: "READY", computer_state: "RUNNING" })).toEqual({ blocked: null, hint: null });
    expect(composerState(undefined)).toEqual({ blocked: null, hint: null });
  });

  it("stops the person only for a Dot that is being deleted, and says why", () => {
    expect(composerState({ status: "READY", computer_state: "DELETING" }).blocked).toMatch(/being deleted/);
    // Being deleted wins over any other state.
    expect(composerState({ status: "ERROR", computer_state: "DELETING" }).blocked).toMatch(/being deleted/);
    expect(composerState({ status: "ERROR", computer_state: "STOPPED" }).blocked).toBeNull();
  });

  it("explains the wait, without blocking, when the computer is not up", () => {
    for (const state of ["PROVISIONING", "STARTING", "STOPPED", "STOPPING"] as const) {
      const composer = composerState({ status: "READY", computer_state: state });
      expect(composer.blocked, state).toBeNull();
      expect(composer.hint, state).toMatch(/message/i);
    }
    expect(composerState({ status: "CREATING", computer_state: null }).blocked).toBeNull();
  });
});

describe("the first messages offered", () => {
  it("are three, each a question the Dot can answer without a goal: a Dot has none", () => {
    expect(SUGGESTIONS).toHaveLength(3);
    expect(new Set(SUGGESTIONS).size).toBe(3);
    expect(SUGGESTIONS.join(" ")).not.toMatch(/goal/i);
  });
});

describe("the note under a message", () => {
  it("says it is sending only until the control plane answered, and queued for the ones that wait for the computer", () => {
    expect(messageNote(null, new Set())).toBe("Sending...");
    expect(messageNote(7, new Set())).toBeUndefined();
    expect(messageNote(7, new Set([7]))).toBe(QUEUED_NOTE);
    expect(messageNote(8, new Set([7]))).toBeUndefined();
  });
});
