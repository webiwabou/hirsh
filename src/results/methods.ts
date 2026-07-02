/**
 * Publication-ready methods (Phase 6).
 *
 * Builds a methods paragraph and a references list from what a run already
 * recorded: the pinned pipeline + Nextflow versions, the container engine, and
 * the *actual* tool versions nf-core writes to `pipeline_info/…software_versions`.
 * The point is a paste-ready, honest, exactly-versioned methods statement.
 *
 * Parsing/formatting are pure; only readSoftwareVersions touches disk.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** Standard framework citations, always applicable. */
export const NFCORE_CITATION =
  "Ewels PA, Peltzer A, Fillinger S, et al. The nf-core framework for community-curated bioinformatics pipelines. Nat Biotechnol. 2020. doi:10.1038/s41587-020-0439-x";
export const NEXTFLOW_CITATION =
  "Di Tommaso P, Chatzou M, Floden EW, et al. Nextflow enables reproducible computational workflows. Nat Biotechnol. 2017. doi:10.1038/nbt.3820";

export interface MethodsInput {
  pipelineName: string;
  revision: string;
  nextflowVersion?: string;
  containerEngine: string;
  organism?: string;
  dataType?: string;
  /** Distinct tool → version, e.g. { STAR: "2.7.9a", salmon: "1.10.1" }. */
  tools: Record<string, string>;
  pipelineCitation?: { text: string; doi?: string };
}

/**
 * Flattens an nf-core software-versions YAML (section → {tool: version}) into a
 * distinct tool→version map, dropping the workflow/Nextflow/pipeline entries that
 * are cited separately. Tolerant of a missing/odd shape.
 */
export function parseSoftwareVersions(yamlText: string, pipelineName?: string): Record<string, string> {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch {
    return {};
  }
  if (!doc || typeof doc !== "object") return {};

  const short = (pipelineName ?? "").split("/").pop()?.toLowerCase();
  const out: Record<string, string> = {};
  for (const section of Object.values(doc as Record<string, unknown>)) {
    if (!section || typeof section !== "object") continue;
    for (const [tool, version] of Object.entries(section as Record<string, unknown>)) {
      const name = tool.trim();
      const low = name.toLowerCase();
      if (low === "nextflow" || low === "workflow" || (short && low === short)) continue;
      if (low.startsWith("nf-core/")) continue;
      if (typeof version === "string" || typeof version === "number") {
        out[name] = String(version);
      }
    }
  }
  return out;
}

/** Finds and reads the nf-core software-versions file under an outdir. */
export function readSoftwareVersions(outdir: string, pipelineName?: string): Record<string, string> {
  const dir = join(outdir, "pipeline_info");
  const candidates: string[] = [];
  try {
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (/software.*versions.*\.ya?ml$/i.test(f)) candidates.push(join(dir, f));
      }
    }
  } catch {
    /* ignore */
  }
  for (const path of candidates) {
    try {
      const tools = parseSoftwareVersions(readFileSync(path, "utf8"), pipelineName);
      if (Object.keys(tools).length > 0) return tools;
    } catch {
      /* try the next candidate */
    }
  }
  return {};
}

function toolList(tools: Record<string, string>): string {
  const parts = Object.entries(tools)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, v]) => `${t} (v${v})`);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Builds the methods paragraph and a references list (pure). */
export function buildMethods(input: MethodsInput): { paragraph: string; markdown: string } {
  const data = input.organism ? `${input.organism} ${input.dataType ?? "sequencing"} data` : `${input.dataType ?? "Sequencing"} data`;
  const nf = input.nextflowVersion ? ` (v${cleanVersion(input.nextflowVersion)})` : "";
  const tools = toolList(input.tools);
  const engine = input.containerEngine === "conda" || input.containerEngine === "mamba"
    ? `${input.containerEngine} environments`
    : `${input.containerEngine} containers`;

  const sentences = [
    `${cap(data)} were processed with the ${input.pipelineName} pipeline (v${input.revision})`,
    `run with Nextflow${nf} using ${engine} for reproducibility.`,
  ];
  let paragraph = sentences.join(", ").replace(", run", ", run");
  if (tools) {
    paragraph += ` The workflow used ${tools}.`;
  }
  paragraph +=
    " Exact parameters and the full software-version record are provided in the run's " +
    "params.yaml and pipeline_info/ outputs, respectively.";

  const refs: string[] = [];
  if (input.pipelineCitation) {
    refs.push(input.pipelineCitation.doi
      ? `${input.pipelineCitation.text} doi:${input.pipelineCitation.doi}`
      : input.pipelineCitation.text);
  }
  refs.push(NFCORE_CITATION, NEXTFLOW_CITATION);

  const markdown = `# Methods

${paragraph}

## References

${refs.map((r) => `- ${r}`).join("\n")}

_Per-tool references are listed in the pipeline's CITATIONS.md and documentation._
`;
  return { paragraph, markdown };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Trims Nextflow's "version 25.10.4 build …" down to the number. */
function cleanVersion(v: string): string {
  const m = /(\d+\.\d+[\w.]*)/.exec(v);
  return m ? m[1] : v.replace(/^version\s+/i, "").trim();
}
