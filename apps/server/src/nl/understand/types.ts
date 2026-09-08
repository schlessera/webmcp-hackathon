import type { HINT_TAXONOMY } from "@webmcp-hackathon/contracts";

export interface ParsedNeed {
  payload: Record<string, unknown>;
  label: string;
  gist: string;
  topic?: (typeof HINT_TAXONOMY)[number];
  assumed?: string;
  hardness?: "hard" | "soft";
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
  /**
   * How many of the choices apply. "one" is a fork — which of these did you
   * mean — and stays the default everywhere a clarification already existed.
   * "many" is a set: the question is under-determined in more than one
   * direction at once, and the page draws checkboxes rather than a picker.
   */
  mode?: "one" | "many";
  /** Which step of a plan the question is about, when it is about one. */
  stepId?: string | null;
}

export interface MapResult {
  needs: ParsedNeed[];
  clarify: Clarification | null;
  intent: "need" | "ask" | "act" | "clarify" | "unclear";
  reply: string | null;
  suggestions?: ClarifyChoice[];
}
