import type { ReadyCell } from "./queue.ts";

/** Long enough for a full place x criterion rectangle to form. At 300ms the
 * window closed on one to three places and each partial batch still cost a
 * whole model call. */
export const MATRIX_BATCH_WAIT_MS = Number(process.env.MATRIX_BATCH_WAIT_MS ?? 800);
export const MATRIX_BATCH_PLACES = 8;
export const MATRIX_BATCH_CRITERIA = 5;

export class MatrixBatcher<T> {
  private pending: Array<ReadyCell<T>> = [];
  private timer?: ReturnType<typeof setTimeout>;
  private readonly dispatch: (cells: Array<ReadyCell<T>>) => Promise<void> | void;
  private readonly waitMs: number;

  constructor(
    dispatch: (cells: Array<ReadyCell<T>>) => Promise<void> | void,
    waitMs = MATRIX_BATCH_WAIT_MS,
  ) {
    this.dispatch = dispatch;
    this.waitMs = waitMs;
  }

  add(cell: ReadyCell<T>): void {
    this.addMany([cell]);
  }

  /** Priority-zero cells bypass the collection window without draining background work. */
  addMany(cells: Array<ReadyCell<T>>): void {
    if (cells.length === 0) return;
    const interactive = cells.filter((cell) => cell.priority === 0);
    const background = cells.filter((cell) => cell.priority !== 0);
    this.pending.push(...background);
    for (const first of interactive) {
      const samePlace = interactive.filter((cell) =>
        cell.roomId === first.roomId && cell.candidateId === first.candidateId
      );
      if (samePlace[0] !== first) continue;
      void Promise.resolve(this.dispatch(samePlace));
    }
    if (this.full()) {
      this.flush();
      return;
    }
    if (this.pending.length === 0) return;
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.waitMs);
      this.timer.unref?.();
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.length === 0) return;
    const first = this.pending[0];
    const roomId = first.roomId;
    const selected: Array<ReadyCell<T>> = [];
    const retained: Array<ReadyCell<T>> = [];
    const places = new Set<string>();
    const criteria = new Set<string>();
    for (const cell of this.pending) {
      const nextPlaces = new Set(places).add(cell.candidateId);
      const nextCriteria = new Set(criteria).add(cell.criterionId);
      if (
        cell.roomId === roomId &&
        nextPlaces.size <= MATRIX_BATCH_PLACES &&
        nextCriteria.size <= MATRIX_BATCH_CRITERIA
      ) {
        selected.push(cell);
        places.add(cell.candidateId);
        criteria.add(cell.criterionId);
      } else retained.push(cell);
    }
    this.pending = retained;
    void Promise.resolve(this.dispatch(selected));
    if (this.pending.length > 0) {
      if (this.full()) this.flush();
      else {
        this.timer = setTimeout(() => this.flush(), this.waitMs);
        this.timer.unref?.();
      }
    }
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
  }

  remove(predicate: (cell: ReadyCell<T>) => boolean): Array<ReadyCell<T>> {
    const removed: Array<ReadyCell<T>> = [];
    const retained: Array<ReadyCell<T>> = [];
    for (const cell of this.pending) {
      if (predicate(cell)) removed.push(cell);
      else retained.push(cell);
    }
    if (removed.length === 0) return [];
    this.pending = retained;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.length > 0) {
      if (this.full()) this.flush();
      else {
        this.timer = setTimeout(() => this.flush(), this.waitMs);
        this.timer.unref?.();
      }
    }
    return removed;
  }

  get size(): number {
    return this.pending.length;
  }

  private full(): boolean {
    if (this.pending.length === 0) return false;
    const roomId = this.pending[0].roomId;
    const places = new Set<string>();
    const criteria = new Set<string>();
    for (const cell of this.pending) {
      if (cell.roomId !== roomId) continue;
      places.add(cell.candidateId);
      criteria.add(cell.criterionId);
    }
    return places.size >= MATRIX_BATCH_PLACES || criteria.size >= MATRIX_BATCH_CRITERIA;
  }
}
