import { useRef, useState } from "react";
import { reviewAgentAction } from "../api.ts";
import { spatial, type AgentReply } from "../spatial-store.ts";

export function AgentActionReview({ action, onDone }: {
  action: NonNullable<AgentReply["pendingAction"]>;
  onDone(): void;
}) {
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function review(decision: "approve" | "dismiss") {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await reviewAgentAction(action.id, decision) as {
        ok: boolean; effect?: string; error?: { message?: string };
      };
      if (!result.ok) {
        setError(result.error?.message ?? "The change could not be applied. Ask for a fresh suggestion.");
        return;
      }
      onDone();
      if (decision === "approve") spatial.pushAgentReply({
        text: result.effect ?? "Your approved change was applied.", actions: [], answer: false,
      });
    } catch {
      setError("Could not reach the room. Check your connection and try again.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return <div className="agent-review" data-testid="agent-action-review">
    <p><strong>{action.title}</strong></p>
    <dl>
      {action.details.map((detail, i) => <div key={i}>
        <dt>{detail.label}</dt><dd dir="auto">{detail.value}</dd>
      </div>)}
    </dl>
    <p>These are the values that will be applied. Review any shared text before approving.</p>
    {error && <p role="alert">{error}</p>}
    <div className="card-actions">
      <button className="pill" type="button" disabled={busy} onClick={() => void review("approve")}>
        {busy ? "Saving…" : "Approve change"}
      </button>
      <button className="btn-text" type="button" disabled={busy} onClick={() => void review("dismiss")}>Dismiss</button>
    </div>
  </div>;
}
