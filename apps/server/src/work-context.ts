import { AsyncLocalStorage } from "node:async_hooks";

export type Workload = "interactive" | "background" | "prepopulate";
export interface WorkContext {
  workload: Workload;
  runId?: string;
  modelReservation?: string;
}
const context = new AsyncLocalStorage<WorkContext>();
export function currentWork(): WorkContext {
  return context.getStore() ?? { workload: "background" };
}
/** Queue dispatch can happen under another caller's async context. Capture the
 * submitting workload, reservation and run ID at enqueue time. */
export function bindWork<A extends unknown[], R>(
  run: (...args: A) => R,
  intent?: Workload,
): (...args: A) => R {
  const saved = { ...currentWork() };
  if (intent && saved.workload !== "prepopulate") saved.workload = intent;
  return (...args) => context.run(saved, () => run(...args));
}
export function withWork<T>(value: Partial<WorkContext>, run: () => T): T {
  const parent = currentWork();
  // A helper called by the CLI cannot promote its work into the interactive reserve.
  return context.run(
    {
      ...parent,
      ...value,
      ...(parent.workload === "prepopulate" ? { workload: "prepopulate" } : {}),
    },
    run,
  );
}
