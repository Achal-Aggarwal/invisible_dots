import { APPROVAL_LIST_LIMIT, type ApprovalRequestedData, type ApprovalStatus, type ListOrder } from "@invisible-dots/shared";
import type { ApprovalRecord } from "@invisible-dots/shared";
import { iso, isoRequired, type Queryable } from "./rows.js";

interface ApprovalRow {
  id: string;
  dot_id: string;
  task_id: string | null;
  tool: string;
  permission: string;
  arguments: Record<string, unknown>;
  reason: string;
  status: ApprovalStatus;
  note: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

function toRecord(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    dot_id: row.dot_id,
    task_id: row.task_id,
    tool: row.tool,
    permission: row.permission,
    arguments: row.arguments,
    reason: row.reason,
    status: row.status,
    note: row.note,
    created_at: isoRequired(row.created_at),
    resolved_at: iso(row.resolved_at),
  };
}

export class ApprovalsRepository {
  constructor(private readonly q: Queryable) {}

  /**
   * Record an `approval.requested` event; a replayed event is ignored and
   * returns null. `expired` records a request whose task had already ended
   * when it arrived, so it never shows up as pending.
   */
  async insertRequested(
    dotId: string,
    data: ApprovalRequestedData,
    status: "pending" | "expired" = "pending",
  ): Promise<ApprovalRecord | null> {
    const { rows } = await this.q.query<ApprovalRow>(
      `INSERT INTO approvals (id, dot_id, task_id, tool, permission, arguments, reason, status, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text, CASE WHEN $8::text = 'pending' THEN NULL ELSE now() END)
       ON CONFLICT (id) DO NOTHING RETURNING *`,
      [
        data.approval_id,
        dotId,
        data.task_id ?? null,
        data.tool,
        data.permission,
        JSON.stringify(data.arguments),
        data.reason,
        status,
      ],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    const { rows } = await this.q.query<ApprovalRow>("SELECT * FROM approvals WHERE id = $1", [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** The Dot's approvals whose id ends with `suffix` (compared in lowercase), oldest first: how a short code typed in a chat finds its approval. */
  async endingWith(dotId: string, suffix: string): Promise<ApprovalRecord[]> {
    const { rows } = await this.q.query<ApprovalRow>(
      "SELECT * FROM approvals WHERE dot_id = $1 AND lower(right(id, char_length($2::text))) = lower($2::text) ORDER BY created_at, id",
      [dotId, suffix],
    );
    return rows.map(toRecord);
  }

  /**
   * The approvals of one status or of several, of one Dot or of all. `asc` (the default) is the oldest first, in the
   * order they were asked. `desc` is the newest first by the time of the last change, the answer for an answered
   * approval and the request for a pending one, so a limit keeps the newest and never hides a recent answer behind old
   * ones. `before` (desc only) is the id of the last row of the previous page: the list goes on after it, and an id
   * that is not an approval lists nothing.
   */
  async list(
    options: { status?: ApprovalStatus | readonly ApprovalStatus[]; dotId?: string; limit?: number; order?: ListOrder; before?: string } = {},
  ): Promise<ApprovalRecord[]> {
    if (options.before !== undefined && options.order !== "desc") throw new Error("approvals: `before` pages a list in order desc");
    const status = options.status === undefined ? null : typeof options.status === "string" ? [options.status] : [...options.status];
    const filters = [status, options.dotId ?? null, options.limit ?? APPROVAL_LIST_LIMIT];
    const where = "($1::text[] IS NULL OR status = ANY($1)) AND ($2::text IS NULL OR dot_id = $2)";
    if (options.order !== "desc") {
      const { rows } = await this.q.query<ApprovalRow>(`SELECT * FROM approvals WHERE ${where} ORDER BY created_at, id LIMIT $3`, filters);
      return rows.map(toRecord);
    }
    const changed = "COALESCE(resolved_at, created_at)";
    const { rows } = await this.q.query<ApprovalRow>(
      `SELECT * FROM approvals
        WHERE ${where}
          AND ($4::text IS NULL OR (${changed}, id) < (SELECT ${changed}, id FROM approvals WHERE id = $4))
        ORDER BY ${changed} DESC, id DESC LIMIT $3`,
      [...filters, options.before ?? null],
    );
    return rows.map(toRecord);
  }

  /**
   * Use up the newest approved, unused approval of `tool` on the Dot whose arguments are exactly `args`, in one
   * statement: the person's consent to a call whose effect the host applies itself, consumed by that effect so it
   * never applies it twice. Null when there is none. jsonb equality ignores the order of an object's keys, so the
   * arguments compare as values, however the guest wrote them.
   */
  async useApproved(dotId: string, tool: string, args: Record<string, unknown>): Promise<ApprovalRecord | null> {
    const { rows } = await this.q.query<ApprovalRow>(
      `UPDATE approvals SET used_at = now()
        WHERE id = (SELECT id FROM approvals
                     WHERE dot_id = $1 AND tool = $2 AND status = 'approved' AND used_at IS NULL AND arguments = $3::jsonb
                     ORDER BY resolved_at DESC, id DESC LIMIT 1
                     FOR UPDATE)
          AND used_at IS NULL
        RETURNING *`,
      [dotId, tool, JSON.stringify(args)],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Resolve a pending approval; null when it does not exist or was already resolved. */
  async resolve(id: string, status: "approved" | "rejected", note: string | null): Promise<ApprovalRecord | null> {
    const { rows } = await this.q.query<ApprovalRow>(
      `UPDATE approvals SET status = $2, note = $3, resolved_at = now()
        WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, status, note],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
