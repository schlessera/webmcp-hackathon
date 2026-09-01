# Bricolage Grotesque — self-hosting

The display family. Used for anything that **names or counts**: room title,
place names on stickers, the count block, section labels, primary buttons.
Body text and explanations use the system sans stack; numerals-in-context and
the `{ }` drawer use IBM Plex Mono.

## Get the files

Bricolage Grotesque is SIL Open Font License 1.1 — free to self-host and ship.

- Source: <https://github.com/ateliertriay/bricolage>
- Variable font, weight axis 200–800. We use **700** and **800**.

Download `BricolageGrotesque[opsz,wdth,wght].ttf` and subset it — the full
variable font is ~250 KB and we need one axis and Latin only:

```sh
pip install fonttools brotli

pyftsubset "BricolageGrotesque[opsz,wdth,wght].ttf" \
  --output-file="bricolage-grotesque-subset.woff2" \
  --flavor=woff2 \
  --layout-features="kern,liga,tnum" \
  --unicodes="U+0000-00FF,U+2000-206F,U+2190-21BB,U+2212,U+2713" \
  --variations="wght=700:800" \
  --desubroutinize
```

Keep `tnum` — the count block and deltas need tabular numerals so figures
don't jitter as they change.

Place the result at `apps/web/public/fonts/bricolage-grotesque-subset.woff2`.

## Declare it

```css
@font-face {
  font-family: 'Bricolage Grotesque';
  src: url('/fonts/bricolage-grotesque-subset.woff2') format('woff2-variations');
  font-weight: 700 800;
  font-display: swap;
  font-style: normal;
}
```

`font-display: swap` matters here: the fallback is a system sans at similar
metrics, so a swap is a small reflow, whereas a block is a blank count block
on a screen whose whole job is to show a number.

## Fallback stack

Already in `tokens.css`:

```css
--spoke-font-display: 'Bricolage Grotesque', system-ui, -apple-system, 'Segoe UI', sans-serif;
```

The design degrades acceptably without it — tighten `letter-spacing` to
`-.02em` on the count block if the fallback renders wide.

## IBM Plex Mono

Same treatment, weights 500–700, or accept the system mono fallback. It only
appears in small numerals and the diagnostics drawer, so it is the lower
priority of the two.

## Attribution

Both fonts are OFL. Include their license files alongside the woff2 in
`public/fonts/`.
