/**
 * Hub-and-spokes glyph: people converging on one point. The outer dots use
 * the per-person identity tokens (never a semantic colour — `--spoke-act` is
 * about authorship, not identity, CLAUDE.md §2).
 */
export function Wordmark({ withText = true }: { withText?: boolean }) {
  return (
    <>
      <svg
        className="wordmark-glyph"
        width="22"
        height="22"
        viewBox="0 0 22 22"
        aria-hidden="true"
      >
        <g
          stroke="var(--spoke-ink)"
          strokeWidth="1.8"
          strokeLinecap="round"
          opacity="0.55"
        >
          <line x1="11" y1="11" x2="11" y2="2.4" />
          <line x1="11" y1="11" x2="18.4" y2="6.7" />
          <line x1="11" y1="11" x2="18.4" y2="15.3" />
          <line x1="11" y1="11" x2="11" y2="19.6" />
          <line x1="11" y1="11" x2="3.6" y2="15.3" />
          <line x1="11" y1="11" x2="3.6" y2="6.7" />
        </g>
        <circle cx="11" cy="11" r="3.4" fill="var(--spoke-ink)" />
        <circle cx="11" cy="2.4" r="1.6" fill="var(--spoke-person-1)" />
        <circle cx="18.4" cy="6.7" r="1.6" fill="var(--spoke-person-2)" />
        <circle cx="18.4" cy="15.3" r="1.6" fill="var(--spoke-person-3)" />
        <circle cx="11" cy="19.6" r="1.6" fill="var(--spoke-person-4)" />
        <circle cx="3.6" cy="15.3" r="1.6" fill="var(--spoke-person-5)" />
        <circle cx="3.6" cy="6.7" r="1.6" fill="var(--spoke-ink-ghost)" />
      </svg>
      {withText && <span data-testid="wordmark">Spokes</span>}
    </>
  );
}
