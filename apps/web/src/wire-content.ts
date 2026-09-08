import type { ProjectionLevel, WireAgentCall } from "@webmcp-hackathon/contracts";
import type { WireEvent } from "./wire-store.ts";

/** Page-local content, never exported. Only explicit viewer-authorized fields;
 * no tool bodies, approval IDs, raw socket payloads or held conditions. */
export interface WireContent {
  conversation?: {
    scope: "shared" | "application-private";
    input: string;
    reply?: string;
    intent?: string;
    needs?: string[];
    choices?: string[];
    approval?: string;
    failure?: string;
    /** Undefined means this build did not report tool calls. [] means none. */
    calls?: WireAgentCall[];
  };
  events?: Array<{ type: string; text: string; revision: number; level: ProjectionLevel }>;
  omittedEvents?: number;
  omittedCalls?: number;
  shortened?: boolean;
}

export const WIRE_CONTENT_TEXT_LIMIT = 4096;
export const WIRE_CONTENT_ITEM_LIMIT = 32;

/** Whitelist and cap at the store boundary, including patches and fixtures. */
export function boundWireContent(content: WireContent): WireContent {
  let shortened = !!content.shortened;
  const text = (value: string, limit = WIRE_CONTENT_TEXT_LIMIT) => {
    if (value.length > limit) shortened = true;
    return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
  };
  const list = (values?: string[]) => {
    if (!values) return undefined;
    if (values.length > WIRE_CONTENT_ITEM_LIMIT) shortened = true;
    return values.slice(0, WIRE_CONTENT_ITEM_LIMIT).map((v) => text(v));
  };
  const c = content.conversation;
  const conversation = c && (c.scope === "shared" || c.scope === "application-private") ? {
    scope: c.scope, input: text(c.input),
    ...(c.reply !== undefined ? { reply: text(c.reply) } : {}),
    ...(c.intent ? { intent: text(c.intent, 80) } : {}),
    needs: list(c.needs), choices: list(c.choices),
    ...(c.approval ? { approval: text(c.approval) } : {}),
    ...(c.failure ? { failure: text(c.failure, 160) } : {}),
    calls: c.calls?.slice(0, WIRE_CONTENT_ITEM_LIMIT).map((call) => ({
      tool: text(call.tool, 80), round: call.round, ok: call.ok,
      ms: Number.isFinite(call.ms) ? Math.max(0, call.ms) : 0,
      ...(["completed", "failed", "approval_required"].includes(call.state ?? "") ? { state: call.state } : {}),
      ...(call.summary ? { summary: text(call.summary, 256) } : {}),
    })),
  } : undefined;
  const events = content.events?.slice(0, WIRE_CONTENT_ITEM_LIMIT).map((e) => ({
    type: text(e.type, 80), text: text(e.text), revision: e.revision, level: e.level,
  }));
  return { conversation, events,
    omittedEvents: (content.omittedEvents ?? 0) + Math.max(0, (content.events?.length ?? 0) - WIRE_CONTENT_ITEM_LIMIT),
    omittedCalls: (content.omittedCalls ?? 0) + Math.max(0, (c?.calls?.length ?? 0) - WIRE_CONTENT_ITEM_LIMIT),
    shortened,
  };
}

/** Presentation only: free text must not leak into exported label/note fields. */
export function wirePresentation(event: WireEvent): { title: string; preview?: string } {
  const c = event.content?.conversation;
  if (c) return { title: `${event.label} · ${c.input}`,
    preview: c.reply || c.needs?.join(" · ") || c.failure || event.note };
  if (event.lane === "ws" && event.label.startsWith("event")) {
    const types = event.content?.events?.map((e) => e.type) ?? String(event.detail?.types ?? "").split(/\s+/).filter(Boolean);
    const unique = [...new Set(types)];
    if (unique.length) return { title: `${unique.slice(0, 2).join(" · ")}${unique.length > 2 ? ` +${unique.length - 2} types` : ""}`,
      preview: event.content?.events?.map((e) => e.text).filter(Boolean).join(" · ") || event.note };
  }
  if (event.label === "say" && typeof event.detail?.said === "string") return { title: `say · ${event.detail.said}`, preview: event.note };
  return { title: event.label, preview: String(event.detail?.effect ?? event.detail?.error ?? event.note ?? "") || undefined };
}

export function wireContentSearch(event: WireEvent): string[] {
  const c = event.content?.conversation;
  return [c?.input ?? "", c?.reply ?? "", c?.intent ?? "", c?.approval ?? "", c?.failure ?? "",
    ...(c?.needs ?? []), ...(c?.choices ?? []), ...(c?.calls?.flatMap((call) => [call.tool, call.state ?? "", call.summary ?? ""]) ?? []),
    ...(event.content?.events?.flatMap((e) => [e.type, e.text]) ?? []),
  ];
}
