import { useEffect, useRef, useState } from "react";
import { Wordmark } from "./Wordmark.tsx";
import "../landing.css";

/**
 * The front door at `/` for someone arriving without an invite. Two halves,
 * one scroll: first the room as a product, told in the app's own vocabulary
 * (marks, count block, need rows); then the `{ }` drawer opens across the
 * page and the protocol story is told where protocol belongs (CLAUDE.md §6).
 *
 * Every number here is measured on the tree that ships it and named in
 * docs/SUBMISSION.md; change them together. Copy follows COPY.md: places
 * not domain nouns, need not filter, no first person, no exclamation marks.
 */

const REPO = "https://github.com/schlessera/webmcp-hackathon";
const DOCS = `${REPO}/blob/main/docs`;

interface Props {
  onStart(): void;
}

const NEGOTIATION_TOOLS: Array<[string, string]> = [
  ["sync_session", "read"],
  ["submit_requirement", "mutation"],
  ["withdraw_requirement", "mutation"],
  ["set_requirement_active", "mutation"],
  ["evaluate_candidates", "mutation"],
  ["respond_to_proposal", "mutation"],
  ["resolve_private_request", "mutation"],
  ["set_ready_state", "mutation"],
  ["confirm_agreement", "stages"],
];

const SPATIAL_TOOLS: Array<[string, string]> = [
  ["get_spatial_context", "read"],
  ["inspect_candidates", "read"],
  ["look_up_places", "read, then facts land"],
  ["set_search_scope", "mutation"],
  ["add_candidates", "mutation"],
  ["propose_destination", "mutation"],
  ["attest_attribute", "mutation"],
  ["plan_arrival", "mutation"],
  ["focus_destination", "page-local"],
  ["prepare_navigation", "read"],
];

function Mark({ kind }: { kind?: string }) {
  // The busy state is the room's turning ring, not a mark of its own.
  if (kind === "busy") return <i className="busy-ring ld-busy" aria-hidden="true" />;
  return <span className="mark" data-mark={kind} aria-hidden="true" />;
}

/** The `{ }` drawer opening across the page: one authored moment. */
function useReveal() {
  const ref = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setOpen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setOpen(true);
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -20% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, open };
}

/**
 * The top bar takes the drawer's ground while the ink half is under it, so
 * the wordmark and the action never sit on a cream strip over ink. A scroll
 * check on the page's own scroll container; nothing animates under reduced
 * motion because the colour transition runs on the settle token.
 */
function useInkBar(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  inkRef: React.RefObject<HTMLDivElement | null>,
): boolean {
  const [ink, setInk] = useState(false);
  useEffect(() => {
    const root = scrollRef.current;
    const el = inkRef.current;
    if (!root || !el) return;
    let raf = 0;
    const check = () => {
      raf = 0;
      const bar = root.querySelector(".ld-top")?.getBoundingClientRect().bottom ?? 56;
      const r = el.getBoundingClientRect();
      setInk(r.top <= bar && r.bottom > bar);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    check();
    return () => {
      root.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef, inkRef]);
  return ink;
}

export function Landing({ onStart }: Props) {
  const reveal = useReveal();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inkRef = useRef<HTMLDivElement | null>(null);
  const barInk = useInkBar(scrollRef, inkRef);
  return (
    <div className="landing" data-testid="landing" ref={scrollRef}>
      <header className="ld-top" data-ink={barInk || undefined}>
        <a className="ld-brand" href="/" aria-label="Spokes">
          <Wordmark />
        </a>
        <nav className="ld-top-actions" aria-label="Page">
          <a className="ld-link" href={REPO}>
            Source
          </a>
          <button
            type="button"
            className="btn"
            data-tone="works"
            data-testid="landing-start"
            onClick={onStart}
          >
            Start a room
          </button>
        </nav>
      </header>

      {/* ── The room ─────────────────────────────────────────────────── */}
      <main className="ld-room">
        <section className="ld-hero">
          <div className="ld-hero-copy">
            <h1 className="ld-h1">
              Decide together,
              <br />
              go together.
            </h1>
            <p className="ld-lede">
              A shared map where a group and their agents converge on a place.
              Everyone&rsquo;s needs count. Not everyone&rsquo;s reasons are
              shared.
            </p>
            <div className="ld-cta">
              <button
                type="button"
                className="btn ld-btn-big"
                data-tone="works"
                onClick={onStart}
              >
                Start a room
              </button>
              <p className="ld-cta-note">
                Got a link from someone? Open it. The room is already there,
                exactly as it stands.
              </p>
            </div>
          </div>
          <figure className="ld-hero-fig">
            <div className="ld-plate">
              <img
                src="/landing/hero-desktop.webp"
                width="1440"
                height="900"
                alt="A room over San Francisco. The count block reads 7 still work of 40, 2 likely, 24 unsure, checking 57 places. Named places sit spread across a dashed search ring; small grey dots show every other place the map knows about."
                loading="eager"
                decoding="async"
              />
            </div>
            <figcaption>
              One room, forty places, one need so far. The ring is where the
              group is looking; the grey dots are everything else the map knows.
            </figcaption>
          </figure>
        </section>

        <section className="ld-problem">
          <div className="ld-problem-copy">
          <p className="ld-read">
            Picking somewhere to go with other people is a negotiation nobody
            runs. The needs are scattered and arrive piecemeal: a diet here, a
            budget there, a veto that lands late, a reason someone would rather
            not say out loud. A search list answers one query. A group chat
            collects messages. Neither holds the group&rsquo;s needs in one
            place, and neither lets a reason stay private while still being
            counted.
          </p>
          <p className="ld-read">
            Spokes is that place. One map, everyone&rsquo;s needs on it, live.
            Your agent can act for you inside the same room, within the
            authority you gave it and nothing more.
          </p>
          </div>
          <aside className="ld-problem-aside" aria-hidden="true">
            <span className="ld-brief-label">What matters</span>
            <div className="ld-rows">
              <div className="need-row ld-row">
                <Mark />
                <span className="ld-row-label">vegetarian options · Sarah</span>
                <span className="ld-row-delta">−4</span>
              </div>
              <div className="need-row ld-row">
                <Mark />
                <span className="ld-row-label">within 15 min walk · Joe</span>
                <span className="ld-row-delta">−13</span>
              </div>
              <div className="need-row ld-row" data-variant="private">
                <Mark kind="private" />
                <span className="ld-row-label ld-row-private">A private condition</span>
                <span className="ld-row-delta">−2</span>
                <span className="ld-chip" data-tone="scope">private</span>
              </div>
              <div className="need-row ld-row" data-variant="silent">
                <Mark kind="silent" />
                <span className="ld-row-label ld-row-private">Joe&rsquo;s agent holds one condition</span>
                <span className="ld-chip" data-tone="scope">agent only</span>
              </div>
            </div>
            <span className="ld-brief-note">Three people, four needs, one map. Two of them stay private and still count.</span>
          </aside>
        </section>

        {/* The beats: a brief, not a feature grid. */}
        <section className="ld-beats" aria-labelledby="ld-beats-h">
          <h2 className="ld-label" id="ld-beats-h">
            What happens in a room
          </h2>

          <article className="ld-beat" data-side="text">
            <div className="ld-beat-copy">
              <h3 className="ld-h3">
                <Mark kind="private" /> Say what matters, and who gets to see
                it.
              </h3>
              <p className="ld-read">
                One line, one choice before you speak. <strong>Shared</strong>:
                everyone in the room reads it. <strong>Private</strong>: the room
                sees only what it rules out. <strong>Agent only</strong>: your
                agent holds it, and the room learns only that a condition
                exists.
              </p>
            </div>
            <figure className="ld-shot">
              <img
                src="/landing/scopes-mobile.webp"
                width="430"
                height="932"
                alt="The composer with three scopes open: Shared, everyone in the room reads it; Private, the room sees only what it rules out; Agent only, your agent holds it and the room learns a condition exists."
                loading="lazy"
                decoding="async"
              />
            </figure>
          </article>

          <article className="ld-beat" data-side="text">
            <div className="ld-beat-copy">
              <h3 className="ld-h3">
                <Mark /> Watch the map settle.
              </h3>
              <p className="ld-read">
                A need lands and the places that stop working fade where they
                stand. The ones that come back grow from their own dot. The map
                never moves under you; your memory of where things are is the
                point.
              </p>
            </div>
            <div className="ld-drawn" aria-hidden="true">
              <div className="ld-count">
                <div className="count-block ld-count-block" data-state="works">
                  <span className="ld-count-big">12</span>
                  <span className="ld-count-word">still work</span>
                  <span className="ld-count-sub">of 21 · 2 likely · 5 unsure</span>
                </div>
                <span className="ld-delta">
                  <b>+9</b> if &ldquo;vegetarian options&rdquo; went optional
                </span>
              </div>
              <div className="ld-rows">
                <div className="need-row ld-row" data-variant="applied">
                  <Mark />
                  <span className="ld-row-label">outdoor seating</span>
                  <span className="ld-row-delta">−5</span>
                </div>
                <div className="need-row ld-row" data-variant="pending">
                  <Mark kind="busy" />
                  <span className="ld-row-label">step-free access <span className="ld-row-note">checking 12 places…</span></span>
                </div>
              </div>
            </div>
          </article>

          <article className="ld-beat" data-side="text">
            <div className="ld-beat-copy">
              <h3 className="ld-h3">
                <Mark kind="unknown" /> Hold a need to see the room without it.
              </h3>
              <p className="ld-read">
                Press and hold any need and the map previews the room as if it
                were never said, live, then restores when you let go. The cost
                of a need becomes something you can look at instead of something
                to argue about. When nothing works for everyone, the ways out are
                counted, never blamed.
              </p>
            </div>
            <figure className="ld-shot">
              <img
                src="/landing/impasse-mobile.webp"
                width="430"
                height="932"
                alt="An impasse: the count block reads 0 still work of 40, 4 likely, 27 unsure, 1 unlikely. A chip offers plus 3 if lactose-free options went optional. Below, one way out: let lactose-free options be nice-to-have, 3 places come back."
                loading="lazy"
                decoding="async"
              />
            </figure>
          </article>

          <article className="ld-beat" data-side="text">
            <div className="ld-beat-copy">
              <h3 className="ld-h3">
                <Mark kind="private" /> A private condition, with a public
                effect.
              </h3>
              <p className="ld-read">
                The room always sees what a private need does to the count.
                It never sees what the need is, whose it is, or which places
                it removed. Both halves are the design: hiding the effect would
                be a lie, showing the reason would be a leak.
              </p>
            </div>
            <div className="ld-drawn" aria-hidden="true">
              <div className="ld-rows">
                <div className="need-row ld-row">
                  <Mark />
                  <span className="ld-row-label">vegetarian options · Sarah</span>
                  <span className="ld-row-delta">−4</span>
                </div>
                <div className="need-row ld-row" data-variant="private">
                  <Mark kind="private" />
                  <span className="ld-row-label ld-row-private">A private condition</span>
                  <span className="ld-row-delta">−2</span>
                  <span className="ld-chip" data-tone="scope">private</span>
                </div>
              </div>
              <div className="ld-count">
                <div className="count-block ld-count-block" data-state="works">
                  <span className="ld-count-big">6</span>
                  <span className="ld-count-word">still work</span>
                  <span className="ld-count-sub">of 21 · 3 unsure</span>
                </div>
              </div>
              <span className="ld-brief-note">What the room sees. The owner sees the condition itself.</span>
            </div>
          </article>

          <article className="ld-beat" data-side="text">
            <div className="ld-beat-copy">
              <h3 className="ld-h3">
                <Mark kind="busy" /> Your agent, in the page.
              </h3>
              <p className="ld-read">
                Say it in your own words and your agent turns it into typed
                needs. Ask a question and it reads the room and answers in a
                card, never a chat pane. Give it a condition to hold and it
                screens places for you without the room ever receiving the
                condition. While facts are being looked up, the places being
                checked wear a turning ring, and the need row says what it is
                doing.
              </p>
            </div>
            <figure className="ld-shot">
              <img
                src="/landing/pending-mobile.webp"
                width="430"
                height="932"
                alt="A need just said: the row reads checking places, the count block says checking for it, and several map dots wear a dashed ring while the lookup runs."
                loading="lazy"
                decoding="async"
              />
            </figure>
          </article>

          <article className="ld-beat" data-side="text">
            <div className="ld-beat-copy">
              <h3 className="ld-h3">
                <Mark kind="out" /> Look around. Bring more places in.
              </h3>
              <p className="ld-read">
                A room starts with forty places spread across the area. Pan
                anywhere and every place the map knows appears as a small dot.
                Tap one and bring it into the room; everyone sees it arrive.
                The organizer can move the search to wherever the group is
                looking.
              </p>
            </div>
            <figure className="ld-shot">
              <img
                src="/landing/explore-mobile.webp"
                width="430"
                height="932"
                alt="The map panned away from the ring. A small card names a place with the note everyone in the room will see it, and a button reads Bring into the room. A Search here chip sits on the map."
                loading="lazy"
                decoding="async"
              />
            </figure>
          </article>

          <article className="ld-beat" data-side="text">
            <div className="ld-beat-copy">
              <h3 className="ld-h3">
                <Mark /> Agree, then go.
              </h3>
              <p className="ld-read">
                Anyone can put a place forward. Everyone takes a stance; a
                standing veto blocks it, and the room says so without saying
                who. When all have accepted, the organizer commits with one
                gesture on the page. Then the composer becomes arrival: a way
                to get there and a one-tap handoff to the map app everyone
                already has.
              </p>
            </div>
            <div className="ld-drawn" aria-hidden="true">
              <div className="ld-rows">
                <div className="need-row ld-row">
                  <Mark kind="veto" />
                  <span className="ld-row-label">Someone said no to Mishba</span>
                </div>
                <div className="need-row ld-row" data-variant="applied">
                  <Mark />
                  <span className="ld-row-label">Settled: Café Einstein</span>
                  <span className="ld-chip" data-tone="works">Take me there</span>
                </div>
              </div>
            </div>
          </article>
        </section>

        {/* Unknown is a state you draw. */}
        <section className="ld-legend" aria-labelledby="ld-legend-h">
          <div className="ld-legend-copy">
          <h2 className="ld-label" id="ld-legend-h">
            Unsure is drawn, not dropped
          </h2>
          <p className="ld-read">
            The data behind any map is thin. In Berlin, OpenStreetMap answers
            about one question in six that a room asks about a place. So a
            missing fact is never a failure here: it is drawn hollow, counted
            apart, and looked up when it starts to matter. A guess with a reason
            is drawn dashed. Only a verified fact ever rules a place in or out.
          </p>
          <p className="ld-read ld-quiet">
            Nothing on these screens names a kind of place. The same room
            serves a park where the dog can run, an exhibition, a screening in
            a given language, a quiet room to work in, or dinner. Every control
            is generated from what the data can say about the places in view.
          </p>
          </div>
          <dl className="ld-marks">
            <div><dt><Mark /> works</dt><dd>clears every need the room has stated</dd></div>
            <div><dt><Mark kind="likely" /> likely</dt><dd>a guess with a reason leans yes; drawn dashed, counted apart</dd></div>
            <div><dt><Mark kind="unknown" /> unsure</dt><dd>nobody could confirm it; not a failure</dd></div>
            <div><dt><Mark kind="unlikely" /> unlikely</dt><dd>a guess leans no; still never ruled out</dd></div>
            <div><dt><Mark kind="out" /> ruled out</dt><dd>a verified fact contradicts a need</dd></div>
            <div><dt><Mark kind="private" /> private</dt><dd>a condition only its owner can read</dd></div>
            <div><dt><Mark kind="veto" /> a veto</dt><dd>someone said no to a proposal</dd></div>
            <div><dt><Mark kind="busy" /> being looked up</dt><dd>a fact is being fetched right now</dd></div>
          </dl>
        </section>
      </main>

      {/* ── The drawer opens ─────────────────────────────────────────── */}
      <div className="ld-ink" ref={inkRef}>
      <section
        className="ld-reveal"
        ref={reveal.ref as React.RefObject<HTMLElement>}
        data-open={reveal.open || undefined}
        aria-labelledby="ld-reveal-h"
      >
        <div className="ld-reveal-handle" aria-hidden="true">
          {"{ }"}
        </div>
        <div className="ld-reveal-body">
          <h2 className="ld-h2-ink" id="ld-reveal-h">
            Spokes is a hackathon entry.
          </h2>
          <p className="ld-read-ink">
            Built for the OpenAI WebMCP Challenge, which asked for an app that
            &ldquo;becomes meaningfully better when people and their agents can
            use it together.&rdquo; Everything above is the room. Everything
            below is what a protocol reader would want to see, and in the app it
            lives exactly here: behind the <code>{"{ }"}</code> drawer, never in
            the main interface.
          </p>
        </div>
      </section>

      <div className="ld-wire">
        <section className="ld-wire-section" aria-labelledby="ld-w1">
          <h2 className="ld-wire-h" id="ld-w1">
            WebMCP leverage
          </h2>
          <div className="ld-wire-grid">
            <div>
              <p className="ld-read-ink">
                Nineteen tools are registered imperatively on{" "}
                <code>document.modelContext</code> at page load, from the
                top-level document, as one static surface. ChatGPT&rsquo;s
                in-app browser binds tools at page level and may not observe a
                mid-conversation change, so nothing is registered late and
                nothing is phase-gated. Before the invite exchange completes,
                every tool answers with a structured <code>not_authenticated</code>{" "}
                result rather than failing.
              </p>
              <pre className="ld-code" aria-label="Tool registration shape">
                <code>{`document.modelContext.registerTool({
  name: "submit_requirement",
  description: "State a need for the room …",
  // TypeBox schema, closed enums, no actorId
  inputSchema: SubmitRequirementInput,
  annotations: {},
  execute: (args) =>
    run("SubmitRequirement", args),
});`}</code>
              </pre>
              <p className="ld-read-ink">
                A human gesture and a tool call compile to the same server
                command with the same validation, the same revision check and
                the same projection back to every viewer. The agent is a
                participant, not a scraper.
              </p>
            </div>
            <div className="ld-tools">
              <h3 className="ld-wire-sub">negotiation/v1 · 9</h3>
              <ul className="ld-tool-list">
                {NEGOTIATION_TOOLS.map(([name, kind]) => (
                  <li key={name}>
                    <code>{name}</code>
                    <span className="ld-tool-kind">{kind}</span>
                  </li>
                ))}
              </ul>
              <h3 className="ld-wire-sub">spatial-destination/v1 · 10</h3>
              <ul className="ld-tool-list">
                {SPATIAL_TOOLS.map(([name, kind]) => (
                  <li key={name}>
                    <code>{name}</code>
                    <span className="ld-tool-kind">{kind}</span>
                  </li>
                ))}
              </ul>
              <h3 className="ld-wire-sub">bound to no tool · 2</h3>
              <ul className="ld-tool-list" data-unbound>
                <li>
                  <code>CommitAgreement</code>
                  <span className="ld-tool-kind">page only</span>
                </li>
                <li>
                  <code>ConfirmPrivateRequest</code>
                  <span className="ld-tool-kind">page only</span>
                </li>
              </ul>
            </div>
          </div>

          <dl className="ld-facts">
            <div>
              <dt>Two protocols on one substrate</dt>
              <dd>
                WebMCP carries tool names and schemas. It does not define
                multi-party negotiation, privacy or maps. <code>negotiation/v1</code>{" "}
                owns identity, revisions, privacy tiers, stances, consent and
                agreement, and knows nothing about coordinates.{" "}
                <code>spatial-destination/v1</code> owns scope, stable place
                references, graded dossiers and navigation handoff, and compiles
                every action with negotiation meaning down to a negotiation
                command.
              </dd>
            </div>
            <div>
              <dt>The first call teaches both</dt>
              <dd>
                <code>sync_session</code> with no <code>sinceRevision</code>{" "}
                returns a capability manifest: protocol versions, allowed
                visibilities, the attribute vocabulary, the agreement rule, the
                caller&rsquo;s identity and authority. WebMCP has no
                application-protocol instruction channel, so the manifest is
                that channel. A committed hash of the manifest gates the build.
              </dd>
            </div>
            <div>
              <dt>Revision discipline</dt>
              <dd>
                Every mutation carries the revision the agent reasoned from. A
                stale one returns <code>sync_required</code> with a paged delta
                and a cursor, and that result is model input for the next round,
                never a licence for the runtime to replay the same arguments at
                a fresh revision. One mutating call per round. Idempotency keys
                make a retried request replay the recorded outcome instead of
                mutating twice.
              </dd>
            </div>
            <div>
              <dt>An agent can stage consent. It cannot grant it.</dt>
              <dd>
                Committing an agreement and applying a private grant beyond the
                delegated bound are commands with no tool route. Staging mints
                a 24-byte, single-use, 120-second nonce delivered only on the
                participant&rsquo;s own realtime channel, never in a tool result.
                The threat model is a prompt-injected model acting through the
                tool surface. Tool arguments never carry an actor id; identity
                comes from the page session.
              </dd>
            </div>
            <div>
              <figure className="ld-wire-shot">
                <img src="/landing/drawer-mobile.webp" width="430" height="932" loading="lazy" decoding="async" alt="The { } drawer: an ink slide-over with the connection state, the session, and timestamped wire lines in monospace." />
              </figure>
              <dt>Return, don&rsquo;t throw</dt>
              <dd>
                Rejected promises reach an agent with no detail, so every
                failure is a structured result with a recovery hint, and every
                result fits a 1,500-character budget by structural compaction
                that keeps the JSON valid and says what it omitted.
              </dd>
            </div>
          </dl>
        </section>

        <section className="ld-wire-section" aria-labelledby="ld-w2">
          <h2 className="ld-wire-h" id="ld-w2">
            Execution
          </h2>
          <div className="ld-numbers" role="list">
            <div role="listitem">
              <span className="ld-num">364</span>
              <span className="ld-num-l">automated tests</span>
              <span className="ld-num-s">222 unit · 128 three-user API · 14 browser</span>
            </div>
            <div role="listitem">
              <span className="ld-num">19</span>
              <span className="ld-num-l">tools, one command bus</span>
              <span className="ld-num-s">contract v3, manifest hash checked in CI</span>
            </div>
            <div role="listitem">
              <span className="ld-num">12,149</span>
              <span className="ld-num-l">places in the Berlin snapshot</span>
              <span className="ld-num-s">3,671 in San Francisco · in-process, 1–6 ms a query</span>
            </div>
            <div role="listitem">
              <span className="ld-num">0.69</span>
              <span className="ld-num-l">the most a model may ever be trusted</span>
              <span className="ld-num-s">verification starts at 0.70</span>
            </div>
          </div>

          <dl className="ld-facts">
            <div>
              <figure className="ld-wire-shot">
                <img src="/landing/roster-mobile.webp" width="430" height="932" loading="lazy" decoding="async" alt="The roster opened from the header: Alex, organizer, here now; Sarah, here now; Joe, not arrived. Below, three need rows, one of them a private condition." />
              </figure>
              <dt>Three privacy tiers, projected server-side</dt>
              <dd>
                <code>shared</code> reaches everyone. <code>application-private</code>{" "}
                is evaluated by the server and reaches peers only as an effect
                on the count. <code>agent-private</code> never reaches the
                server at all: the council asks the agent to screen, the agent
                answers with verdicts, and the room learns that a condition
                exists. Every event is stored once and projected per viewer at
                one of four levels, full, existence, aggregate, omitted. Nothing
                is hidden client-side; the server omits what a viewer may not
                see, and the test suite asserts that at the wire.
              </dd>
            </div>
            <div>
              <dt>Graded evidence</dt>
              <dd>
                A fact is one of five things, yes, likely, unlikely, no,
                unknown, and carries the confidence of whoever said it. Only the
                two verified statuses rule a place in or out. A likely fact is
                drawn dashed and counted apart; it never makes a room feasible
                and never rules a place out. Sources merge in a fixed order:
                the record, the place&rsquo;s own site, Wikidata, deterministic
                rules, a model, and finally what a person attested, which may
                dispute any of the above.
              </dd>
            </div>
            <div>
              <dt>Evidence-bounded inference</dt>
              <dd>
                A fast model may guess an attribute only from text the server
                supplies, and only by quoting it: a claim survives if its
                evidence span is at least twelve characters and two words and
                appears verbatim in the named source. Confidence is not the
                model&rsquo;s to set. It is clamped in code by where the
                evidence came from: 0.45 from a name and a category, 0.60 from a
                description or the site, 0.69 from a menu. All below the 0.70
                floor, so inference can only ever write likely or unlikely.
                Under strict-schema decoding the model&rsquo;s stated confidence
                collapsed to the cap every time; the span is the only signal
                with information in it. Given a name alone, it abstained.
              </dd>
            </div>
            <div>
              <dt>Facts change; verdicts expire</dt>
              <dd>
                Every path that changes a place&rsquo;s merged facts bumps its{" "}
                <code>mapRevision</code> in the same transaction. A private
                screening verdict records the revision it judged and is
                authoritative only while that matches; after a bump the place
                returns to unsure and the agent is asked again. Lookups
                broadcast what is pending and, only on a real change, which
                places moved.
              </dd>
            </div>
            <div>
              <dt>Reliability that was audited, then built</dt>
              <dd>
                Cursor-based catch-up bound to room, viewer and target revision;
                two watermarks, because an HTTP response is not proof the
                matching WebSocket frame arrived; per-room ordered broadcast; a
                heartbeat; an honest manifest that withdrew a capability nobody
                implemented. Seventeen of eighteen audit findings closed, each
                with a test.
              </dd>
            </div>
          </dl>
        </section>

        <section className="ld-wire-section" aria-labelledby="ld-w3">
          <h2 className="ld-wire-h" id="ld-w3">
            Potential impact
          </h2>
          <p className="ld-read-ink">
            Every group decides where to meet, and every group has at least one
            reason nobody wants to type into the chat. The negotiation layer is
            domain-blind by construction: it holds needs, effects, stances,
            consent and agreement, and treats the map as one typed payload. The
            same room serves a park, an exhibition, a screening, a place to
            work, or dinner, because no screen names a kind of place and every
            control comes from what the data can say. The two protocols are
            written to be lifted out: a negotiation core, a spatial domain, and
            adapters for whoever holds the facts.
          </p>
        </section>

        <section className="ld-wire-section" aria-labelledby="ld-w4">
          <h2 className="ld-wire-h" id="ld-w4">
            Creativity
          </h2>
          <ul className="ld-list-ink">
            <li>
              The map is the shared object, not a results list. Places settle
              where they stand; the camera is never taken from the user.
            </li>
            <li>
              Press-and-hold as a counterfactual: the room without a need,
              live, without a mode or a modal.
            </li>
            <li>
              Marks, not glyphs. Works, likely, unsure, unlikely, out, private,
              veto and busy are drawn with the map&rsquo;s own dots, in fill,
              border and size, so a row reads without colour.
            </li>
            <li>
              An agent that holds a condition the server never receives, and a
              room that still counts it.
            </li>
            <li>
              The <code>{"{ }"}</code> drawer: everything protocol-shaped lives
              behind one small, unstyled-looking handle. This page is that
              handle, opened.
            </li>
          </ul>
        </section>

        <section className="ld-wire-section" aria-labelledby="ld-w5">
          <h2 className="ld-wire-h" id="ld-w5">
            What it does not claim
          </h2>
          <ul className="ld-list-ink">
            <li>
              No cryptographic secrecy from the operator. Application-private
              needs are evaluated by the server; small-group inference from
              observed outcome changes is possible and is documented.
            </li>
            <li>
              The consent nonce binds to a page session, not to a human
              gesture. It closes blind replay from a bearer token; it does not
              prove someone clicked.
            </li>
            <li>
              Realtime fan-out and presence are single-process. No claim of
              horizontal scale.
            </li>
            <li>
              Eleven attribute values in the rehearsed demo room are a labelled
              curated overlay, <code>curated:demo-2026-08</code>, so the scripted
              impasse is deterministic. Every other fact is the record&rsquo;s.
            </li>
            <li>
              The website fetcher resolves a host before fetching by name; a
              DNS-rebinding window remains.
            </li>
            <li>
              Disclosure ladder beyond level zero, transit routing, meeting
              points and time windows are scoped out and named in the docs.
            </li>
          </ul>
        </section>

        <section className="ld-wire-section" aria-labelledby="ld-w6">
          <h2 className="ld-wire-h" id="ld-w6">
            Where the facts come from
          </h2>
          <table className="ld-table">
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Licence</th>
                <th scope="col">Gives</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>OpenStreetMap, whole-city snapshots</td>
                <td>ODbL 1.0</td>
                <td>places, accessibility and diet tags, hours, menu and site links, Wikidata ids</td>
              </tr>
              <tr>
                <td>The place&rsquo;s own website</td>
                <td>the venue&rsquo;s; parsed facts only, robots honoured, cached 7 days</td>
                <td>schema.org facts, a menu link, a one-line description</td>
              </tr>
              <tr>
                <td>Wikidata</td>
                <td>CC0</td>
                <td>description, article, official site, awards on record</td>
              </tr>
              <tr>
                <td>OpenFreeMap tiles</td>
                <td>keyless</td>
                <td>the basemap</td>
              </tr>
            </tbody>
          </table>
          <p className="ld-read-ink ld-small">
            No third-party call is ever made from a participant&rsquo;s browser;
            a place API called from the page would hand every person&rsquo;s IP
            and query to a company with no agreement in place. Google Places,
            Yelp, Foursquare and HERE were evaluated and declined on caching and
            display terms. A self-hosted Overpass was built, measured at 4.2 GB
            on disk and a third of a second a query, and replaced by an
            in-process snapshot that answers in milliseconds.
          </p>
        </section>

        <section className="ld-wire-section ld-wire-links" aria-label="Links">
          <a className="ld-link-ink" href={REPO}>
            Source on GitHub
          </a>
          <a className="ld-link-ink" href={`${DOCS}/protocols/NEGOTIATION-PROTOCOL.md`}>
            negotiation/v1
          </a>
          <a className="ld-link-ink" href={`${DOCS}/protocols/SPATIAL-PROTOCOL.md`}>
            spatial-destination/v1
          </a>
          <a className="ld-link-ink" href={`${DOCS}/protocols/INTERACTION-AND-BINDING.md`}>
            WebMCP binding
          </a>
          <a className="ld-link-ink" href={`${DOCS}/KNOWN-LIMITATIONS.md`}>
            Known limitations
          </a>
          <button type="button" className="btn ld-btn-ink" onClick={onStart}>
            Start a room
          </button>
        </section>
      </div>
      </div>

      <footer className="ld-foot">
        <Wordmark />
        <p>
          Code MIT. Place data © OpenStreetMap contributors, ODbL. Wikidata
          CC0. Tiles by OpenFreeMap. Fonts Bricolage Grotesque and IBM Plex
          Mono, OFL, self-hosted.
        </p>
      </footer>
    </div>
  );
}
