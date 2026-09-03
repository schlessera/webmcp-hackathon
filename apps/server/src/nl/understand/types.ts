import type { HINT_TAXONOMY } from "@webmcp-hackathon/contracts";

export interface ParsedNeed {
  payload: Record<string, unknown>;
  label: string;
  gist: string;
  topic?: (typeof HINT_TAXONOMY)[number];
  assumed?: string;
}

export interface ClarifyChoice {
  id: string;
  label: string;
  needs: ParsedNeed[];
}

export interface Clarification {
  question: string;
  choices: ClarifyChoice[];
  allowFreeText: true;
  said: string;
}

export interface MapResult {
  needs: ParsedNeed[];
  clarify: Clarification | null;
  intent: "need" | "ask" | "act" | "clarify" | "unclear";
  reply: string | null;
  suggestions?: ClarifyChoice[];
}
