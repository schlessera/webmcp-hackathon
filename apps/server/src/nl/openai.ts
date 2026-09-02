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

export type InputItem =
  | { role: "user" | "assistant" | "system"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

export interface Call {
  model: string;
  instructions: string;
  input: InputItem[];
  /** Strict JSON schema the answer must satisfy. */
  schema?: { name: string; schema: unknown };
  tools?: FunctionTool[];
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
  ms: number;
  model: string;
}

export class NlError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Transport = (body: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;

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

/** Tests swap the wire for a scripted one; nothing else may. */
export function setTransport(next: Transport | null): void {
  transport = next ?? liveTransport;
}

export async function respond(call: Call): Promise<Reply> {
  const started = Date.now();
  const body: Record<string, unknown> = {
    model: call.model,
    instructions: call.instructions,
    input: call.input,
    store: false,
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
  if (call.reasoning) body.reasoning = { effort: call.reasoning };
  if (call.maxOutputTokens) body.max_output_tokens = call.maxOutputTokens;

  const raw = (await transport(body, call.timeoutMs ?? 30_000)) as {
    output?: Array<Record<string, unknown>>;
    error?: { message?: string } | null;
    status?: string;
  };
  if (raw.error) throw new NlError(raw.error.message ?? "openai error", 502);
  const output = raw.output ?? [];
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const item of output) {
    if (item.type === "message") {
      for (const part of (item.content as Array<Record<string, unknown>>) ?? []) {
        if (part.type === "output_text" && typeof part.text === "string") {
          texts.push(part.text);
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        callId: String(item.call_id),
        name: String(item.name),
        arguments: String(item.arguments ?? "{}"),
      });
    }
  }
  return {
    text: texts.length ? texts.join("\n") : null,
    toolCalls,
    outputItems: output,
    ms: Date.now() - started,
    model: call.model,
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
