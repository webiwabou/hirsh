/**
 * Auto-curating a catalog pipeline into a persistent registry definition.
 *
 * When Hirsh runs a not-yet-curated nf-core pipeline via its schema
 * (`nfcoreSchema.ts`), it can also *learn* it permanently: this module turns the
 * synthesized schema spec + catalog metadata into a full `PipelineDefinition`
 * YAML, which — dropped into the user's definitions directory — makes the
 * pipeline a first-class, guided pipeline next session.
 *
 * The generated definition is honest about being auto-derived: it covers params
 * and the samplesheet (which the schema fully specifies) but leaves results
 * interpretation generic (the schema doesn't say where outputs land) for a human
 * to refine. Pure (spec in, object/string out) so it is unit-tested.
 */
import { stringify as stringifyYaml } from "yaml";
import type {
  ParamType,
  PipelineDefinition,
  PipelineParam,
  ResultOutput,
  SamplesheetColumn,
} from "./types.js";
import type { InputColumn, SynthParam, SynthesizedSpec } from "./nfcoreSchema.js";

/** Minimal catalog metadata needed to curate a definition. */
export interface DefinitionSource {
  /** Full identifier, e.g. "nf-core/atacseq". */
  fullName: string;
  description: string;
  topics: string[];
  /** Pinned revision (a released tag). */
  revision: string;
  url: string;
}

function paramType(kind: SynthParam["kind"]): ParamType {
  switch (kind) {
    case "file":
    case "directory":
      return "path";
    case "enum":
      return "enum";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "string";
  }
}

/** Infers a human data-type line from the samplesheet columns. */
function inferDataType(columns: InputColumn[]): string {
  const names = columns.map((c) => c.name.toLowerCase());
  if (names.some((n) => n.startsWith("fastq") || n === "fastq_1" || n === "fastq_2")) {
    return "Sequencing reads (FASTQ), as declared by the pipeline's input schema.";
  }
  if (names.some((n) => n.includes("bam") || n.includes("cram"))) {
    return "Aligned reads (BAM/CRAM), as declared by the pipeline's input schema.";
  }
  if (names.some((n) => n.includes("fasta") || n.includes("fa"))) {
    return "FASTA sequences, as declared by the pipeline's input schema.";
  }
  return "See the pipeline's documentation (auto-derived from its input schema).";
}

/** Builds `useWhen` hints from the catalog topics (falling back to the description). */
function buildUseWhen(source: DefinitionSource): string[] {
  const hints = source.topics
    .slice(0, 4)
    .map((t) => `The analysis involves ${t.replace(/[-_]/g, " ")}.`);
  if (source.description) hints.push(`Matches: ${source.description}`);
  return hints.length > 0 ? hints : [`Matches: ${source.fullName}`];
}

function columnDescription(col: InputColumn): string {
  if (col.name === "sample") return "Sample identifier.";
  if (col.isFile) return `Path to the ${col.name} file.`;
  return `${col.name} value${col.required ? "" : " (optional)"}.`;
}

/**
 * Builds a full `PipelineDefinition` from a catalog pipeline's synthesized schema
 * spec. Params and samplesheet columns come straight from the schema; results are
 * left as a single generic directory for a human to refine. Pure.
 */
export function buildSynthesizedDefinition(
  source: DefinitionSource,
  spec: SynthesizedSpec,
): PipelineDefinition {
  const columns: SamplesheetColumn[] = spec.columns.map((c) => ({
    name: c.name,
    required: c.required,
    description: columnDescription(c),
  }));

  const params: PipelineParam[] = [
    {
      name: "input",
      type: "path",
      required: true,
      providedBySamplesheet: true,
      description: "Path to the samplesheet.csv with the samples. Built by the agent.",
    },
    {
      name: "outdir",
      type: "path",
      required: true,
      description: "Directory where results are written.",
    },
  ];
  for (const p of spec.params) {
    if (p.name === "input" || p.name === "outdir") continue;
    const param: PipelineParam = {
      name: p.name,
      type: paramType(p.kind),
      required: p.required,
      description: p.description || `${p.name} (auto-derived from the pipeline schema).`,
    };
    if (p.choices && p.choices.length > 0) param.choices = p.choices;
    if (p.default !== undefined) param.default = p.default;
    params.push(param);
  }

  const outputs: ResultOutput[] = [
    {
      path: ".",
      kind: "directory",
      description:
        "All pipeline outputs. Auto-generated definition — refine these output paths " +
        "(e.g. the MultiQC report and key tables) for richer, per-file interpretation.",
    },
  ];

  return {
    name: source.fullName,
    version: source.revision,
    citation: {
      text: `${source.fullName}: ${source.description || "nf-core pipeline"}. Available at ${source.url}.`,
    },
    title: source.description || source.fullName,
    purpose:
      source.description ||
      `${source.fullName}, an established nf-core pipeline (auto-curated from its schema).`,
    useWhen: buildUseWhen(source),
    organisms: "Any organism supported by the pipeline (see its documentation).",
    dataType: inferDataType(spec.columns),
    samplesheet: {
      filename: "samplesheet.csv",
      description:
        "One row per sample, following the pipeline's input schema. Columns are derived from " +
        "the pipeline's own assets/schema_input.json.",
      columns,
    },
    params,
    profiles: { recommended: "docker", hasTestProfile: true, testProfile: "test" },
    results: { outdirParam: "outdir", outputs },
  };
}

/** File-safe base name for a definition, e.g. "nf-core/atacseq" → "nf-core-atacseq". */
export function definitionFileName(fullName: string): string {
  return fullName.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() + ".yaml";
}

/**
 * Renders a definition to YAML with a provenance header stating plainly that it
 * was auto-generated and what a human should refine. Pure.
 */
export function renderDefinitionYaml(def: PipelineDefinition, generatedOn: string): string {
  const header = [
    `# Auto-generated by Hirsh from ${def.name}'s nextflow_schema.json (revision ${def.version}) on ${generatedOn}.`,
    "# It makes the pipeline GUIDED (parameters + samplesheet, straight from the schema),",
    "# but it was NOT hand-curated. To improve it:",
    "#   - results.outputs is a single generic directory — set real output paths",
    "#     (e.g. the MultiQC report, key tables) for richer results interpretation;",
    "#   - add a resources block for a real memory/CPU pre-flight;",
    "#   - refine purpose/useWhen/dataType and add the citation DOI.",
    "# Delete this file to fall back to the on-the-fly schema-driven flow.",
    "",
  ].join("\n");
  return header + stringifyYaml(def);
}
