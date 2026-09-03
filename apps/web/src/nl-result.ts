export interface NlResultState {
  ok: boolean;
  intent?: "need" | "ask" | "act" | "unclear";
  partial?: boolean;
}

/** R7: failed/partial agent work is retried as the same sentence, never
 * reinterpreted as a requirement after some earlier action may have landed. */
export function shouldPreserveNlText(result: NlResultState): boolean {
  return (
    !result.ok ||
    (result.partial === true && (result.intent === "ask" || result.intent === "act"))
  );
}
