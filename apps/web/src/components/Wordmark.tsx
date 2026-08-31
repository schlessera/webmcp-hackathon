/** Hub-and-spokes glyph: people converging on one point. */
export function Wordmark() {
  return (
    <span className="wordmark" data-testid="wordmark">
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <g stroke="#4735d8" strokeWidth="1.8" strokeLinecap="round">
          <line x1="11" y1="11" x2="11" y2="2.4" />
          <line x1="11" y1="11" x2="18.4" y2="6.7" />
          <line x1="11" y1="11" x2="18.4" y2="15.3" />
          <line x1="11" y1="11" x2="11" y2="19.6" />
          <line x1="11" y1="11" x2="3.6" y2="15.3" />
          <line x1="11" y1="11" x2="3.6" y2="6.7" />
        </g>
        <circle cx="11" cy="11" r="3.4" fill="#4735d8" />
        <circle cx="11" cy="2.4" r="1.6" fill="#0e7a63" />
        <circle cx="18.4" cy="6.7" r="1.6" fill="#b26205" />
        <circle cx="18.4" cy="15.3" r="1.6" fill="#7c3aed" />
        <circle cx="11" cy="19.6" r="1.6" fill="#c22f3d" />
        <circle cx="3.6" cy="15.3" r="1.6" fill="#b8860b" />
        <circle cx="3.6" cy="6.7" r="1.6" fill="#23252d" />
      </svg>
      Spokes
    </span>
  );
}
