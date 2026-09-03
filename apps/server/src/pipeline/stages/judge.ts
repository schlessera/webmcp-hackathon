import type pg from "pg";
import {
  evaluateMatrix,
  type EvaluateMatrixInput,
  type EvaluatedInference,
  type EvaluatedMatrixBatch,
} from "../../enrich/evaluate.ts";
import type { PipelineIntent } from "../queue.ts";

/** Submit one ready rectangle. Interactive work refreshes judgement, not page text. */
export function judge(
  input: EvaluateMatrixInput,
  persist?: (batch: EvaluatedMatrixBatch) => Promise<void>,
  cacheDb?: Pick<pg.Pool, "query"> | Pick<pg.PoolClient, "query">,
  intent: PipelineIntent = "background",
): Promise<EvaluatedInference[]> {
  return evaluateMatrix(
    input,
    persist,
    cacheDb,
    intent === "interactive" ? "refresh" : "reuse",
    intent,
  );
}
