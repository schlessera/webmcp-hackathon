/** Lossless JSON Schema serialization for discovery. Server validators retain
 * the original TypeBox schemas. Only equivalent literal unions and repeated
 * schema objects change representation; no constraints are removed. */
export function compactSchema(schema: unknown): Record<string, unknown> {
  function enums(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(enums);
    if (!value || typeof value !== "object") return value;
    const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, enums(item)]));
    const union = result.anyOf;
    if ((result.type === undefined || result.type === "string") && result.enum === undefined &&
      Array.isArray(union) && union.length > 0 && union.every((part) =>
      part?.type === "string" && typeof part.const === "string" &&
      Object.keys(part).every((key) => key === "type" || key === "const"),
    )) {
      delete result.anyOf;
      result.type = "string";
      result.enum = [...new Set(union.map((part) => part.const))];
    }
    return result;
  }
  const root = enums(schema) as Record<string, unknown>;
  // Existing references have their own resolution scope; leave them alone.
  const serialized = JSON.stringify(root);
  if (serialized.includes('"$ref"') || serialized.includes('"$id"') || root.$defs) return root;
  const counts = new Map<string, number>();
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value)) {
      const item = value as Record<string, unknown>;
      const key = JSON.stringify(item);
      if (key.length >= 350 && (item.type || item.anyOf)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    Object.values(value).forEach(visit);
  }
  visit(root);
  const definitions: Record<string, unknown> = {};
  const names = new Map<string, string>();
  function references(value: unknown, definition?: string): unknown {
    if (Array.isArray(value)) return value.map((item) => references(item));
    if (!value || typeof value !== "object") return value;
    const key = JSON.stringify(value);
    if (key !== definition && (counts.get(key) ?? 0) > 1) {
      let name = names.get(key);
      if (!name) {
        name = `schema${names.size + 1}`;
        names.set(key, name);
        definitions[name] = references(value, key);
      }
      return { $ref: `#/$defs/${name}` };
    }
    return Object.fromEntries(Object.entries(value).map(([k, item]) => [k, references(item)]));
  }
  const result = references(root) as Record<string, unknown>;
  return names.size ? { ...result, $defs: definitions } : result;
}
