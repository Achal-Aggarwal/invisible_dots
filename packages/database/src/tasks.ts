import { newId, TASK_LIST_LIMIT, type TaskState } from "@invisible-dots/shared";
import type { TaskRecord, TaskRunRecord } from "@invisible-dots/shared";
import { InboundRepository, type InboundRecord } from "./inbound.js";
import { iso, isoRequired, type Queryable } from "./rows.js";

interface TaskRow {
  id: string;
  dot_id: string;
  description: string;
  priority: number;
  status: TaskState;
  created_at: Date;
  scheduled_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  summary: string | null;
  error: string | null;
  spent_usd: number;
}

interface TaskRunRow {
  id: string;
  task_id: string;
  started_at: Date;
  delivered_at: Date | null;
  finished_at: Date | null;
  outcome: string | null;
}

function toTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    dot_id: row.dot_id,
    description: row.description,
    priority: row.priority,
    status: row.status,
    created_at: isoRequired(row.created_at),
    scheduled_at: iso(row.scheduled_at),
    started_at: iso(row.started_at),
    finished_at: iso(row.finished_at),
    summary: row.summary,
    error: row.error,
    spent_usd: row.spent_usd,
  };
}

function toRun(row: TaskRunRow): TaskRunRecord {
  return {
    id: row.id,
    task_id: row.task_id,
    started_at: isoRequired(row.started_at),
    delivered_at: iso(row.delivered_at),
    finished_at: iso(row.finished_at),
    outcome: row.outcome,
  };
}

/** Task states in which a Dot counts as busy: the dispatcher sends it nothing else (section 9.2). */
const ACTIVE = "('RUNNING', 'WAITING_APPROVAL')";
const TERMINAL = "('COMPLETED', 'FAILED', 'CANCELLED')";

/**
 * The claim of section 9.2. Higher priority first, then creation order. A
 * Dot with an active task is skipped.
 *
 * Only one dispatcher ever runs this against a database: one server holds
 * the database (`Database.holdInstanceLock`, taken at start), and its
 * dispatcher runs one pass at a time. The row locks make the claim and the
 * rest of its transaction one unit; they are NOT what would keep two
 * dispatchers on one external PostgreSQL from claiming two tasks of one Dot
 * (under READ COMMITTED the NOT EXISTS reads the statement's snapshot), which
 * is why a second server on the same database is refused instead.
 */
const CLAIMABLE = `
  FROM tasks t
  JOIN dots d ON d.id = t.dot_id
  JOIN computers c ON c.dot_id = t.dot_id
 WHERE t.status = 'PENDING'
   AND (t.scheduled_at IS NULL OR t.scheduled_at <= now())
   AND d.status <> 'CREATING'
   AND c.state NOT IN ('PROVISIONING', 'DELETING')
   AND NOT EXISTS (SELECT 1 FROM tasks busy WHERE busy.dot_id = t.dot_id AND busy.status IN ${ACTIVE})`;

export const CLAIM_SQL = `
SELECT t.*${CLAIMABLE}
 ORDER BY t.priority DESC, t.created_at, t.id
 LIMIT 1
   FOR UPDATE OF t, d SKIP LOCKED`;

export interface ClaimedTask {
  task: TaskRecord;
  run: TaskRunRecord;
  /** The task.created stored for the guest in the same transaction. */
  inbound: InboundRecord;
}

/** A task moved to a new state, and the state it left. */
export interface TaskTransition {
  task: TaskRecord;
  previous: TaskState;
}

export class TasksRepository {
  readonly #inbound: InboundRepository;

  constructor(private readonly q: Queryable) {
    this.#inbound = new InboundRepository(q);
  }

  async insert(input: {
    id: string;
    dotId: string;
    description: string;
    priority?: number;
    scheduledAt?: Date | null;
  }): Promise<TaskRecord> {
    const { rows } = await this.q.query<TaskRow>(
      `INSERT INTO tasks (id, dot_id, description, priority, status, scheduled_at)
       VALUES ($1, $2, $3, $4, 'PENDING', $5) RETURNING *`,
      [input.id, input.dotId, input.description, input.priority ?? 0, input.scheduledAt ?? null],
    );
    return toTask(rows[0]!);
  }

  async get(id: string): Promise<TaskRecord | null> {
    const { rows } = await this.q.query<TaskRow>("SELECT * FROM tasks WHERE id = $1", [id]);
    return rows[0] ? toTask(rows[0]) : null;
  }

  /**
   * The Dot's tasks, the newest created first, at most `limit` (default TASK_LIST_LIMIT). `before` (the id of the last
   * task of the previous page) goes on, older, from there; an id that is not a task of this Dot lists nothing.
   */
  async listByDot(dotId: string, options: { status?: TaskState; limit?: number; before?: string } = {}): Promise<TaskRecord[]> {
    const { rows } = await this.q.query<TaskRow>(
      `SELECT * FROM tasks
        WHERE dot_id = $1 AND ($2::text IS NULL OR status = $2)
          AND ($4::text IS NULL OR (created_at, id) < (SELECT created_at, id FROM tasks WHERE id = $4 AND dot_id = $1))
        ORDER BY created_at DESC, id DESC LIMIT $3`,
      [dotId, options.status ?? null, options.limit ?? TASK_LIST_LIMIT, options.before ?? null],
    );
    return rows.map(toTask);
  }

  async runs(taskId: string): Promise<TaskRunRecord[]> {
    const { rows } = await this.q.query<TaskRunRow>(
      "SELECT * FROM task_runs WHERE task_id = $1 ORDER BY started_at, id",
      [taskId],
    );
    return rows.map(toRun);
  }

  /**
   * Claim the next due task: mark it RUNNING, open a run, and store its
   * task.created for the guest, all in the caller's transaction
   * (`Database.transaction`), so a task is never RUNNING without the event
   * that tells its guest about it. Delivering that event is the inbound
   * deliverer's job, which survives a failed send and a restart.
   */
  /**
   * Whether a task could be claimed now, its rows' locks aside. A claim that found nothing while this is true
   * skipped a row another transaction held for a moment: the guest's next event updating the Dot as a task ends.
   */
  async hasClaimable(): Promise<boolean> {
    const { rows } = await this.q.query<{ any: boolean }>(`SELECT EXISTS (SELECT 1${CLAIMABLE}) AS any`);
    return rows[0]?.any === true;
  }

  async claimNext(ts: string = new Date().toISOString()): Promise<ClaimedTask | null> {
    const { rows } = await this.q.query<TaskRow>(CLAIM_SQL);
    const claimed = rows[0];
    if (!claimed) return null;
    const { rows: updated } = await this.q.query<TaskRow>(
      "UPDATE tasks SET status = 'RUNNING', started_at = COALESCE(started_at, now()) WHERE id = $1 RETURNING *",
      [claimed.id],
    );
    const { rows: runs } = await this.q.query<TaskRunRow>(
      "INSERT INTO task_runs (id, task_id) VALUES ($1, $2) RETURNING *",
      [newId("run"), claimed.id],
    );
    const task = toTask(updated[0]!);
    const run = toRun(runs[0]!);
    const inbound = await this.#inbound.enqueue(
      task.dot_id,
      {
        id: newId("evt"),
        type: "task.created",
        ts,
        data: { task_id: task.id, description: task.description, priority: task.priority },
      },
      { taskId: task.id, runId: run.id },
    );
    return { task, run, inbound };
  }

  /**
   * Move a task to `status`. A task already in a terminal state is left
   * alone (a cancelled task the guest finishes anyway stays cancelled), and
   * null comes back; otherwise the task and the state it left. With `dotId`,
   * only a task of that Dot moves: a guest can never touch another Dot's
   * tasks by naming their ids.
   *
   * Reaching a terminal state also closes the task's open run and expires its
   * pending approvals, here and nowhere else, so no caller can end a task and
   * leave an approval that nothing waits for in the pending list. Callers
   * that need all of it atomic run this inside their transaction.
   */
  async transition(
    taskId: string,
    status: TaskState,
    fields: { summary?: string; error?: string; dotId?: string } = {},
  ): Promise<TaskTransition | null> {
    const terminal = status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
    // The CTE locks the row first, so `previous` is the state this update replaced, also under concurrency.
    const { rows } = await this.q.query<TaskRow & { previous_status: TaskState }>(
      `WITH prev AS (
         SELECT id, status FROM tasks
          WHERE id = $1 AND status NOT IN ${TERMINAL} AND ($6::text IS NULL OR dot_id = $6)
          FOR UPDATE
       )
       UPDATE tasks t
          SET status = $2,
              started_at = CASE WHEN $2 IN ('RUNNING', 'WAITING_APPROVAL') THEN COALESCE(t.started_at, now()) ELSE t.started_at END,
              finished_at = CASE WHEN $3 THEN now() ELSE t.finished_at END,
              summary = COALESCE($4, t.summary),
              error = COALESCE($5, t.error)
         FROM prev
        WHERE t.id = prev.id
        RETURNING t.*, prev.status AS previous_status`,
      [taskId, status, terminal, fields.summary ?? null, fields.error ?? null, fields.dotId ?? null],
    );
    const row = rows[0];
    if (!row) return null;
    if (terminal) {
      await this.q.query(
        "UPDATE task_runs SET finished_at = now(), outcome = $2 WHERE task_id = $1 AND finished_at IS NULL",
        [taskId, status.toLowerCase()],
      );
      await this.q.query(
        "UPDATE approvals SET status = 'expired', resolved_at = now() WHERE task_id = $1 AND status = 'pending'",
        [taskId],
      );
    }
    const { previous_status: previous, ...task } = row;
    return { task: toTask(task), previous };
  }

  /**
   * Record what the guest says the task has spent (`spent_usd` of its events): the highest value
   * heard, so an event that arrives late or twice never lowers it. Unlike `transition` it also
   * counts for a task that already ended (a cancelled task the guest keeps working on still spends).
   * Only a task of `dotId` changes: a guest can never write another Dot's tasks by naming their ids.
   */
  async recordSpend(taskId: string, dotId: string, usd: number): Promise<void> {
    await this.q.query("UPDATE tasks SET spent_usd = GREATEST(spent_usd, $3) WHERE id = $1 AND dot_id = $2", [
      taskId,
      dotId,
      usd,
    ]);
  }

  /**
   * Whether the Dot has work (section 9.5): a due PENDING task, one RUNNING or
   * WAITING_APPROVAL, or an inbound event that has not reached its guest yet
   * (a message, an approval, a task being delivered).
   */
  async hasWork(dotId: string, now: Date): Promise<boolean> {
    const { rows } = await this.q.query(
      `SELECT 1 FROM tasks
        WHERE dot_id = $1
          AND (status IN ${ACTIVE} OR (status = 'PENDING' AND (scheduled_at IS NULL OR scheduled_at <= $2)))
       UNION ALL
       SELECT 1 FROM inbound_events WHERE dot_id = $1 AND delivered_at IS NULL AND dropped_at IS NULL
       LIMIT 1`,
      [dotId, now],
    );
    return rows.length > 0;
  }

  /**
   * Stopped Dots that new work waits for although the claim skips them: a due
   * PENDING task behind an active one (the Dot was stopped while its guest
   * worked on a task). Waking such a Dot lets its guest finish the active
   * task, after which the claim hands it the next one (section 9.5). A Dot in
   * ERROR is left to the person.
   */
  async stoppedDotsWithBlockedWork(): Promise<string[]> {
    const { rows } = await this.q.query<{ dot_id: string }>(
      `SELECT DISTINCT p.dot_id
         FROM tasks p
         JOIN dots d ON d.id = p.dot_id
         JOIN computers c ON c.dot_id = p.dot_id
        WHERE p.status = 'PENDING'
          AND (p.scheduled_at IS NULL OR p.scheduled_at <= now())
          AND c.state = 'STOPPED'
          AND d.status NOT IN ('CREATING', 'ERROR')
          AND EXISTS (SELECT 1 FROM tasks busy WHERE busy.dot_id = p.dot_id AND busy.status IN ${ACTIVE})
        ORDER BY p.dot_id`,
    );
    return rows.map((r) => r.dot_id);
  }
}
