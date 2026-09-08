import type { WireEvent } from "../wire-store.ts";
import { formatMs } from "../wire-timeline.ts";

/** Content comes before performance diagnostics. Nothing here requires opening
 * raw metadata; long collections are bounded when recorded. */
export function WireContent({ event }: { event: WireEvent }) {
  const content = event.content;
  const c = content?.conversation;
  const legacyTypes = !content?.events && event.lane === "ws" && event.label.startsWith("event")
    ? String(event.detail?.types ?? "").split(/\s+/).filter(Boolean) : [];
  return <>
    {event.label === "condition" && <p className="wire-notice">Held private condition. Its words and interpretation are never recorded in Wire.</p>}
    {c ? <>
      <section className="wire-inspector-section wire-content"><h4>Conversation <span>· {c.scope === "application-private" ? "only you" : "shared"}</span></h4>
        <div className="wire-utterance"><small>You said</small><p>{c.input}</p></div>
        {c.intent && <p className="wire-help">Understood as: {c.intent}</p>}
        {c.reply ? <div className="wire-utterance"><small>{c.intent === "clarify" ? "Clarification" : "Agent replied"}</small><p>{c.reply}</p></div>
          : <p className="wire-help">{event.endAt === undefined ? "Waiting for a response…" : c.intent === "need" ? "Requirements returned; no separate chat reply." : "No reply was recorded."}</p>}
        {!!c.needs?.length && <div className="wire-utterance"><small>Requirements returned</small><ul>{c.needs.map((need, i) => <li key={i}>{need}</li>)}</ul></div>}
        {!!c.choices?.length && <div className="wire-utterance"><small>Choices offered</small><ul>{c.choices.map((choice, i) => <li key={i}>{choice}</li>)}</ul></div>}
        {c.approval && <div className="wire-notice"><strong>Approval requested</strong><p>{c.approval}</p><p className="wire-help">Nothing was applied by this turn. Approval happens on the page.</p></div>}
        {c.failure && <p className="wire-notice">Turn did not finish: {c.failure}. Your text was preserved for retry.</p>}
      </section>
      <section className="wire-inspector-section wire-content"><h4>Tools called <span>{c.calls?.length ?? ""}</span></h4>
        {c.calls?.length ? <ol className="wire-call-list">{c.calls.map((call, i) => <li key={i} data-failed={!call.ok || undefined}>
          <div><strong>{call.tool}</strong><span>{formatMs(call.ms)}</span></div>
          <small>Round {call.round} · {call.state === "approval_required" ? "approval required" : call.ok ? "completed" : "failed"}</small>
          {call.summary && <p>{call.summary}</p>}
        </li>)}</ol> : <p className="wire-help">{c.calls ? "No tool calls in this turn." : event.endAt === undefined ? "Tool calls are reported when the turn returns." : "Tool calls were not reported by this server build."}</p>}
        {!!content?.omittedCalls && <p className="wire-notice">{content.omittedCalls} additional calls omitted by the recording limit.</p>}
        {!!c.calls?.length && <p className="wire-help">Tool order and durations are reported by the server. Arguments and result bodies are not recorded.</p>}
      </section>
    </> : event.label === "say" && <section className="wire-inspector-section wire-content"><h4>Conversation</h4>
      {typeof event.detail?.said === "string" && <div className="wire-utterance"><small>You said · older recording excerpt</small><p>{event.detail.said}</p></div>}
      <p className="wire-help">This turn has no conversation recording. New page turns include the input, reply and tool outcomes.</p>
    </section>}
    {(content?.events || legacyTypes.length > 0) && <section className="wire-inspector-section wire-content"><h4>Events in this frame <span>{event.label.replace(/^event\s*/, "")}</span></h4>
      <ol className="wire-call-list">{content?.events ? content.events.map((e, i) => <li key={i}>
        <strong>{e.type}</strong><p>{e.text || "No description was included."}</p>
        <small>Revision {e.revision} · {e.level === "full" ? "visible to you" : `${e.level} projection`}</small>
      </li>) : legacyTypes.map((type, i) => <li key={i}><strong>{type}</strong></li>)}</ol>
      {!content?.events && <p className="wire-help">Older recording: event descriptions were not retained.</p>}
      {!!content?.omittedEvents && <p className="wire-notice">{content.omittedEvents} additional events omitted by the recording limit.</p>}
    </section>}
    {(event.lane === "http" || event.lane === "tool") && (event.detail?.effect || event.detail?.error || event.detail?.args) &&
      <section className="wire-inspector-section wire-content"><h4>{event.lane === "tool" ? "Tool outcome" : "Response"}</h4>
        {event.detail?.args && <p>Argument fields: {event.detail.args}</p>}
        {event.detail?.effect && <p>{event.detail.effect}</p>}
        {event.detail?.error && <p>{event.detail.error}</p>}
        {event.detail?.recovery && <p>{event.detail.recovery}</p>}
        {event.lane === "tool" && <p>{event.note ?? event.outcome ?? "In progress"}</p>}
      </section>}
    {content?.shortened && <p className="wire-notice">Some content was shortened to fit the recording limits.</p>}
  </>;
}
