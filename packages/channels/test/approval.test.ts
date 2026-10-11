import { APPROVAL_PROMPT_TEXT_MAX, type ApprovalRecord } from "@invisible-dots/shared";
import { describe, expect, it } from "vitest";
import { approvalOutcomeText, approvalPromptText, approvalReplyHint, approvalReplyToken, parseApprovalReply } from "../src/approval-text.js";
import { CALLBACK_DATA_MAX_BYTES, encodeApprovalCallback, parseApprovalCallback } from "../src/telegram/callback.js";

const ID = "appr_11111111-2222-3333-4444-555555555555";

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: ID,
    dot_id: "dot_1",
    task_id: null,
    tool: "exec",
    permission: "computer.exec",
    arguments: { command: "ls -la" },
    reason: "the tool needs approval",
    status: "pending",
    note: null,
    created_at: "2026-10-06T10:00:00.000Z",
    resolved_at: null,
    ...overrides,
  };
}

describe("the data of an approval button", () => {
  it("carries the decision and the id, versioned, within the 64 bytes Telegram allows", () => {
    expect(encodeApprovalCallback("approve", ID)).toBe(`ap1:y:${ID}`);
    expect(encodeApprovalCallback("reject", ID)).toBe(`ap1:n:${ID}`);
    expect(Buffer.byteLength(encodeApprovalCallback("approve", ID))).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
  });

  it("parses what it made, in both directions", () => {
    expect(parseApprovalCallback(encodeApprovalCallback("approve", ID))).toEqual({ decision: "approve", approvalId: ID });
    expect(parseApprovalCallback(encodeApprovalCallback("reject", ID))).toEqual({ decision: "reject", approvalId: ID });
  });

  it("refuses to make data for an id that does not fit, whatever its length is made of", () => {
    const fits = "x".repeat(CALLBACK_DATA_MAX_BYTES - "ap1:y:".length);
    expect(() => encodeApprovalCallback("approve", fits)).not.toThrow();
    expect(() => encodeApprovalCallback("approve", `${fits}x`)).toThrow(/cannot be carried/);
    expect(() => encodeApprovalCallback("approve", "")).toThrow(/cannot be carried/);
    expect(() => encodeApprovalCallback("approve", "a:b")).toThrow(/cannot be carried/);
    expect(() => encodeApprovalCallback("approve", "a b")).toThrow(/cannot be carried/);
    // Two bytes per character: the check is on bytes, not on characters.
    expect(() => encodeApprovalCallback("approve", "é".repeat(30))).toThrow(/cannot be carried/);
  });

  it("parses nothing it did not make: another version, another shape, too long, empty", () => {
    for (const data of ["ap2:y:a", "ap1:y:", "ap1::a", "ap1:x:a", "ap1:y:a:b", "ap1:y:a b", "ap1:y:a\n", "AP1:y:a", " ap1:y:a", "y:a", "", `ap1:y:${"x".repeat(CALLBACK_DATA_MAX_BYTES)}`]) {
      expect(parseApprovalCallback(data), JSON.stringify(data)).toBeNull();
    }
    expect(parseApprovalCallback(undefined)).toBeNull();
  });
});

describe("what an approval prompt says", () => {
  it("says what the Dot wants to do and the permission with its risk, in the web client's words, then the reason and the arguments", () => {
    expect(approvalPromptText(approval(), true)).toBe(
      ["The Dot wants to run a command.", "Permission: Run commands (high risk)", "Reason: the tool needs approval", 'Arguments: {"command":"ls -la"}'].join("\n"),
    );
  });

  it("names a tool or a permission it has no words for as it is", () => {
    expect(approvalPromptText(approval({ tool: "rm_rf", permission: "exec.run", arguments: {}, reason: "" }), true)).toBe(["The Dot wants to call rm_rf.", "Permission: exec.run"].join("\n"));
  });

  it("cuts the arguments and the reason to the limit, and shows that they were cut", () => {
    const text = approvalPromptText(approval({ arguments: { command: "x".repeat(2000) }, reason: "r".repeat(2000) }), true);
    const [, , reason, args] = text.split("\n") as [string, string, string, string];
    expect(reason.slice("Reason: ".length)).toHaveLength(APPROVAL_PROMPT_TEXT_MAX);
    expect(args.slice("Arguments: ".length)).toHaveLength(APPROVAL_PROMPT_TEXT_MAX);
    expect(reason.endsWith("...")).toBe(true);
    expect(args.endsWith("...")).toBe(true);
    expect(text).not.toContain("x".repeat(APPROVAL_PROMPT_TEXT_MAX));
    expect(text.length).toBeLessThan(800);
  });

  it("keeps a prompt on one line per fact: line breaks and runs of spaces in the arguments collapse", () => {
    const text = approvalPromptText(approval({ arguments: { command: "a\n\n   b" }, reason: "line one\nline two" }), true);
    expect(text.split("\n")).toEqual(["The Dot wants to run a command.", "Permission: Run commands (high risk)", "Reason: line one line two", 'Arguments: {"command":"a\\n\\n b"}']);
  });

  it("leaves out what is empty", () => {
    expect(approvalPromptText(approval({ arguments: {}, reason: "" }), true)).toBe("The Dot wants to run a command.\nPermission: Run commands (high risk)");
  });

  it("leaves the arguments out, in the prompt and in the outcome, when the channel is set not to show them", () => {
    const text = approvalPromptText(approval(), false);
    expect(text).toBe(["The Dot wants to run a command.", "Permission: Run commands (high risk)", "Reason: the tool needs approval"].join("\n"));
    expect(text).not.toContain("ls -la");
    expect(approvalOutcomeText(approval({ status: "approved" }), false)).toBe(`${text}\n\nApproved.`);
  });

  it("says how an approval ended below the question it asked", () => {
    const question = approvalPromptText(approval(), true);
    expect(approvalOutcomeText(approval({ status: "approved" }), true)).toBe(`${question}\n\nApproved.`);
    expect(approvalOutcomeText(approval({ status: "rejected" }), true)).toBe(`${question}\n\nRejected.`);
    expect(approvalOutcomeText(approval({ status: "expired" }), true)).toBe(`${question}\n\nNo longer needed: the task ended before anyone answered.`);
  });
});

describe("the words that answer an approval on a channel without buttons", () => {
  const id = "apr_01k6h3w2ze8m4qv7r1xk9bntc5";

  it("teaches a token from the random end of the id, and reads exactly that back, in any case", () => {
    expect(approvalReplyToken(id)).toBe("ap-9bntc5");
    expect(approvalReplyHint(id)).toBe('Reply "yes ap-9bntc5" to approve or "no ap-9bntc5" to reject.');
    expect(parseApprovalReply("yes ap-9bntc5")).toEqual({ decision: "approve", shortId: "9bntc5" });
    expect(parseApprovalReply("  No AP-9BNTC5 \n")).toEqual({ decision: "reject", shortId: "9bntc5" });
    expect(parseApprovalReply("YES   ap-9bntc5")).toEqual({ decision: "approve", shortId: "9bntc5" });
  });

  it("takes nothing else for an answer: an ordinary message stays one", () => {
    for (const text of ["yes", "no", "yes 9bntc5", "yes please ap-9bntc5", "ap-9bntc5", "yes ap-9bntc5 thanks", "yes ap-9bntc", "yes ap-9bntc55", "maybe ap-9bntc5", "yes ap-9bn c5", "yes ap_9bntc5", ""]) {
      expect(parseApprovalReply(text), text).toBeNull();
    }
  });
});
