import { config } from "../config.ts";

/**
 * The one door to OpenAI: a thin Responses API client over fetch, with a
 * timeout, structured outputs, and function tools. No SDK — the surface used
 * is small and the dependency would be the only network package in the app.
 *
 * Model choice happens at the call sites (say.ts, agent.ts, screening.ts),
 * never here: this module knows how to talk, not what to say or to whom.
 */

export interface FunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: unknown;
  strict?: boolean;
}

export interface WebSearchTool {
  type: "web_search";
  filters?: { allowed_domains: string[] };
  search_context_size?: "low" | "medium" | "high";
}

/** A user turn may carry an image or a file beside its text (menu reader). */
export type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "low" | "high" | "auto" }
  | { type: "input_file"; filename: string; file_data: string };

export type InputItem =
  | { role: "user" | "assistant" | "system"; content: string | ContentPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export interface Call {
  model: string;
  instructions: string;
  input: InputItem[];
  /** Interactive calls use standard latency; background work may use flex. */
  intent?: "interactive" | "background";
  /** Strict JSON schema the answer must satisfy. */
  schema?: { name: string; schema: unknown };
  tools?: Array<FunctionTool | WebSearchTool>;
  /** Extra built-in-tool output fields requested from Responses. */
  include?: string[];
  reasoning?: "none" | "minimal" | "low" | "medium" | "high";
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface ToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface Reply {
  /** The assistant's text, when it wrote any. */
  text: string | null;
  toolCalls: ToolCall[];
  /** Raw output items, re-fed verbatim on the next turn of a tool loop. */
  outputItems: unknown[];
  /** URL citations carried by output_text annotations. */
  citations?: Array<{ url: string; title?: string; start?: number; end?: number }>;
  /** Raw built-in search call items, also retained in outputItems for re-feed. */
  webSearchCalls?: unknown[];
  ms: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usage: { inputTokens: number; outputTokens: number };
}

export class NlError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Transport = (body: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;

export interface ResponseMetrics {
  calls: number;
  webSearchRequests: number;
  webSearchCalls: number;
  inputTokens: number;
  outputTokens: number;
  serviceTierCalls: Record<ObservedServiceTier, number>;
  schemaCalls: Record<string, number>;
}

export type ServiceTier = "default" | "flex";
export type ObservedServiceTier = ServiceTier | "auto" | "priority" | "fast" | "scale" | "ultrafast" | "unknown";

const emptyServiceTierCalls = (): Record<ObservedServiceTier, number> => ({
  default: 0,
  flex: 0,
  auto: 0,
  priority: 0,
  fast: 0,
  scale: 0,
  ultrafast: 0,
  unknown: 0,
});

let responseMetricsState: ResponseMetrics = {
  calls: 0,
  webSearchRequests: 0,
  webSearchCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  serviceTierCalls: emptyServiceTierCalls(),
  schemaCalls: {},
};

/** Process-local measurement for the refinement benchmark; no request or
 * response content is retained. */
export function responseMetrics(): ResponseMetrics {
  return {
    ...responseMetricsState,
    serviceTierCalls: { ...responseMetricsState.serviceTierCalls },
    schemaCalls: { ...responseMetricsState.schemaCalls },
  };
}

export function resetResponseMetrics(): void {
  responseMetricsState = {
    calls: 0,
    webSearchRequests: 0,
    webSearchCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    serviceTierCalls: emptyServiceTierCalls(),
    schemaCalls: {},
  };
}

const liveTransport: Transport = async (body, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.openaiApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new NlError(`openai ${response.status}: ${detail}`, response.status);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
};

let transport: Transport = liveTransport;
const flexUnsupportedModels = new Set<string>();

/** Tests swap the wire for a scripted one; nothing else may. */
export function setTransport(next: Transport | null): void {
  transport = next ?? liveTransport;
}

/** Test seam for the process-local model capability memory. */
export function resetServiceTierSupportForTests(): void {
  flexUnsupportedModels.clear();
}

function namesServiceTier(error: unknown): boolean {
  const candidate = error as { status?: unknown; message?: unknown } | null;
  return candidate?.status === 400 && typeof candidate.message === "string" &&
    /(?:service[_ -]?tier|tier[^\n]*flex|flex[^\n]*tier)/i.test(candidate.message);
}

function observedServiceTier(value: unknown, requested: ServiceTier): ObservedServiceTier {
  return value === "default" || value === "flex" || value === "auto" ||
      value === "priority" || value === "fast" || value === "scale" || value === "ultrafast"
    ? value
    : requested;
}

export async function respond(call: Call): Promise<Reply> {
  const started = Date.now();
  let serviceTier: ServiceTier = call.intent === "interactive" || flexUnsupportedModels.has(call.model)
    ? "default"
    : "flex";
  const body: Record<string, unknown> = {
    model: call.model,
    instructions: call.instructions,
    input: call.input,
    store: false,
    service_tier: serviceTier,
  };
  if (call.schema) {
    body.text = {
      format: {
        type: "json_schema",
        name: call.schema.name,
        strict: true,
        schema: call.schema.schema,
      },
    };
  }
  if (call.tools?.length) body.tools = call.tools;
  if (call.include) body.include = call.include;
  if (call.reasoning) body.reasoning = { effort: call.reasoning };
  if (call.maxOutputTokens) body.max_output_tokens = call.maxOutputTokens;

  const timeoutMs = call.timeoutMs ?? 30_000;
  let response: unknown;
  try {
    response = await transport(body, timeoutMs);
  } catch (error) {
    if (serviceTier !== "flex" || !namesServiceTier(error)) throw error;
    flexUnsupportedModels.add(call.model);
    serviceTier = "default";
    response = await transport({ ...body, service_tier: serviceTier }, timeoutMs);
  }
  const raw = response as {
    output?: Array<Record<string, unknown>>;
    error?: { message?: string } | null;
    status?: string;
    service_tier?: unknown;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  if (raw.error) throw new NlError(raw.error.message ?? "openai error", 502);
  const output = raw.output ?? [];
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const citations: NonNullable<Reply["citations"]> = [];
  const webSearchCalls: unknown[] = [];
  for (const item of output) {
    if (item.type === "message") {
      for (const part of (item.content as Array<Record<string, unknown>>) ?? []) {
        if (part.type === "output_text" && typeof part.text === "string") {
          const textOffset = texts.reduce((total, text) => total + text.length, 0) + texts.length;
          texts.push(part.text);
          const annotations = Array.isArray(part.annotations) ? part.annotations : [];
          for (const annotation of annotations as Array<Record<string, unknown>>) {
            if (annotation.type !== "url_citation" || typeof annotation.url !== "string") continue;
            citations.push({
              url: annotation.url,
              ...(typeof annotation.title === "string" ? { title: annotation.title } : {}),
              ...(typeof annotation.start_index === "number"
                ? { start: textOffset + annotation.start_index }
                : {}),
              ...(typeof annotation.end_index === "number"
                ? { end: textOffset + annotation.end_index }
                : {}),
            });
          }
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        callId: String(item.call_id),
        name: String(item.name),
        arguments: String(item.arguments ?? "{}"),
      });
    } else if (item.type === "web_search_call") {
      webSearchCalls.push(item);
    }
  }
  const schemaName = call.schema?.name;
  responseMetricsState.calls += 1;
  responseMetricsState.webSearchRequests += call.tools?.some((tool) => tool.type === "web_search")
    ? 1
    : 0;
  responseMetricsState.webSearchCalls += webSearchCalls.length;
  responseMetricsState.inputTokens += Number(raw.usage?.input_tokens ?? 0);
  responseMetricsState.outputTokens += Number(raw.usage?.output_tokens ?? 0);
  responseMetricsState.serviceTierCalls[observedServiceTier(raw.service_tier, serviceTier)] += 1;
  if (schemaName) {
    responseMetricsState.schemaCalls[schemaName] =
      (responseMetricsState.schemaCalls[schemaName] ?? 0) + 1;
  }
  return {
    text: texts.length ? texts.join("\n") : null,
    toolCalls,
    outputItems: output,
    ...(citations.length ? { citations } : {}),
    ...(webSearchCalls.length ? { webSearchCalls } : {}),
    ms: Date.now() - started,
    model: call.model,
    inputTokens: Number(raw.usage?.input_tokens ?? 0),
    outputTokens: Number(raw.usage?.output_tokens ?? 0),
    usage: {
      inputTokens: Number(raw.usage?.input_tokens ?? 0),
      outputTokens: Number(raw.usage?.output_tokens ?? 0),
    },
  };
}

/** Parse the assistant's JSON, or null when it is not the shape asked for. */
export function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
