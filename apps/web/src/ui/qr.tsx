import qrcode from "qrcode-generator";

/**
 * A link, as something you can point a phone at.
 *
 * Drawn as one SVG path of dark modules on a transparent ground, so it
 * inherits the surface it sits on and needs no colour of its own beyond
 * `currentColor` — which is how it survives both themes without a token
 * dedicated to it (CLAUDE.md §3).
 *
 * The quiet zone is not decoration: scanners need four modules of clear
 * space around the symbol, and a QR pushed flush to its container's edge
 * often will not read at all.
 */

const QUIET_MODULES = 4;

interface Props {
  /** What the code encodes. Kept short: a longer URL is a denser symbol. */
  value: string;
  /** Drawn edge, in CSS pixels. */
  size?: number;
  /** For screen readers, which cannot point a phone at anything. */
  label: string;
}

export function Qr({ value, size = 176, label }: Props) {
  // Type 0 lets the library pick the smallest version that fits; level M
  // survives the smudges and screen glare of a code read off a phone held
  // across a table.
  const code = qrcode(0, "M");
  code.addData(value);
  code.make();

  const count = code.getModuleCount();
  const span = count + QUIET_MODULES * 2;

  let path = "";
  for (let row = 0; row < count; row += 1) {
    for (let column = 0; column < count; column += 1) {
      if (!code.isDark(row, column)) continue;
      path += `M${column + QUIET_MODULES} ${row + QUIET_MODULES}h1v1h-1z`;
    }
  }

  return (
    <svg
      className="qr"
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${span} ${span}`}
      shapeRendering="crispEdges"
      data-testid="invite-qr"
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}
