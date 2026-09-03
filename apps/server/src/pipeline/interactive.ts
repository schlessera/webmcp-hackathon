export type InteractiveResource = "fetch" | "search" | "model" | "vision";

export interface InteractiveUsage {
  fetch: number;
  search: number;
  model: number;
  vision: number;
}

export const INTERACTIVE_LIMITS: Readonly<InteractiveUsage> = {
  fetch: 1,
  search: 1,
  model: 3,
  vision: 1,
};

/** A per-place, per-open hard budget. Vision is intentionally separate from model calls. */
export class InteractiveBudget {
  private readonly used: InteractiveUsage = { fetch: 0, search: 0, model: 0, vision: 0 };
  private readonly deferred: InteractiveUsage = { fetch: 0, search: 0, model: 0, vision: 0 };
  private readonly onDeferred?: (resource: InteractiveResource) => void;

  constructor(onDeferred?: (resource: InteractiveResource) => void) {
    this.onDeferred = onDeferred;
  }

  take(resource: InteractiveResource): boolean {
    if (this.used[resource] >= INTERACTIVE_LIMITS[resource]) {
      this.deferred[resource] += 1;
      this.onDeferred?.(resource);
      return false;
    }
    this.used[resource] += 1;
    return true;
  }

  snapshot(): { used: InteractiveUsage; deferred: InteractiveUsage } {
    return { used: { ...this.used }, deferred: { ...this.deferred } };
  }
}
