/**
 * LLM-proposed local tools (Phase 4).
 *
 * When the selected nf-core modules don't fully cover the objective, Hirsh asks
 * the model to identify the *gap* and propose a minimal custom tool for it — the
 * missing piece that makes "compose a genuinely new pipeline" real. Proposals are
 * scaffolds the scientist reviews (and edits) before anything is generated.
 *
 * The tool-call output is schema-validated; mapping to a LocalToolSpec is pure.
 */
import { z } from "zod";
import {
  callStructured,
  type LLMProvider,
  type ChatMessage,
  type ToolDefinition,
} from "../llm/index.js";
import type { QueryContext } from "../conversation/session.js";
import type { LocalToolSpec } from "./localModule.js";

const proposedSchema = z.object({
  name: z.string().catch(""),
  description: z.string().catch(""),
  command: z.string().catch(""),
  inputKind: z.string().catch("input"),
  outputKind: z.string().catch("output"),
  outputPattern: z.string().catch(""),
  conda: z.string().catch(""),
  container: z.string().catch(""),
  versionCommand: z.string().catch(""),
});

const proposalSchema = z.object({
  tools: z.array(proposedSchema).catch([]),
});

const PROPOSE_TOOL: ToolDefinition = {
  name: "propose_local_tools",
  description:
    "Propose custom (non-nf-core) tools needed to fully address the objective that the selected nf-core modules do NOT cover. Empty list if the modules already suffice.",
  parameters: {
    type: "object",
    properties: {
      tools: {
        type: "array",
        description: "One entry per genuine gap; empty if the modules already cover the objective.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short lowercase tool name (e.g. 'peakfilter')." },
            description: { type: "string", description: "What it does, in one line." },
            command: {
              type: "string",
              description: "A shell command sketch; use $prefix for the output base and $args for extra args.",
            },
            inputKind: { type: "string", description: "Input data kind, e.g. 'bam', 'vcf', 'reads'." },
            outputKind: { type: "string", description: "Output data kind, e.g. 'bed', 'tsv'." },
            outputPattern: { type: "string", description: "Output glob, e.g. '*.filtered.bed'." },
            conda: { type: "string", description: "Conda package if a real tool fits (e.g. 'bioconda::bedtools=2.31'); else empty." },
            container: { type: "string", description: "Container image if known; else empty." },
            versionCommand: { type: "string", description: "Command printing the tool version; else empty." },
          },
          required: ["name", "description", "command", "inputKind", "outputKind"],
        },
      },
    },
    required: ["tools"],
  },
};

function sanitizeName(name: string): string {
  const clean = name.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return clean.length >= 2 ? clean : "customtool";
}

/** Maps a validated proposal into a LocalToolSpec (pure). */
export function toLocalToolSpec(p: z.infer<typeof proposedSchema>): LocalToolSpec | null {
  const name = sanitizeName(p.name);
  if (!p.name.trim() || !p.command.trim()) return null;
  const outKind = p.outputKind.trim() || "output";
  return {
    name,
    toolName: name,
    description: p.description.trim() || `Custom tool ${name}.`,
    command: p.command.trim(),
    container: p.container.trim() || undefined,
    conda: p.conda.trim() || undefined,
    inputs: [{ name: p.inputKind.trim() || "input", type: "file" }],
    outputs: [{ name: outKind, type: "file", pattern: p.outputPattern.trim() || `*.${outKind}` }],
    versionCommand: p.versionCommand.trim() || undefined,
    hasMeta: true,
    label: "process_single",
  };
}

/**
 * Asks the LLM to propose local tools for gaps the selected modules don't cover.
 * Returns [] if the modules suffice or the model produced nothing usable.
 */
export async function proposeLocalTools(
  provider: LLMProvider,
  query: QueryContext,
  selectedModules: string[],
): Promise<LocalToolSpec[]> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You are Hirsh, composing a bioinformatics pipeline. The user's objective and the",
        "nf-core modules already selected are given. Identify any GAP — a processing step the",
        "objective needs that NONE of the selected modules performs — and propose a minimal custom",
        "tool for each gap. Do NOT propose tools that duplicate a selected module. If the modules",
        "already cover the objective, return an empty list. Prefer a real tool with a conda package",
        "when one fits; otherwise leave conda/container empty for the scientist to fill in.",
        "Respond by calling propose_local_tools.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Objective: ${query.objective ?? "(unknown)"}`,
        `Organism: ${query.organism ?? "(unknown)"}`,
        `Data type: ${query.dataType ?? "(unknown)"}`,
        `Selected nf-core modules: ${selectedModules.join(", ") || "(none)"}`,
      ].join("\n"),
    },
  ];

  const data = await callStructured(provider, { messages, tool: PROPOSE_TOOL, schema: proposalSchema });
  if (!data) return [];
  const specs: LocalToolSpec[] = [];
  for (const p of data.tools) {
    const spec = toLocalToolSpec(p);
    if (spec) specs.push(spec);
  }
  return specs;
}
