import type { ComputerRecord, StopReason, VmState } from "@invisible-dots/shared";
import type { SecretBox } from "./crypto.js";
import { iso, isoRequired, type Queryable } from "./rows.js";

interface ComputerRow {
  dot_id: string;
  vm_name: string;
  guest_port: number | null;
  pid: number | null;
  state: VmState;
  golden_image: string | null;
  runtime_image: string | null;
  token_enc: Uint8Array;
  event_cursor: number;
  last_active_at: Date | null;
  next_automation_at: Date | null;
  stop_reason: StopReason | null;
  last_error: string | null;
  updated_at: Date;
}

function toRecord(row: ComputerRow): ComputerRecord {
  return {
    dot_id: row.dot_id,
    vm_name: row.vm_name,
    guest_port: row.guest_port,
    pid: row.pid,
    state: row.state,
    golden_image: row.golden_image,
    runtime_image: row.runtime_image,
    event_cursor: row.event_cursor,
    last_active_at: iso(row.last_active_at),
    next_automation_at: iso(row.next_automation_at),
    stop_reason: row.stop_reason,
    last_error: row.last_error,
    updated_at: isoRequired(row.updated_at),
  };
}

const tokenAad = (dotId: string) => `computer-token:${dotId}`;

/** The QEMU process of a running VM and the host port forwarded to its dot-agentd (sections 3.4 and 3.5). */
export interface VmProcess {
  pid: number;
  guestPort: number;
}

export class ComputersRepository {
  constructor(
    private readonly q: Queryable,
    private readonly box: SecretBox,
  ) {}

  /** A computer with no process yet: the port and pid are recorded at each start. */
  async insert(input: { dotId: string; vmName: string; state: VmState; token: string }): Promise<ComputerRecord> {
    const { rows } = await this.q.query<ComputerRow>(
      `INSERT INTO computers (dot_id, vm_name, state, token_enc) VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.dotId, input.vmName, input.state, this.box.encrypt(input.token, tokenAad(input.dotId))],
    );
    return toRecord(rows[0]!);
  }

  async get(dotId: string): Promise<ComputerRecord | null> {
    const { rows } = await this.q.query<ComputerRow>("SELECT * FROM computers WHERE dot_id = $1", [dotId]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async list(): Promise<ComputerRecord[]> {
    const { rows } = await this.q.query<ComputerRow>("SELECT * FROM computers ORDER BY dot_id");
    return rows.map(toRecord);
  }

  /** The Dot's own token, decrypted (section 5.1). */
  async token(dotId: string): Promise<string> {
    const { rows } = await this.q.query<Pick<ComputerRow, "token_enc">>(
      "SELECT token_enc FROM computers WHERE dot_id = $1",
      [dotId],
    );
    if (!rows[0]) throw new Error(`no computer for Dot ${dotId}`);
    return this.box.decrypt(rows[0].token_enc, tokenAad(dotId));
  }

  /**
   * Set the state. `lastError` replaces the stored error when given (null clears it) and leaves it alone when
   * undefined. `stopReason` is why the computer is going off: it is kept while the state is STOPPING or STOPPED (a
   * reason given with STOPPING stays for the STOPPED that follows, one given with STOPPED replaces it) and cleared by
   * any other state, so a computer that runs again carries no reason.
   */
  async setState(dotId: string, state: VmState, lastError?: string | null, stopReason?: StopReason): Promise<ComputerRecord | null> {
    const params: unknown[] = [dotId, state, stopReason ?? null];
    const sets = [
      "state = $2",
      "stop_reason = CASE WHEN $2 IN ('STOPPING', 'STOPPED') THEN COALESCE($3, stop_reason) ELSE NULL END",
      "updated_at = now()",
    ];
    if (lastError !== undefined) {
      params.push(lastError);
      sets.push(`last_error = $${params.length}`);
    }
    const { rows } = await this.q.query<ComputerRow>(`UPDATE computers SET ${sets.join(", ")} WHERE dot_id = $1 RETURNING *`, params);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async setImages(dotId: string, goldenImage: string, runtimeImage: string): Promise<void> {
    await this.q.query(
      "UPDATE computers SET golden_image = $2, runtime_image = $3, updated_at = now() WHERE dot_id = $1",
      [dotId, goldenImage, runtimeImage],
    );
  }

  /**
   * Record the running QEMU process, or clear it (null) once it is gone.
   * The port is chosen anew at every start, so a stopped computer keeps no
   * port that another VM may have been given since.
   */
  async setProcess(dotId: string, process: VmProcess | null): Promise<ComputerRecord | null> {
    const { rows } = await this.q.query<ComputerRow>(
      "UPDATE computers SET pid = $2, guest_port = $3, updated_at = now() WHERE dot_id = $1 RETURNING *",
      [dotId, process?.pid ?? null, process?.guestPort ?? null],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Record that the host saved every guest event up to `seq`. GREATEST keeps
   * the cursor from moving backwards if an old event is replayed.
   */
  async advanceCursor(dotId: string, seq: number, activeAt: Date): Promise<void> {
    await this.q.query(
      `UPDATE computers SET event_cursor = GREATEST(event_cursor, $2), last_active_at = $3, updated_at = now() WHERE dot_id = $1`,
      [dotId, seq, activeAt],
    );
  }

  async touch(dotId: string, activeAt: Date): Promise<void> {
    await this.q.query("UPDATE computers SET last_active_at = $2 WHERE dot_id = $1", [dotId, activeAt]);
  }

  /** Record what the guest reported as the time its earliest enabled automation is next due (null: none), in ms since the epoch. */
  async setNextAutomation(dotId: string, atMs: number | null): Promise<void> {
    await this.q.query("UPDATE computers SET next_automation_at = $2 WHERE dot_id = $1", [dotId, atMs === null ? null : new Date(atMs)]);
  }

  /**
   * The stopped computers whose Dot has an automation due at `by` or before (a time already past counts: the run was
   * missed and the guest makes it when it starts), so the control plane can start them. A computer the person stopped
   * (`stop_reason` user) stays off until the person starts it again, and a Dot in ERROR or still being created
   * is left alone, like the one whose work waits behind an unfinished task (`stoppedDotsWithBlockedWork`).
   */
  async stoppedWithAutomationBy(by: Date): Promise<string[]> {
    const { rows } = await this.q.query<{ dot_id: string }>(
      `SELECT c.dot_id
         FROM computers c
         JOIN dots d ON d.id = c.dot_id
        WHERE c.state = 'STOPPED'
          AND c.next_automation_at IS NOT NULL
          AND c.next_automation_at <= $1
          AND c.stop_reason IS DISTINCT FROM 'user'
          AND d.status NOT IN ('CREATING', 'ERROR')
        ORDER BY c.next_automation_at, c.dot_id`,
      [by],
    );
    return rows.map((r) => r.dot_id);
  }
}
