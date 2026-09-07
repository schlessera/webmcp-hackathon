import { useEffect, useRef, useState } from "react";
import { Wordmark } from "./Wordmark.tsx";
import "../landing.css";

const REPO = "https://github.com/schlessera/webmcp-hackathon";
const DOCS = `${REPO}/blob/main/docs`;

interface Props { onStart(): void }

function Mark({ kind }: { kind?: string }) {
  return <span className="mark" data-mark={kind} aria-hidden="true" />;
}

function Screenshot({ name, alt, caption }: { name: string; alt: string; caption: string }) {
  return (
    <figure className="ld-shot">
      <a href={`/landing/${name}.webp`} target="_blank" rel="noreferrer" aria-label={`Enlarge screenshot: ${caption} (opens in a new tab)`}>
        <img src={`/landing/${name}.webp`} width="430" height="932" alt={alt} loading="lazy" decoding="async" />
      </a>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

/** Keep the sticky wordmark on the same ground as the technical section. */
function useInkBar(scrollRef: React.RefObject<HTMLDivElement>, inkRef: React.RefObject<HTMLElement>) {
  const [ink, setInk] = useState(false);
  useEffect(() => {
    const root = scrollRef.current;
    const section = inkRef.current;
    if (!root || !section) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const bar = root.querySelector(".ld-top")?.getBoundingClientRect().bottom ?? 64;
      const bounds = section.getBoundingClientRect();
      setInk(bounds.top <= bar && bounds.bottom > bar);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(check); };
    root.addEventListener("scroll", onScroll, { passive: true });
    const resize = new ResizeObserver(check);
    resize.observe(root);
    check();
    return () => {
      root.removeEventListener("scroll", onScroll);
      resize.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollRef, inkRef]);
  return ink;
}

export function Landing({ onStart }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inkRef = useRef<HTMLElement>(null);
  const barInk = useInkBar(scrollRef, inkRef);
  useEffect(() => {
    const revealPrivacy = () => {
      if (window.location.hash !== "#privacy-details") return;
      const details = document.getElementById("privacy-details");
      if (!(details instanceof HTMLDetailsElement)) return;
      details.open = true;
      details.scrollIntoView({ block: "start" });
      details.querySelector("summary")?.focus({ preventScroll: true });
    };
    window.addEventListener("hashchange", revealPrivacy);
    revealPrivacy();
    return () => window.removeEventListener("hashchange", revealPrivacy);
  }, []);
  return (
    <div className="landing" data-testid="landing" ref={scrollRef}>
      <a className="ld-skip" href="#landing-main">Skip to content</a>
      <header className="ld-top" data-ink={barInk || undefined}>
        <a className="ld-brand" href="/" aria-label="Spokes home"><Wordmark /></a>
        <nav className="ld-top-actions" aria-label="Page">
          <a className="ld-link ld-how-link" href="#how-it-works">How it works</a>
          <a className="ld-link ld-agent-link" href="#for-agents" aria-label="For agents and builders"><span aria-hidden="true">{"{ }"}</span><span className="ld-agent-label"> For agents</span></a>
          <button type="button" className="btn" data-tone="works" data-testid="landing-start" onClick={onStart}>Start a room</button>
        </nav>
      </header>
      <main id="landing-main" tabIndex={-1}>
        <section className="ld-hero ld-wrap" aria-labelledby="ld-title">
          <div className="ld-hero-intro">
            <h1 id="ld-title">Decide together,<br />go together.</h1>
            <div className="ld-hero-copy">
              <p className="ld-lede">A shared map for finding a place that works for everyone. Bring your needs, your people, and your agents. Make a plan together.</p>
              <div className="ld-cta">
                <button type="button" className="btn ld-btn-big" data-tone="works" onClick={onStart}>Start a room</button>
                <a className="ld-link" href="#how-it-works">See how it works <span aria-hidden="true">↓</span></a>
              </div>
              <p className="ld-note">No account needed. Start with what you want to do.</p>
            </div>
          </div>
          <figure className="ld-hero-fig">
            <div className="ld-plate">
              <picture>
                <source media="(max-width: 599px)" srcSet="/landing/hero-mobile.webp" width="430" height="932" />
                <img src="/landing/hero-desktop.webp" width="1440" height="900" alt="A shared Berlin map with four places still working for the group, shared needs, and the effect of a private condition." loading="eager" fetchPriority="high" decoding="async" />
              </picture>
            </div>
            <figcaption>Everyone&rsquo;s needs, in the same place.</figcaption>
          </figure>
        </section>

        <section className="ld-intro ld-wrap" aria-labelledby="ld-intro-title">
          <h2 id="ld-intro-title">Everyone has a need.<br />Not every reason needs an audience.</h2>
          <p className="ld-read">A group plan has a lot to hold: what matters to each person, what is still unknown, and who has said yes. Spokes keeps it together on one map. You can take part now or catch up later, with private needs still shaping the decision.</p>
        </section>

        <section className="ld-journey ld-wrap" aria-labelledby="how-it-works">
          <h2 id="how-it-works" tabIndex={-1}>From &ldquo;where?&rdquo; to &ldquo;see you there.&rdquo;</h2>
          <article className="ld-beat">
            <div className="ld-beat-copy">
              <h3><span className="ld-step">1.</span> Start with the whole plan.</h3>
              <p className="ld-read">Say what you want to do in your own words. Spokes turns it into a plan of up to three stops. Review the steps, change the kind of place, and leave out any needs it read wrong before opening the room.</p>
              <p className="ld-read">Invite each person with their own link or QR code. Everyone joins the same room, with their own say in what happens next.</p>
              <p className="ld-margin-note">One stop or several. Each decision gives the next one a starting point.</p>
            </div>
            <Screenshot name="planning-mobile" alt="The current plan review, with two ordered stops and needs that can be removed before opening the room." caption="Review the plan before anyone joins." />
          </article>
          <article className="ld-beat">
            <div className="ld-beat-copy">
              <h3><span className="ld-step">2.</span> Say what matters. Choose who sees.</h3>
              <p className="ld-read">Add a need directly, or ask the built-in agent for help when it is available. Choose how much to share before you send it.</p>
              <dl className="ld-scopes">
                <div><dt><Mark /> Shared</dt><dd>Everyone in the room can read the need.</dd></div>
                <div><dt><Mark kind="private" /> Private</dt><dd>Spokes checks it. The group sees its effect without reading the need.</dd></div>
                <div><dt><Mark kind="silent" /> Agent only</dt><dd>Your agent screens places. The condition itself stays out of the shared room record.</dd></div>
              </dl>
              <a className="ld-link" href="#privacy-details">How private information is handled</a>
            </div>
            <Screenshot name="scopes-mobile" alt="A live room with the composer visibility menu open, offering Shared, Private, and Agent only." caption="The visibility choice belongs to you." />
          </article>
          <article className="ld-beat">
            <div className="ld-beat-copy">
              <h3><span className="ld-step">3.</span> Find a way forward, together.</h3>
              <p className="ld-read">As needs arrive, places update where they stand. Hold a need to preview the map without it, then release to return. When no place is confirmed to fit, Spokes shows which changes could bring places back, and how many.</p>
              <p className="ld-read">You decide whether to change your need; the organizer handles changes to the search area. You can also explore the map and bring more places into the room.</p>
              <p className="ld-margin-note">See what a change would do before deciding to make it.</p>
            </div>
            <Screenshot name="impasse-mobile" alt="No place is confirmed yet. An organizer-only offer widens the search from 800 metres to 1.2 kilometres and brings back four places." caption="A way out, with a count and a choice." />
          </article>
          <article className="ld-beat">
            <div className="ld-beat-copy">
              <h3><span className="ld-step">4.</span> Agree on a place. Then keep going.</h3>
              <p className="ld-read">Anyone can put a place forward. Everyone can accept, abstain, or veto. Once everyone is ready and has responded, with no veto standing, the organizer confirms the decision on the page.</p>
              <p className="ld-read">Another stop planned? The next search starts near the place you just agreed on. After the final stop is settled, choose how to travel and open directions in your map app.</p>
              <p className="ld-margin-note">Your agent can prepare the decision. The final confirmation stays on the page.</p>
            </div>
            <Screenshot name="agreement-mobile" alt="The current app after the group has agreed on a place, with arrival choices and a navigation handoff." caption="An agreed place, and a way to get there." />
          </article>
        </section>

        <section className="ld-evidence ld-wrap" aria-labelledby="ld-evidence-title">
          <div className="ld-evidence-copy">
            <h2 id="ld-evidence-title">Know what fits.<br />See what is still unsure.</h2>
            <p className="ld-read">Open a place to see how it meets the group&rsquo;s needs and where its facts came from. Missing information stays visible. Look it up, follow the source, or confirm a fact for the room when you know.</p>
            <dl className="ld-marks">
              <div><dt><Mark /> Works</dt><dd>Meets the active must-haves on confirmed evidence.</dd></div>
              <div><dt><Mark kind="likely" /> Likely</dt><dd>Evidence leans yes. Included in the headline count, marked as a guess.</dd></div>
              <div><dt><Mark kind="unknown" /> Unsure</dt><dd>A fact is missing. Kept visible and counted separately.</dd></div>
            </dl>
            <p className="ld-note">Guesses stay marked as guesses. Agreement still needs the group&rsquo;s responses and the organizer&rsquo;s confirmation.</p>
          </div>
          <Screenshot name="details-mobile" alt="A place's current details with evidence for the group's needs and controls to confirm or rule out a fact." caption="The evidence behind a place on the map." />
        </section>

        <section className="ld-ink" ref={inkRef} aria-labelledby="for-agents">
          <div className="ld-wire ld-wrap">
            <div className="ld-wire-intro">
              <span className="ld-wire-handle" aria-hidden="true">{"{ }"}</span>
              <div>
                <h2 id="for-agents" tabIndex={-1}>Your agent gets a seat at the map.</h2>
                <p className="ld-read">Through WebMCP, your personal agent can read the live room, state your needs, investigate places, and act for you. It works with the same places and decisions you see on the page.</p>
              </div>
            </div>
            <dl className="ld-wire-points">
              <div><dt>One room, two ways to act</dt><dd>Human actions and agent tool calls use the same commands and checks. Each participant receives the view they are allowed to see.</dd></div>
              <div><dt>Your agent acts for you</dt><dd>It can bring your context to the decision and catch up on changes. It cannot change another person&rsquo;s needs or grant their consent.</dd></div>
              <div><dt>A decision you confirm</dt><dd>Agents can stage an agreement or a private adjustment. Final agreement and private grants beyond delegated authority require confirmation on the page.</dd></div>
            </dl>
            <div className="ld-wire-foot">
              <p>Built for the OpenAI WebMCP Challenge. Open source, with the protocols and limitations documented.</p>
              <nav aria-label="Technical documentation">
                <a href={REPO}>Source on GitHub</a>
                <a href={`${DOCS}/protocols/INTERACTION-AND-BINDING.md`}>WebMCP binding</a>
                <a href={`${DOCS}/KNOWN-LIMITATIONS.md`}>Known limitations</a>
              </nav>
            </div>
          </div>
        </section>

        <section className="ld-questions ld-wrap" aria-labelledby="ld-questions-title">
          <h2 id="ld-questions-title">Before you start</h2>
          <div className="ld-answers">
            <details open>
              <summary>Where can you try it?</summary>
              <p>This is an interactive demo with prepared place data for Berlin Mitte and San Francisco SoMa. Describe your plan first; the demo region choice comes after you review it. Place information can be incomplete or out of date.</p>
            </details>
            <details>
              <summary>Do you need an account or an AI agent?</summary>
              <p>No account or external agent is needed to use the map and take part in a room. Built-in language help depends on the demo&rsquo;s AI service being available. Connecting your own agent requires WebMCP support in your browser.</p>
              <a href="https://developer.chrome.com/docs/ai/webmcp">Check browser requirements</a>
            </details>
            <details>
              <summary>How do invite links work?</summary>
              <p>Create a separate invite for each person. An unused link expires after one hour; once claimed, it belongs to that person&rsquo;s browser and is their way back in. An invite from someone else opens their room directly.</p>
            </details>
            <details id="privacy-details">
              <summary>What does &ldquo;private&rdquo; mean here?</summary>
              <p>A private need is processed by Spokes, but its text is omitted from other participants&rsquo; views. Its effects on the count and places remain visible, so someone may still infer information from what changes.</p>
              <p>For agent-only needs, the condition text stays out of the room record. The built-in agent processes it in server memory and sends it to the configured AI provider for screening. An external personal agent can hold the condition outside Spokes and return its verdicts.</p>
            </details>
          </div>
        </section>

        <section className="ld-close ld-wrap" aria-labelledby="ld-close-title">
          <div><h2 id="ld-close-title">Give the plan a place to happen.</h2><p className="ld-read">Start a room. Bring your people. Find your way together.</p></div>
          <button type="button" className="btn ld-btn-big" data-tone="works" onClick={onStart}>Start a room</button>
        </section>
      </main>
      <footer className="ld-foot ld-wrap">
        <a className="ld-brand" href="/" aria-label="Spokes home"><Wordmark /></a>
        <p>Code MIT. Place data © OpenStreetMap contributors, ODbL. Wikidata CC0. Map tiles by OpenFreeMap. Bricolage Grotesque and IBM Plex Mono, OFL.</p>
        <a className="ld-link" href={REPO}>Source</a>
      </footer>
    </div>
  );
}
