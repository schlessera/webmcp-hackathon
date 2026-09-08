import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { failedOutcome, type WorkOutcome } from "../work-outcome.ts";
import type { PrepopulateOptions } from "./options.ts";

export class Checkpoints {
  readonly id: string;
  readonly owner = randomUUID();
  paused = false;
  private heartbeat?: ReturnType<typeof setInterval>;
  private db: pg.Pool;
  private options: PrepopulateOptions;
  private report: (event: Record<string, unknown>) => void;
  constructor(
    db: pg.Pool,
    options: PrepopulateOptions,
    report: (event: Record<string, unknown>) => void,
  ) {
    this.db = db;
    this.options = options;
    this.report = report;
    this.id = options.resume ?? randomUUID();
  }
  async start(refs: string[]): Promise<void> {
    const selection = {
      refs,
      area: this.options.area.id,
      radius: this.options.radiusM,
      sources: [...this.options.sources].sort(),
      profile: this.options.profile ?? "explore",
    };
    const hash = createHash("sha256")
      .update(JSON.stringify(selection))
      .digest("hex");
    if (this.options.resume) {
      const previous = (
        await this.db.query(
          "SELECT selection_hash FROM prepopulation_runs WHERE id=$1",
          [this.id],
        )
      ).rows[0];
      if (!previous) throw new Error("Unknown --resume run ID");
      if (previous.selection_hash !== hash)
        throw new Error(
          "Resume requires the same region, selection, sources and profile",
        );
    } else
      await this.db.query(
        `INSERT INTO prepopulation_runs(id,options,selection_hash,max_requests,max_cost_usd)
       VALUES($1,$2,$3,$4,$5)`,
        [
          this.id,
          JSON.stringify(selection),
          hash,
          this.options.maxRequests ?? null,
          this.options.maxCostUsd ?? null,
        ],
      );
    const admitted = await this.db.query(
      `UPDATE prepopulation_runs SET owner=$2,status='running',updated_at=now(),lease_expires_at=now()+interval '2 minutes',
       max_requests=coalesce($3,max_requests),max_cost_usd=coalesce($4,max_cost_usd)
       WHERE id=$1 AND (owner IS NULL OR lease_expires_at<=now()) RETURNING id`,
      [
        this.id,
        this.owner,
        this.options.maxRequests ?? null,
        this.options.maxCostUsd ?? null,
      ],
    );
    if (!admitted.rowCount) throw new Error("This run is already active");
    await this.db.query(
      "UPDATE prepopulation_stages SET status='pending' WHERE run_id=$1 AND status='running'",
      [this.id],
    );
    this.heartbeat = setInterval(() => {
      void this.db
        .query(
          `UPDATE prepopulation_runs SET updated_at=now(),lease_expires_at=now()+interval '2 minutes'
        WHERE id=$1 AND owner=$2 RETURNING id`,
          [this.id, this.owner],
        )
        .then((r) => {
          if (!r.rowCount) this.paused = true;
        })
        .catch(() => {
          this.paused = true;
        });
    }, 30_000);
    this.heartbeat.unref();
    this.report({
      event: "run",
      runId: this.id,
      resumed: Boolean(this.options.resume),
    });
  }
  async pending(ref: string, stage: string): Promise<boolean> {
    const row = (
      await this.db.query(
        "SELECT status,retry_at,attempts FROM prepopulation_stages WHERE run_id=$1 AND osm_ref=$2 AND stage=$3",
        [this.id, ref, stage],
      )
    ).rows[0];
    if (!row) return true;
    if (["ok", "empty"].includes(row.status)) return false;
    if (this.options.retryFailed) return true;
    if (
      row.status === "failed" ||
      row.attempts >= 5 ||
      (row.retry_at && new Date(row.retry_at).getTime() > Date.now())
    )
      return false;
    return true;
  }
  async stage<T>(
    ref: string,
    stage: string,
    run: () => Promise<T>,
  ): Promise<WorkOutcome<T> | null> {
    if (this.paused || !(await this.pending(ref, stage))) return null;
    await this.db.query(
      `INSERT INTO prepopulation_stages(run_id,osm_ref,stage,status,attempts)
      VALUES($1,$2,$3,'running',1) ON CONFLICT(run_id,osm_ref,stage)
      DO UPDATE SET status='running',attempts=prepopulation_stages.attempts+1,updated_at=now()`,
      [this.id, ref, stage],
    );
    try {
      const value = await run();
      await this.mark(ref, stage, "ok");
      return { status: "ok", value };
    } catch (error) {
      const outcome = failedOutcome(error, stage);
      await this.db.query(
        `UPDATE prepopulation_stages SET status=$4,failure=$5,retry_at=$6,updated_at=now()
        WHERE run_id=$1 AND osm_ref=$2 AND stage=$3`,
        [
          this.id,
          ref,
          stage,
          outcome.status,
          JSON.stringify(outcome.failure),
          outcome.failure.retryAt ?? null,
        ],
      );
      if (["quota", "interrupted"].includes(outcome.failure.code))
        this.paused = true;
      this.report({
        event: "stage",
        runId: this.id,
        stage,
        status: outcome.status,
        ...outcome.failure,
      });
      return outcome;
    }
  }
  async mark(
    ref: string,
    stage: string,
    status: "ok" | "empty",
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO prepopulation_stages(run_id,osm_ref,stage,status)
      VALUES($1,$2,$3,$4) ON CONFLICT(run_id,osm_ref,stage)
      DO UPDATE SET status=$4,failure=NULL,retry_at=NULL,updated_at=now()`,
      [this.id, ref, stage, status],
    );
  }
  async finish(interrupted: boolean, unfinished: boolean) {
    clearInterval(this.heartbeat);
    const counts = (
      await this.db.query(
        `SELECT count(*) FILTER(WHERE status='failed')::int AS failed,
      count(*) FILTER(WHERE status='deferred')::int AS deferred,min(retry_at) AS retry_at
      FROM prepopulation_stages WHERE run_id=$1`,
        [this.id],
      )
    ).rows[0];
    const status = interrupted
      ? "interrupted"
      : counts.failed
        ? "failed"
        : counts.deferred || unfinished || this.paused
          ? "deferred"
          : "complete";
    await this.db.query(
      `UPDATE prepopulation_runs SET status=$3,updated_at=now(),retry_at=$4,owner=NULL,lease_expires_at=NULL
      WHERE id=$1 AND owner=$2`,
      [this.id, this.owner, status, counts.retry_at],
    );
    const accounting = (
      await this.db.query(
        `SELECT count(*)::int AS requests,
      coalesce(sum(actual_cost_usd),0)::float8 AS reported_cost_usd,
      coalesce(sum(coalesce(actual_cost_usd,estimated_cost_usd)),0)::float8 AS reserved_cost_usd,
      count(*) FILTER(WHERE actual_cost_usd IS NULL)::int AS unreconciled_requests
      FROM provider_attempts WHERE run_id=$1`,
        [this.id],
      )
    ).rows[0];
    return {
      status,
      runId: this.id,
      deferred: counts.deferred,
      retryAt: counts.retry_at?.toISOString() ?? null,
      accounting,
    };
  }
}
