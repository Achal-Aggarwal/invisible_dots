import { describe, expect, it } from "vitest";
import { AGENT_STATES, computerIsUp, DOT_STATES, isAgentState, isTaskState, TASK_STATES, VM_STATES } from "../src/index.js";

describe("state lists", () => {
  it("match sections 8.1 and 9.3", () => {
    expect(AGENT_STATES).toEqual(["IDLE", "THINKING", "PLANNING", "EXECUTING", "WAITING_APPROVAL", "DONE"]);
    expect(VM_STATES).toEqual(["PROVISIONING", "STARTING", "RUNNING", "STOPPING", "STOPPED", "ERROR", "DELETING"]);
    expect(DOT_STATES).toEqual(["CREATING", "READY", "IDLE", "RUNNING", "WAITING_APPROVAL", "ERROR"]);
    expect(TASK_STATES).toEqual(["PENDING", "RUNNING", "WAITING_APPROVAL", "COMPLETED", "FAILED", "CANCELLED"]);
    expect(isAgentState("THINKING")).toBe(true);
    expect(isAgentState("thinking")).toBe(false);
    expect(isTaskState("PENDING")).toBe(true);
  });
});

describe("computerIsUp", () => {
  it("says the guest answers in RUNNING and in no other state, as the host's guest routes do", () => {
    expect(VM_STATES.filter((state) => computerIsUp(state))).toEqual(["RUNNING"]);
    expect(computerIsUp(null)).toBe(false);
    expect(computerIsUp(undefined)).toBe(false);
    expect(computerIsUp("running")).toBe(false);
  });
});
