/**
 * Phase A — intent extraction.
 *
 * Uses the LLM with a forced tool (`record_intent`) to turn the free-form
 * conversation into structured context, and to decide whether critical
 * information is missing before committing to a pipeline.
 *
 * The design targets a known weakness (FlowBench 2026): models are good at
 * writing the command but fail at INFERRING the pipeline from the biological
 * intent alone. That is why we force explicit extraction of organism, data /
 * sequencing type, objective and experimental design.
 */
import { z } from "zod";
import {
  callStructured,
  looseBoolean,
  nullableText,
  type LLMProvider,
  type ChatMessage,
  type ToolDefinition,
} from "../llm/index.js";
import type { PipelineDefinition } from "../pipelines/types.js";
import type { QueryContext } from "./session.js";

const intentSchema = z.object({
  organism: nullableText,
  dataType: nullableText,
  objective: nullableText,
  experimentalDesign: nullableText,
  enough: looseBoolean.catch(false),
  nextQuestion: nullableText,
});

export interface IntentResult {
  organism: string | null;
  dataType: string | null;
  objective: string | null;
  experimentalDesign: string | null;
  /** true if there is enough to confidently select a pipeline. */
  enough: boolean;
  /** If !enough: the SINGLE next question to ask (one at a time). */
  nextQuestion: string | null;
}

const TOOL: ToolDefinition = {
  name: "record_intent",
  description:
    "Record what is known about the user's intent and decide whether critical information is missing to choose a bioinformatics pipeline.",
  parameters: {
    type: "object",
    properties: {
      organism: {
        type: ["string", "null"],
        description: "Organism/species of the study, or null if not known yet.",
      },
      dataType: {
        type: ["string", "null"],
        description:
          "Data and sequencing type: DNA/RNA/protein, short/long reads, etc. null if unknown.",
      },
      objective: {
        type: ["string", "null"],
        description: "Biological objective of the analysis in one sentence, or null.",
      },
      experimentalDesign: {
        type: ["string", "null"],
        description:
          "Relevant experimental design: replicates, conditions, paired/unpaired, tumor/normal, etc. null if not applicable or unknown.",
      },
      enough: {
        // Some models emit "true"/"false" as strings; allow both so strict
        // server-side tool validation (e.g. Groq) accepts it — we coerce to a
        // real boolean with `looseBoolean` when parsing.
        type: ["boolean", "string"],
        description:
          "true ONLY if the known information is enough to confidently pick one of the supported pipelines. Prefer a JSON boolean (true/false).",
      },
      nextQuestion: {
        type: ["string", "null"],
        description:
          "If enough=false, the single next question to ask the user, clear and in English. If enough=true, null.",
      },
    },
    required: ["organism", "dataType", "objective", "experimentalDesign", "enough", "nextQuestion"],
  },
};

/** True once the core fields needed to attempt pipeline selection are all known. */
export function hasEnoughContext(query: QueryContext): boolean {
  return Boolean(query.organism?.trim() && query.dataType?.trim() && query.objective?.trim());
}

const QUESTION_STOPWORDS = new Set([
  "do", "you", "have", "the", "for", "your", "would", "like", "with", "what", "which",
  "and", "are", "this", "that", "want", "into", "just", "any", "such", "there", "does",
  "is", "of", "to", "a", "or", "in", "on", "an", "as", "it", "me", "my",
]);

function questionTokens(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !QUESTION_STOPWORDS.has(w));
}

/**
 * True if a candidate clarifying question substantially repeats one already asked
 * (so the loop shouldn't ask it again). Compares meaningful-token overlap. Pure.
 */
export function isDuplicateQuestion(candidate: string, asked: string[]): boolean {
  const c = new Set(questionTokens(candidate));
  if (c.size === 0) return false;
  for (const prev of asked) {
    const t = questionTokens(prev);
    if (t.length === 0) continue;
    const overlap = t.filter((w) => c.has(w)).length;
    if (overlap / Math.min(c.size, t.length) >= 0.6) return true;
  }
  return false;
}

function systemPrompt(registry: PipelineDefinition[]): string {
  const catalog = registry
    .map((p) => `- ${p.name}: ${p.purpose} (data: ${p.dataType})`)
    .join("\n");
  return [
    "You are Hirsh, a bioinformatics assistant. You are in the UNDERSTAND-INTENT phase.",
    "Your job is NOT to pick the pipeline yet, but to gather the minimum information needed to pick it.",
    "The hard part is inferring the right tool from the biological intent alone, so make sure you know:",
    "organism, data/sequencing type (DNA/RNA/protein, short/long reads), the analysis objective,",
    "and any relevant experimental design.",
    "",
    "Available pipelines (only these; do not invent others):",
    catalog,
    "",
    "Rules:",
    "- Set enough=true once you can confidently tell which pipeline applies, OR once you already",
    "  know the organism, the data/sequencing type AND the objective — then STOP asking.",
    "- NEVER re-ask something the user has already told you, and never ask a question you have",
    "  effectively already asked. Read the whole conversation first.",
    "- If something critical is missing, ask ONE clear question (nextQuestion), not several.",
    "- Do not ask about parameter details yet (that is a later phase).",
    "- ALWAYS respond by calling the record_intent tool.",
  ].join("\n");
}

export async function extractIntent(
  provider: LLMProvider,
  registry: PipelineDefinition[],
  transcript: Array<{ role: "user" | "agent"; text: string }>,
): Promise<IntentResult> {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(registry) },
    ...transcript.map<ChatMessage>((t) => ({
      role: t.role === "user" ? "user" : "assistant",
      content: t.text,
    })),
  ];

  const data = await callStructured(provider, { messages, tool: TOOL, schema: intentSchema });
  if (!data) {
    // The model never produced a valid record_intent call (even after a retry).
    return {
      organism: null,
      dataType: null,
      objective: null,
      experimentalDesign: null,
      enough: false,
      nextQuestion:
        "Could you describe in a bit more detail what analysis you want to run and on what kind of data?",
    };
  }

  return {
    organism: data.organism,
    dataType: data.dataType,
    objective: data.objective,
    experimentalDesign: data.experimentalDesign,
    enough: data.enough,
    nextQuestion: data.enough ? null : data.nextQuestion,
  };
}
