/**
 * Closed error-code enum — INTERACTION-AND-BINDING.md §3, plus the two
 * environment codes VALIDATION-SPIKE-1 adds (not_authenticated, upgrade_required).
 */
export const ERROR_CODES = [
  "sync_required",
  "not_authorized",
  "invalid_input",
  "not_found",
  "phase_unavailable",
  "consent_required",
  "bound_exceeded",
  "not_authenticated",
  "upgrade_required",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ToolError {
  code: ErrorCode;
  message: string;
  /** Self-correcting errors: every failure tells the model what to do next. */
  recovery: string;
}
