/**
 * Composition planner (Phase F4).
 *
 * When no curated pipeline fits, Hirsh composes one from real nf-core modules:
 *   1. Ask the LLM for search terms (tool/keyword vocabulary) from the intent.
 *   2. Query the live registry for candidate modules and fetch their meta.
 *   3. Ask the LLM to select and order a subset into a coherent pipeline plan.
 *
 * The result is a reviewable plan; generation/validation happen separately.
 */
import type { LLMProvider, ChatMessage, ToolDefinition } from "../llm/index.js";
import type { ModuleRegistry } from "../modules/registry.js";
import type { NfCoreModule } from "../modules/types.js";
import type { QueryContext } from "../conversation/session.js";
import type { CompositionPlan, ResolvedComposition } from "./types.js";

const SUGGEST_TOOL: ToolDefinition = {
  name: "suggest_tools",
  description:
    "Suggest bioinformatics tool names and keywords to search for in the nf-core module catalog, based on the user's intent.",
  parameters: {
    type: "object",
    properties: {
      terms: {
        type: "array",
        items: { type: "string" },
        description:
          "Up to ~12 tool names or single keywords (e.g. 'fastqc', 'trimming', 'star', 'salmon', 'samtools', 'multiqc'). Prefer real tool names.",
      },
    },
    required: ["terms"],
  },
};

function composeTool(candidates: NfCoreModule[]): ToolDefinition {
  return {
    name: "compose_pipeline",
    description:
      "Select and order a subset of the candidate modules into a coherent pipeline for the user's intent.",
    parameters: {
      type: "object",
      properties: {
        pipelineName: {
          type: "string",
          description: "Short nf-core-style name: lowercase letters/digits only, no spaces (e.g. 'rnaqc').",
        },
        description: { type: "string", description: "One-line description of the composed pipeline." },
        steps: {
          type: "array",
          description: "Ordered pipeline steps. Use ONLY module names from the candidate list.",
          items: {
            type: "object",
            properties: {
              module: {
                type: "string",
                enum: candidates.map((c) => c.name),
                description: "Exact candidate module name.",
              },
              rationale: { type: "string", description: "Why this step, in plain terms." },
            },
            required: ["module", "rationale"],
          },
        },
      },
      required: ["pipelineName", "description", "steps"],
    },
  };
}

function intentText(query: QueryContext): string {
  return [
    `Organism: ${query.organism ?? "(unknown)"}`,
    `Data type: ${query.dataType ?? "(unknown)"}`,
    `Objective: ${query.objective ?? "(unknown)"}`,
    `Design: ${query.experimentalDesign ?? "(unknown)"}`,
  ].join("\n");
}

async function suggestTerms(provider: LLMProvider, query: QueryContext): Promise<string[]> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You help build a bioinformatics pipeline from nf-core modules. Suggest tool names/keywords " +
        "to search the module catalog. Respond by calling suggest_tools.",
    },
    { role: "user", content: intentText(query) },
  ];
  const resp = await provider.chat({ messages, tools: [SUGGEST_TOOL], forceTool: SUGGEST_TOOL.name });
  const call = resp.toolCalls.find((c) => c.name === SUGGEST_TOOL.name);
  const terms = call?.arguments.terms;
  if (Array.isArray(terms)) return terms.filter((t): t is string => typeof t === "string");
  return [];
}

function sanitizeName(name: string): string {
  const clean = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return clean.length >= 2 ? clean : "hirshpipeline";
}

/**
 * Plans a composition end to end. Throws if the registry is unreachable; returns
 * null (with an empty candidate set) if nothing relevant was found.
 */
export async function planComposition(
  provider: LLMProvider,
  registry: ModuleRegistry,
  query: QueryContext,
): Promise<ResolvedComposition | null> {
  const llmTerms = await suggestTerms(provider, query);
  const searchTerms = [
    ...llmTerms,
    query.objective ?? "",
    query.dataType ?? "",
  ].filter(Boolean);

  const refs = await registry.search(searchTerms, 20);
  if (refs.length === 0) return null;

  // Fetch meta for the candidates (bounded), tolerating individual failures.
  const candidates: NfCoreModule[] = [];
  for (const ref of refs.slice(0, 14)) {
    try {
      candidates.push(await registry.getMeta(ref.name));
    } catch {
      /* skip modules whose meta can't be fetched */
    }
  }
  if (candidates.length === 0) return null;

  const tool = composeTool(candidates);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You are Hirsh, composing a pipeline from nf-core modules for the user's intent.",
        "Pick and ORDER a coherent subset of the candidate modules (typical flow: QC → trimming →",
        "alignment/quantification → post-processing → reporting). Use ONLY the candidates given.",
        "Prefer including a QC/reporting step (e.g. fastqc, multiqc) when relevant.",
        "Respond by calling compose_pipeline.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        intentText(query),
        "",
        "Candidate modules:",
        ...candidates.map((c) => `- ${c.name}: ${c.description || "(no description)"}`),
      ].join("\n"),
    },
  ];

  const resp = await provider.chat({ messages, tools: [tool], forceTool: tool.name });
  const call = resp.toolCalls.find((c) => c.name === tool.name);
  if (!call) return null;

  const a = call.arguments as Record<string, unknown>;
  const rawSteps = Array.isArray(a.steps) ? a.steps : [];
  const byName = new Map(candidates.map((c) => [c.name, c]));
  const steps = rawSteps
    .map((s) => (typeof s === "object" && s ? (s as Record<string, unknown>) : {}))
    .map((s) => ({
      module: typeof s.module === "string" ? s.module : "",
      rationale: typeof s.rationale === "string" ? s.rationale : "",
    }))
    .filter((s) => byName.has(s.module));

  if (steps.length === 0) return null;

  const plan: CompositionPlan = {
    pipelineName: sanitizeName(typeof a.pipelineName === "string" ? a.pipelineName : "hirshpipeline"),
    description: typeof a.description === "string" ? a.description : "Composed nf-core pipeline.",
    steps,
  };

  return {
    plan,
    modules: steps.map((s) => byName.get(s.module)!),
    sha: registry.pinnedSha ?? (await registry.resolveSha()),
  };
}
