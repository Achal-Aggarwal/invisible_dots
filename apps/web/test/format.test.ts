import { describe, expect, it } from "vitest";
import { allowedActions, automationsNote, computerView, confirmText } from "../src/lib/computer";
import { formatBytes, formatDuration, formatMillis, formatUsd, startOfToday, statusTone } from "../src/lib/format";
import type { DotConfig } from "../src/lib/types";

const GIB = 1024 ** 3;

describe("format helpers", () => {
  it("formats binary sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(4 * GIB)).toBe("4.0 GiB");
    expect(formatBytes(200 * GIB)).toBe("200 GiB");
    expect(formatBytes(undefined)).toBe("-");
  });

  it("formats durations", () => {
    expect(formatDuration(42)).toBe("42s");
    expect(formatDuration(125)).toBe("2m 5s");
    expect(formatDuration(3 * 3600 + 120)).toBe("3h 2m");
    expect(formatDuration(2 * 86_400 + 3600)).toBe("2d 1h");
  });

  it("maps states to tones", () => {
    expect(statusTone("READY")).toBe("ok");
    expect(statusTone("FAILED")).toBe("error");
    expect(statusTone("WAITING_APPROVAL")).toBe("warn");
    expect(statusTone("STOPPED")).toBe("neutral");
    expect(statusTone("whatever")).toBe("neutral");
  });
});

describe("computerView", () => {
  const config = { computer: { cpu: 2, memory: "4gb", disk: "40gb", idle_timeout: "15m" } } as DotConfig;

  it("shows allocated resources and live usage from an embedded system answer", () => {
    const view = computerView(
      {
        state: "RUNNING",
        system: {
          hostname: "dot",
          uptime_s: 90,
          cpus: 2,
          mem_total_bytes: 4 * GIB,
          mem_available_bytes: 3 * GIB,
          disk_total_bytes: 40 * GIB,
          disk_free_bytes: 30 * GIB,
        },
      },
      config,
    );
    expect(view.state).toBe("RUNNING");
    expect(view.allocated).toEqual({ cpus: 2, memory: "4gb", disk: "40gb", idleTimeout: "15m" });
    expect(view.live?.memory).toEqual({ usedBytes: GIB, totalBytes: 4 * GIB, fraction: 0.25 });
    expect(view.live?.disk.fraction).toBe(0.25);
  });

  it("has no live usage for a stopped computer", () => {
    const view = computerView({ state: "STOPPED" }, config);
    expect(view.live).toBeNull();
    expect(view.allocated.cpus).toBe(2);
  });

  it("enables only the power actions that fit the state", () => {
    expect(allowedActions("STOPPED")).toEqual({ start: true, stop: false, reboot: false });
    expect(allowedActions("RUNNING")).toEqual({ start: false, stop: true, reboot: true });
    expect(allowedActions("STARTING")).toEqual({ start: false, stop: false, reboot: false });
  });

  it("says in the stop confirmation that the automations do not run while the computer is stopped", () => {
    expect(confirmText("stop", false)).toMatch(/^Stop this Dot's computer\? Its automations do not run while it is stopped/);
    expect(confirmText("stop", true)).toMatch(/^A task is running\. Stop the computer anyway\? Its automations do not run while it is stopped/);
  });

  it("asks before a reboot only while a task runs, and says nothing of automations there", () => {
    expect(confirmText("reboot", false)).toBeNull();
    expect(confirmText("reboot", true)).toBe("A task is running. Reboot the computer anyway?");
  });
});

describe("automationsNote", () => {
  const now = Date.parse("2026-10-06T10:00:00Z");

  it("says the automations are paused when the person stopped the computer, whatever time is recorded", () => {
    const note = automationsNote({ state: "STOPPED", stop_reason: "user", next_automation_at: "2026-10-06T12:00:00Z" }, now);
    expect(note.paused).toBe(true);
    expect(note.text).toMatch(/^Paused: you stopped this computer, so its automations do not run/);
  });

  it("does not say paused for a Dot that has no automation due: there is nothing to pause", () => {
    expect(automationsNote({ state: "STOPPED", stop_reason: "user", next_automation_at: null }, now)).toEqual({ paused: false, text: "No automation is due." });
  });

  it("says when the next one is due, and that a computer asleep is started shortly before", () => {
    const running = automationsNote({ state: "RUNNING", stop_reason: null, next_automation_at: "2026-10-06T12:00:00Z" }, now, "en-US");
    expect(running.paused).toBe(false);
    expect(running.text).toMatch(/^Next automation: .*\(in 2h\)\.$/);
    const asleep = automationsNote({ state: "STOPPED", stop_reason: "idle", next_automation_at: "2026-10-06T12:00:00Z" }, now, "en-US");
    expect(asleep.text).toMatch(/\(in 2h\)\. The computer is asleep and starts shortly before then\.$/);
  });

  it("says none is due when the engine reported no time", () => {
    expect(automationsNote({ state: "RUNNING", stop_reason: null, next_automation_at: null }, now)).toEqual({ paused: false, text: "No automation is due." });
  });
});

describe("spend", () => {
  it("shows cents, a trace as under a cent, and nothing as zero", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(0.4249)).toBe("$0.42");
    expect(formatUsd(12)).toBe("$12.00");
    expect(formatUsd(-1)).toBe("-");
    expect(formatUsd(Number.NaN)).toBe("-");
    expect(formatUsd(undefined)).toBe("-");
  });

  it("takes today to start at the local midnight", () => {
    const noon = new Date(2026, 9, 5, 12, 34, 56);
    const start = new Date(startOfToday(noon));
    expect(start.getFullYear()).toBe(2026);
    expect([start.getMonth(), start.getDate(), start.getHours(), start.getMinutes(), start.getSeconds()]).toEqual([9, 5, 0, 0, 0]);
    expect(startOfToday(noon)).toMatch(/Z$/);
  });

  it("says how long a call took, in the unit that reads best", () => {
    expect(formatMillis(0)).toBe("0 ms");
    expect(formatMillis(412.4)).toBe("412 ms");
    expect(formatMillis(1000)).toBe("1.0 s");
    expect(formatMillis(2600)).toBe("2.6 s");
    expect(formatMillis(59_999)).toBe("1m 0s");
    expect(formatMillis(125_000)).toBe("2m 5s");
    expect(formatMillis(-1)).toBe("-");
    expect(formatMillis(Number.NaN)).toBe("-");
    expect(formatMillis(undefined)).toBe("-");
  });
});
