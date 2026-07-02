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
import type { LLMProvider, ChatMessage, ToolDefinition } from "../llm/index.js";
import type { PipelineDefinition } from "../pipelines/types.js";

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
        type: "boolean",
        description:
          "true ONLY if the known information is enough to confidently pick one of the supported pipelines.",
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
    "- Set enough=true once you can confidently tell which pipeline applies.",
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

  const resp = await provider.chat({ messages, tools: [TOOL], forceTool: TOOL.name });
  const call = resp.toolCalls.find((c) => c.name === TOOL.name);
  if (!call) {
    // Defensive fallback: if the model did not call the tool, ask for more context.
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

  const a = call.arguments as Record<string, unknown>;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 && v.trim().toLowerCase() !== "null"
      ? v.trim()
      : null;

  const enough = a.enough === true;
  return {
    organism: str(a.organism),
    dataType: str(a.dataType),
    objective: str(a.objective),
    experimentalDesign: str(a.experimentalDesign),
    enough,
    nextQuestion: enough ? null : str(a.nextQuestion),
  };
}
