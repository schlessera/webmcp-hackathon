import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ERROR_CODES } from "./errors.ts";
import { CAPABILITY_MANIFEST } from "./manifest.ts";
import { TOOLS } from "./tools.ts";
import { COMMAND_SCHEMAS } from "./commands.ts";
import { PROTOCOL_VERSIONS, TOOL_CONTRACT_VERSION } from "./versions.ts";

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalStringify(
            (value as Record<string, unknown>)[k],
          )}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

type ResultSchema = Record<string, unknown>;

/**
 * R18: derive runtime result schemas from the live exported response/message
 * types. The old hand-copied field arrays silently missed optional fields;
 * changing envelope.ts or realtime.ts now changes this hash automatically.
 */
function buildResultSchemas(): Record<string, ResultSchema> {
  const rootTypes = new Set([
    "ToolResult",
    "SyncSessionResponse",
    "SpatialContextResponse",
    "InspectCandidatesResponse",
    "PrepareNavigationResponse",
    "ExplorePlacesResult",
    "ClientMessage",
    "ServerMessage",
  ]);
  const files = ["envelope.ts", "realtime.ts"].map((name) =>
    fileURLToPath(new URL(`./${name}`, import.meta.url)),
  );
  const program = ts.createProgram(files, {
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  const checker = program.getTypeChecker();

  const schemaFor = (
    type: ts.Type,
    stack = new Set<ts.Type>(),
  ): ResultSchema => {
    if (type.isUnion()) {
      const withoutUndefined = type.types.filter(
        (part) => !(part.flags & ts.TypeFlags.Undefined),
      );
      if (withoutUndefined.length !== type.types.length) {
        return withoutUndefined.length === 1
          ? schemaFor(withoutUndefined[0], stack)
          : {
              anyOf: withoutUndefined.map((part) =>
                schemaFor(part, new Set(stack)),
              ),
            };
      }
      return { anyOf: type.types.map((part) => schemaFor(part, new Set(stack))) };
    }
    if (type.isStringLiteral()) return { type: "string", const: type.value };
    if (type.isNumberLiteral()) return { type: "number", const: type.value };
    if (type.flags & ts.TypeFlags.StringLike) return { type: "string" };
    if (type.flags & ts.TypeFlags.NumberLike) return { type: "number" };
    if (type.flags & ts.TypeFlags.BooleanLike) return { type: "boolean" };
    if (type.flags & ts.TypeFlags.Null) return { type: "null" };
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
    if (checker.isTupleType(type)) {
      const parts = checker.getTypeArguments(type as ts.TypeReference);
      return { type: "array", items: { anyOf: parts.map((part) => schemaFor(part, new Set(stack))) } };
    }
    if (checker.isArrayType(type)) {
      const [item = checker.getAnyType()] = checker.getTypeArguments(type as ts.TypeReference);
      return { type: "array", items: schemaFor(item, new Set(stack)) };
    }
    if (!(type.flags & ts.TypeFlags.Object)) return {};
    if (stack.has(type)) return { recursive: true };
    stack.add(type);
    const properties: Record<string, ResultSchema> = {};
    const required: string[] = [];
    for (const property of checker.getPropertiesOfType(type)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (!declaration) continue;
      properties[property.name] = schemaFor(
        checker.getTypeOfSymbolAtLocation(property, declaration),
        new Set(stack),
      );
      if (!(property.flags & ts.SymbolFlags.Optional)) required.push(property.name);
    }
    const stringIndex = checker.getIndexTypeOfType(type, ts.IndexKind.String);
    return {
      type: "object",
      properties,
      required: required.sort(),
      additionalProperties: stringIndex ? schemaFor(stringIndex, new Set(stack)) : false,
    };
  };

  const schemas: Record<string, ResultSchema> = {};
  for (const file of files) {
    const source = program.getSourceFile(file)!;
    for (const statement of source.statements) {
      if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) continue;
      if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if (!rootTypes.has(statement.name.text)) continue;
      const symbol = checker.getSymbolAtLocation(statement.name);
      if (!symbol) continue;
      schemas[statement.name.text] = schemaFor(checker.getDeclaredTypeOfSymbol(symbol));
    }
  }
  return schemas;
}

export const RESULT_SCHEMAS = buildResultSchemas();

/**
 * The canonical contract manifest (Gate 2): everything whose change must bump
 * toolContractVersion. CI fails when the hash changes without a bump.
 */
export function contractManifestObject() {
  return {
    toolContractVersion: TOOL_CONTRACT_VERSION,
    protocols: PROTOCOL_VERSIONS,
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations,
    })),
    commands: COMMAND_SCHEMAS,
    errorCodes: ERROR_CODES,
    capabilityManifest: CAPABILITY_MANIFEST,
    results: RESULT_SCHEMAS,
  };
}

export async function contractHash(): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256")
    .update(canonicalStringify(contractManifestObject()))
    .digest("hex");
}
