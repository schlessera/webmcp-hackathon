/**
 * R14: model tool output must remain valid JSON after compaction. Generic
 * string slicing can cut an escape sequence or object in half, so values are
 * pruned structurally and receive an explicit omission marker.
 */

const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

function prune(
  value: unknown,
  arrayLimit: number,
  stringLimit: number,
  depth = 0,
): unknown {
  if (typeof value === "string") {
    return value.length <= stringLimit ? value : `${value.slice(0, stringLimit - 1)}…`;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return "[nested value omitted]";
  if (Array.isArray(value)) {
    return value.slice(0, arrayLimit).map((item) =>
      prune(item, arrayLimit, stringLimit, depth + 1),
    );
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 30)
      .map(([key, item]) => [key, prune(item, arrayLimit, stringLimit, depth + 1)]),
  );
}

export function serializeToolOutput(value: unknown, maxBytes = 6000): string {
  const raw = JSON.stringify(value ?? null);
  if (bytes(raw) <= maxBytes) return raw;

  for (const [arrayLimit, stringLimit] of [
    [8, 320],
    [4, 200],
    [2, 120],
    [1, 80],
    [0, 48],
  ] as const) {
    const compacted = prune(value, arrayLimit, stringLimit);
    const object =
      compacted && typeof compacted === "object" && !Array.isArray(compacted)
        ? (compacted as Record<string, unknown>)
        : { value: compacted };
    const withoutCount = {
      ...object,
      truncated: true,
      omitted: { bytes: 0 },
    };
    const provisional = JSON.stringify(withoutCount);
    const encoded = JSON.stringify({
      ...withoutCount,
      omitted: { bytes: Math.max(1, bytes(raw) - bytes(provisional)) },
    });
    if (bytes(encoded) <= maxBytes) return encoded;
  }

  return JSON.stringify({
    truncated: true,
    omitted: { bytes: bytes(raw) },
  });
}
