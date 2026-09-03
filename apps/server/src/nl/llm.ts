import { config } from "../config.ts";

/**
 * The one door to language models. Callers speak the existing Responses-shaped
 * interface; this module chooses the wire backend and owns its compatibility
 * rewrites.
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
  /** Foreground work uses default. Flex is reserved for later background work. */
  serviceTier?: "default" | "flex";
}

export const ALLOWED_SERVICE_TIERS = ["default", "flex"] as const;

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
  citations?: Array<{
    url: string;
    title?: string;
    /** OpenRouter's source excerpt; its numeric offsets are currently zeroed. */
    content?: string;
    start?: number;
    end?: number;
  }>;
  /** Raw built-in search call items, also retained in outputItems for re-feed. */
  webSearchCalls?: unknown[];
  ms: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usage: { inputTokens: number; outputTokens: number; costUsd?: number };
}

export class NlError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

type Transport = (body: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
type Provider = "openai" | "openrouter";

export interface ResponseMetrics {
  calls: number;
  webSearchRequests: number;
  webSearchCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  serviceTierCalls: Record<ObservedServiceTier, number>;
  schemaCalls: Record<string, number>;
}

export type ServiceTier = "default" | "flex";
export type ObservedServiceTier =
  | ServiceTier
  | "auto"
  | "priority"
  | "fast"
  | "scale"
  | "ultrafast"
  | "unknown";

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
  costUsd: 0,
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
    costUsd: 0,
    serviceTierCalls: emptyServiceTierCalls(),
    schemaCalls: {},
  };
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = new Date(raw).getTime();
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function responseFetch(
  provider: Provider,
  url: string,
  apiKey: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new NlError(
        `${provider} ${response.status}: ${detail}`,
        response.status,
        retryAfterMs(response),
      );
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Today's OpenAI Responses transport, retained as the fallback backend. */
const openaiTransport: Transport = (body, timeoutMs) =>
  responseFetch(
    "openai",
    "https://api.openai.com/v1/responses",
    config.openaiApiKey,
    {},
    body,
    timeoutMs,
  );

const openrouterTransport: Transport = (body, timeoutMs) =>
  responseFetch(
    "openrouter",
    "https://openrouter.ai/api/v1/responses",
    config.openrouterApiKey,
    {
      "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER ??
        process.env.APP_URL ??
        "https://github.com/schlessera/webmcp-hackathon",
      "X-OpenRouter-Title": process.env.OPENROUTER_TITLE ?? "Spokes",
    },
    body,
    timeoutMs,
  );

let injectedTransport: Transport | null = null;
const flexUnsupportedModels = new Set<string>();

/** Tests swap the wire for a scripted one; nothing else may. */
export function setTransport(next: Transport | null): void {
  injectedTransport = next;
}

/** Test seam for process-local model capability memory. */
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

function hasInputFile(input: InputItem[]): boolean {
  return input.some((item) =>
    "role" in item && Array.isArray(item.content) &&
    item.content.some((part) => part.type === "input_file")
  );
}

function openrouterTools(tools: Call["tools"]): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => {
    if (tool.type === "function") return tool;
    return {
      type: "openrouter:web_search",
      parameters: {
        ...(tool.filters?.allowed_domains?.length
          ? { allowed_domains: tool.filters.allowed_domains }
          : {}),
        ...(tool.search_context_size
          ? { search_context_size: tool.search_context_size }
          : {}),
      },
    };
  });
}

function requestBody(call: Call, provider: Provider, privatePath: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: call.model,
    instructions: call.instructions,
    input: call.input,
    // OpenRouter's Responses endpoint is stateless; neither backend ever gets
    // an opportunity to store a response through this client.
    store: false,
    service_tier: call.serviceTier ?? "default",
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
  if (provider === "openrouter") {
    const tools = openrouterTools(call.tools);
    if (tools) body.tools = tools;
    const effort = call.reasoning ?? "low";
    body.reasoning = effort === "none" || effort === "minimal"
      ? { effort: "low", exclude: true }
      : { effort };
    if (call.schema || privatePath) {
      body.provider = {
        ...(call.schema ? { require_parameters: true } : {}),
        ...(privatePath ? { data_collection: "deny", zdr: true } : {}),
      };
    }
    if (hasInputFile(call.input)) {
      body.plugins = [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }];
    }
  } else {
    if (call.tools?.length) body.tools = call.tools;
    if (call.include) body.include = call.include;
    if (call.reasoning) body.reasoning = { effort: call.reasoning };
  }
  if (call.maxOutputTokens) body.max_output_tokens = call.maxOutputTokens;
  return body;
}

function retryable(error: unknown): error is NlError {
  return error instanceof NlError && (error.status === 429 || error.status >= 500);
}

function jitteredDelay(retry: number, retryAfter: number | undefined): number {
  if (retryAfter !== undefined) return retryAfter + Math.floor(Math.random() * 250);
  const ceiling = 250 * 2 ** retry;
  return Math.floor(ceiling / 2 + Math.random() * ceiling / 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RawResponse {
  output?: Array<Record<string, unknown>>;
  error?: { message?: string } | null;
  status?: string;
  service_tier?: unknown;
  incomplete_details?: { reason?: string } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cost?: number | string;
    server_tool_use_details?: { web_search_requests?: number };
    server_tool_use?: { web_search_requests?: number };
  };
}

async function sendWithRetries(
  body: Record<string, unknown>,
  transport: Transport,
  deadlineAt: number,
): Promise<RawResponse> {
  let retry = 0;
  while (true) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new NlError("llm request timed out", 504);
    try {
      return await transport(body, remaining) as RawResponse;
    } catch (error) {
      if (!retryable(error) || retry >= 3) throw error;
      const delay = jitteredDelay(retry, error.retryAfterMs);
      retry += 1;
      if (delay >= deadlineAt - Date.now()) throw error;
      await sleep(delay);
    }
  }
}

function webSearchRequestCount(raw: RawResponse, call: Call): number {
  const reported = raw.usage?.server_tool_use_details?.web_search_requests ??
    raw.usage?.server_tool_use?.web_search_requests;
  return typeof reported === "number"
    ? reported
    : call.tools?.some((tool) => tool.type === "web_search") ? 1 : 0;
}

function recordMetrics(raw: RawResponse, call: Call, serviceTier: ServiceTier): void {
  const output = raw.output ?? [];
  responseMetricsState.calls += 1;
  responseMetricsState.webSearchRequests += webSearchRequestCount(raw, call);
  responseMetricsState.webSearchCalls += output.filter((item) =>
    item.type === "web_search_call" || item.type === "openrouter:web_search"
  ).length;
  responseMetricsState.inputTokens += Number(raw.usage?.input_tokens ?? 0);
  responseMetricsState.outputTokens += Number(raw.usage?.output_tokens ?? 0);
  responseMetricsState.costUsd += Number(raw.usage?.cost ?? 0) || 0;
  responseMetricsState.serviceTierCalls[observedServiceTier(raw.service_tier, serviceTier)] += 1;
  const schemaName = call.schema?.name;
  if (schemaName) {
    responseMetricsState.schemaCalls[schemaName] =
      (responseMetricsState.schemaCalls[schemaName] ?? 0) + 1;
  }
}

function higherOutputCap(body: Record<string, unknown>): number {
  const current = Number(body.max_output_tokens ?? 1_000);
  return Math.ceil(current * 2);
}

async function respondWithPolicy(call: Call, privatePath: boolean): Promise<Reply> {
  const started = Date.now();
  const provider = config.llmProvider;
  const requestedServiceTier: ServiceTier = call.serviceTier ??
    (call.intent === "background" ? "flex" : "default");
  if (!(ALLOWED_SERVICE_TIERS as readonly unknown[]).includes(requestedServiceTier)) {
    throw new NlError(`service tier ${String(requestedServiceTier)} is not allowed`, 400);
  }
  let serviceTier: ServiceTier = requestedServiceTier === "flex" && flexUnsupportedModels.has(call.model)
    ? "default"
    : requestedServiceTier;
  let body = requestBody({ ...call, serviceTier }, provider, privatePath);
  const transport = injectedTransport ??
    (provider === "openrouter" ? openrouterTransport : openaiTransport);
  const deadlineAt = started + (call.timeoutMs ?? 30_000);
  const raws: RawResponse[] = [];
  let raw: RawResponse;
  try {
    raw = await sendWithRetries(body, transport, deadlineAt);
  } catch (error) {
    if (serviceTier !== "flex" || !namesServiceTier(error)) throw error;
    flexUnsupportedModels.add(call.model);
    serviceTier = "default";
    body = requestBody({ ...call, serviceTier }, provider, privatePath);
    raw = await sendWithRetries(body, transport, deadlineAt);
  }
  raws.push(raw);
  recordMetrics(raw, call, serviceTier);
  if (raw.status === "incomplete") {
    body.max_output_tokens = higherOutputCap(body);
    raw = await sendWithRetries(body, transport, deadlineAt);
    raws.push(raw);
    recordMetrics(raw, call, serviceTier);
  }
  if (raw.status === "incomplete") {
    throw new NlError(
      `llm response incomplete: ${raw.incomplete_details?.reason ?? "unknown reason"}`,
      502,
    );
  }
  if (raw.error) throw new NlError(raw.error.message ?? `${provider} error`, 502);

  const output = raw.output ?? [];
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const citations: NonNullable<Reply["citations"]> = [];
  const webSearchCalls: unknown[] = [];
  for (const item of output) {
    if (item.type === "message") {
      for (const part of (item.content as Array<Record<string, unknown>>) ?? []) {
        if (part.type !== "output_text" || typeof part.text !== "string") continue;
        const textOffset = texts.reduce((total, text) => total + text.length, 0) + texts.length;
        texts.push(part.text);
        const annotations = Array.isArray(part.annotations) ? part.annotations : [];
        for (const annotation of annotations as Array<Record<string, unknown>>) {
          if (annotation.type !== "url_citation" || typeof annotation.url !== "string") continue;
          citations.push({
            url: annotation.url,
            ...(typeof annotation.title === "string" ? { title: annotation.title } : {}),
            ...(provider === "openrouter" && typeof annotation.content === "string"
              ? { content: annotation.content }
              : {}),
            // OpenRouter currently returns zeroed offsets. Its citations are
            // deliberately an unordered source list, with no offset math.
            ...(provider === "openai" && typeof annotation.start_index === "number"
              ? { start: textOffset + annotation.start_index }
              : {}),
            ...(provider === "openai" && typeof annotation.end_index === "number"
              ? { end: textOffset + annotation.end_index }
              : {}),
          });
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        callId: String(item.call_id),
        name: String(item.name),
        arguments: String(item.arguments ?? "{}"),
      });
    } else if (item.type === "web_search_call" || item.type === "openrouter:web_search") {
      webSearchCalls.push(item);
    }
  }
  const inputTokens = raws.reduce(
    (total, response) => total + Number(response.usage?.input_tokens ?? 0),
    0,
  );
  const outputTokens = raws.reduce(
    (total, response) => total + Number(response.usage?.output_tokens ?? 0),
    0,
  );
  const costUsd = raws.reduce(
    (total, response) => total + (Number(response.usage?.cost ?? 0) || 0),
    0,
  );
  return {
    text: texts.length ? texts.join("\n") : null,
    toolCalls,
    outputItems: output,
    ...(citations.length ? { citations } : {}),
    ...(webSearchCalls.length ? { webSearchCalls } : {}),
    ms: Date.now() - started,
    model: call.model,
    inputTokens,
    outputTokens,
    usage: {
      inputTokens,
      outputTokens,
      ...(costUsd > 0 ? { costUsd } : {}),
    },
  };
}

export function respond(call: Call): Promise<Reply> {
  return respondWithPolicy(call, false);
}

/** The private-condition and participant-agent paths require no-collection,
 * zero-retention routing in addition to the stateless Responses contract. */
export function respondPrivate(call: Call): Promise<Reply> {
  return respondWithPolicy(call, true);
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
