/**
 * Phase B — pipeline selection.
 *
 * The LLM compares the gathered context against the registry and picks the most
 * suitable pipeline, or returns "none" if none honestly applies (we do not force
 * a bad match).
 */
import { z } from "zod";
import {
  callStructured,
  nullableText,
  type LLMProvider,
  type ChatMessage,
  type ToolDefinition,
} from "../llm/index.js";
import type { PipelineDefinition } from "../pipelines/types.js";
import type { QueryContext } from "./session.js";

const selectionSchema = z.object({
  pipelineName: nullableText,
  rationale: z.string().catch(""),
});

export interface SelectionResult {
  /** Name of the chosen pipeline, or null if none applies. */
  pipelineName: string | null;
  /** Short explanation to show the user. */
  rationale: string;
}

function buildTool(registry: PipelineDefinition[]): ToolDefinition {
  return {
    name: "select_pipeline",
    description: "Pick the most suitable nf-core pipeline for the user's intent.",
    parameters: {
      type: "object",
      properties: {
        pipelineName: {
          type: ["string", "null"],
          enum: [...registry.map((p) => p.name), null],
          description: "Exact name of the chosen pipeline, or null if none applies.",
        },
        rationale: {
          type: "string",
          description:
            "Short explanation (1-3 sentences) of why that pipeline (or why none), in English.",
        },
      },
      required: ["pipelineName", "rationale"],
    },
  };
}

function systemPrompt(registry: PipelineDefinition[], query: QueryContext): string {
  const catalog = registry
    .map(
      (p) =>
        `- ${p.name}\n    solves: ${p.purpose}\n    data: ${p.dataType}\n    use when: ${p.useWhen.join("; ")}`,
    )
    .join("\n");
  return [
    "You are Hirsh, a bioinformatics assistant, in the PIPELINE-SELECTION phase.",
    "Choose ONLY from the catalog pipelines. If none truly fits, return pipelineName=null and",
    "honestly explain why; do not force a bad match.",
    "",
    "Gathered context:",
    `- Organism: ${query.organism ?? "(unknown)"}`,
    `- Data type: ${query.dataType ?? "(unknown)"}`,
    `- Objective: ${query.objective ?? "(unknown)"}`,
    `- Design: ${query.experimentalDesign ?? "(unknown)"}`,
    "",
    "Catalog:",
    catalog,
    "",
    "Respond by calling select_pipeline.",
  ].join("\n");
}

export async function selectPipeline(
  provider: LLMProvider,
  registry: PipelineDefinition[],
  query: QueryContext,
): Promise<SelectionResult> {
  const tool = buildTool(registry);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(registry, query) },
    { role: "user", content: "Choose the right pipeline for my case." },
  ];
  const data = await callStructured(provider, { messages, tool, schema: selectionSchema });
  if (!data) {
    return { pipelineName: null, rationale: "I could not determine a pipeline from the available information." };
  }
  const name = data.pipelineName?.trim() || null;
  const valid = name && registry.some((p) => p.name === name) ? name : null;
  return { pipelineName: valid, rationale: data.rationale };
}
