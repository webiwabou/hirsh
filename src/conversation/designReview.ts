/**
 * Experimental design review (Phase 6 — scientific dialogue).
 *
 * Before any pipeline runs, Hirsh reasons about the described experiment the way
 * a statistician/bioinformatician would: biological replication, controls,
 * confounders and batch effects, group balance, and whether the planned analysis
 * fits the objective. It reports constructive, plain-language observations — it
 * advises, it does not block.
 *
 * The LLM output is schema-validated (via callStructured); the severity helpers
 * are pure and unit-tested.
 */
import { z } from "zod";
import {
  callStructured,
  type LLMProvider,
  type ChatMessage,
  type ToolDefinition,
} from "../llm/index.js";
import type { QueryContext } from "./session.js";

export type Severity = "info" | "caution" | "risk";

export interface DesignObservation {
  severity: Severity;
  topic: string;
  message: string;
  suggestion?: string;
}

export interface DesignReview {
  observations: DesignObservation[];
  summary: string;
}

const observationSchema = z.object({
  severity: z.enum(["info", "caution", "risk"]).catch("info"),
  topic: z.string().catch("design"),
  message: z.string().catch(""),
  suggestion: z.string().catch(""),
});

const reviewSchema = z.object({
  observations: z.array(observationSchema).catch([]),
  summary: z.string().catch(""),
});

const REVIEW_TOOL: ToolDefinition = {
  name: "report_design_review",
  description:
    "Report a concise review of the experimental design: concerns and, where useful, suggestions.",
  parameters: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "One-sentence overall read of the design (in English).",
      },
      observations: {
        type: "array",
        description: "Specific design observations. Empty if the design looks sound.",
        items: {
          type: "object",
          properties: {
            severity: {
              type: "string",
              enum: ["info", "caution", "risk"],
              description:
                "info = fine/FYI; caution = worth addressing; risk = likely to undermine conclusions.",
            },
            topic: {
              type: "string",
              description: "Short tag, e.g. 'replication', 'controls', 'batch effects', 'balance'.",
            },
            message: { type: "string", description: "The concern, in plain terms." },
            suggestion: { type: "string", description: "What to do about it (optional)." },
          },
          required: ["severity", "topic", "message"],
        },
      },
    },
    required: ["summary", "observations"],
  },
};

const ORDER: Record<Severity, number> = { risk: 0, caution: 1, info: 2 };

/** The most serious severity present, or null if there are no observations. */
export function worstSeverity(review: DesignReview): Severity | null {
  let worst: Severity | null = null;
  for (const o of review.observations) {
    if (worst === null || ORDER[o.severity] < ORDER[worst]) worst = o.severity;
  }
  return worst;
}

/** Observations sorted most-serious first. */
export function sortedObservations(review: DesignReview): DesignObservation[] {
  return [...review.observations].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

function intentText(query: QueryContext): string {
  return [
    `Organism: ${query.organism ?? "(unknown)"}`,
    `Data type: ${query.dataType ?? "(unknown)"}`,
    `Objective: ${query.objective ?? "(unknown)"}`,
    `Experimental design: ${query.experimentalDesign ?? "(unknown)"}`,
  ].join("\n");
}

/**
 * Runs the LLM design review. Returns null if the model produced nothing usable
 * (the caller simply skips the review then).
 */
export async function reviewDesign(
  provider: LLMProvider,
  query: QueryContext,
): Promise<DesignReview | null> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You are Hirsh, a bioinformatics co-scientist reviewing the EXPERIMENTAL DESIGN",
        "before any pipeline runs. From the description, raise concerns a careful",
        "statistician/bioinformatician would: insufficient or absent biological replication,",
        "missing/inappropriate controls, likely confounders and batch effects, unbalanced",
        "groups, pseudoreplication, and whether the planned analysis suits the objective.",
        "Be concise and constructive. If the design looks sound, return few or no observations",
        "and say so in the summary. Do NOT invent details that weren't provided.",
        "Respond by calling report_design_review.",
      ].join(" "),
    },
    { role: "user", content: intentText(query) },
  ];

  const data = await callStructured(provider, { messages, tool: REVIEW_TOOL, schema: reviewSchema });
  if (!data) return null;

  const observations: DesignObservation[] = data.observations
    .map((o) => ({
      severity: o.severity,
      topic: o.topic.trim() || "design",
      message: o.message.trim(),
      suggestion: o.suggestion.trim() || undefined,
    }))
    .filter((o) => o.message.length > 0);

  return { observations, summary: data.summary.trim() };
}
