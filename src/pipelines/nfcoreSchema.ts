/**
 * Synthesizing a runnable parameter interview from an nf-core pipeline's own
 * schemas.
 *
 * Every nf-core pipeline ships a `nextflow_schema.json` (its parameters) and an
 * `assets/schema_input.json` (its samplesheet columns). Curated pipelines encode
 * this by hand; this module derives the essentials on the fly for the ~100
 * pipelines Hirsh does *not* curate, so it can run one on the scientist's own
 * data — asking only for the samplesheet and the reference inputs the pipeline
 * actually needs, instead of demanding hand-written config.
 *
 * The parsing/classification is pure (JSON in, data out) and unit-tested without
 * network; a thin async fetch pairs it with the two raw schema files.
 */
import { collectSchemaProperties, type SchemaProp } from "./schemaCheck.js";
import type { ColumnSpec } from "../execution/samplesheet.js";

export interface SynthParam {
  /** Flag name without "--". */
  name: string;
  kind: "file" | "directory" | "enum" | "string" | "number" | "boolean";
  required: boolean;
  choices?: string[];
  default?: string | number | boolean;
  description: string;
  /** Looks like a reference input (genome/annotation/index) worth asking about. */
  reference: boolean;
}

export interface InputColumn {
  name: string;
  required: boolean;
  /** Column holds a file path (nf-core `format: file-path`). */
  isFile: boolean;
}

/** Params handled specially by the runner, never asked as free-form fields. */
const HANDLED = new Set(["input", "outdir"]);

/** Names that mark a file/directory param as a biological reference to ask for. */
const REFERENCE_RE =
  /(genome|fasta|fna|gtf|gff|bed|dict|index|bwa|bowtie|star|salmon|hisat|kallisto|reference|annotation|transcriptome|dbsnp|known|germline|blacklist|mito|proteome|gene_?bed)/i;

/**
 * Collects every parameter name marked `required` anywhere in the schema. nf-core
 * puts `required: [...]` inside each parameter group (definitions/$defs), not at
 * the root, so we walk the same structure `collectSchemaProperties` does.
 */
export function collectRequiredParams(schema: unknown): Set<string> {
  const required = new Set<string>();
  const visit = (obj: unknown): void => {
    if (!obj || typeof obj !== "object") return;
    const o = obj as Record<string, unknown>;
    if (Array.isArray(o.required)) {
      for (const r of o.required) if (typeof r === "string") required.add(r);
    }
    for (const key of ["definitions", "$defs"]) {
      const section = o[key];
      if (section && typeof section === "object") Object.values(section).forEach(visit);
    }
    if (Array.isArray(o.allOf)) o.allOf.forEach(visit);
  };
  visit(schema);
  return required;
}

function classifyKind(spec: SchemaProp): SynthParam["kind"] {
  if (Array.isArray(spec.enum) && spec.enum.length > 0) return "enum";
  const format = typeof spec.format === "string" ? spec.format : "";
  if (format === "file-path") return "file";
  if (format === "directory-path") return "directory";
  const type = typeof spec.type === "string" ? spec.type : "string";
  if (type === "integer" || type === "number") return "number";
  if (type === "boolean") return "boolean";
  return "string";
}

function scalarDefault(v: unknown): string | number | boolean | undefined {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  return undefined;
}

/**
 * Derives the parameters worth interviewing the scientist about from a pipeline's
 * `nextflow_schema.json`: the strictly-required ones, the biological references
 * (genome/annotation/index files), and enum choices. Deliberately excludes
 * `input`/`outdir` (handled by the runner), hidden params, and the long tail of
 * optional boolean/tuning flags — a curated definition asks for a handful of
 * things, and so should this. Pure.
 */
export function synthesizeSchemaParams(schema: unknown): SynthParam[] {
  const props = collectSchemaProperties(schema);
  const required = collectRequiredParams(schema);
  const out: SynthParam[] = [];
  for (const [name, spec] of props) {
    if (HANDLED.has(name)) continue;
    if (spec.hidden === true) continue;
    const kind = classifyKind(spec);
    const isRequired = required.has(name);
    const isFileish = kind === "file" || kind === "directory";
    const reference = isFileish && (REFERENCE_RE.test(name) || name === "genome");
    // Keep required params, biological references and the iGenomes `genome` key.
    // Everything else — optional flags, plain strings, and optional enums (nf-core
    // ships sensible defaults) — is left at its default to keep the interview as
    // short as a curated pipeline's (a scientist shouldn't face 15 tuning knobs).
    const genomeKey = name === "genome";
    if (!isRequired && !reference && !genomeKey) continue;
    out.push({
      name,
      kind,
      required: isRequired,
      choices: Array.isArray(spec.enum)
        ? spec.enum.filter((e): e is string => typeof e === "string")
        : undefined,
      default: scalarDefault(spec.default),
      description: typeof spec.description === "string" ? spec.description.trim() : "",
      reference: reference || genomeKey,
    });
  }
  // Required first, then references, then the rest; stable by name within a tier.
  const tier = (p: SynthParam) => (p.required ? 0 : p.reference ? 1 : 2);
  out.sort((a, b) => tier(a) - tier(b) || a.name.localeCompare(b.name));
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parses an nf-core `assets/schema_input.json` into the samplesheet's columns:
 * their names, which are required, and which hold file paths. Pure.
 */
export function parseInputSchema(inputSchema: unknown): InputColumn[] {
  const root = isRecord(inputSchema) ? inputSchema : {};
  // The row shape lives under `items` (array-of-rows schema); fall back to root.
  const items = isRecord(root.items) ? root.items : root;
  const props = isRecord(items.properties) ? items.properties : {};
  const required = new Set(
    Array.isArray(items.required) ? items.required.filter((r): r is string => typeof r === "string") : [],
  );
  const cols: InputColumn[] = [];
  for (const [name, spec] of Object.entries(props)) {
    const s = isRecord(spec) ? spec : {};
    cols.push({
      name,
      required: required.has(name),
      isFile: s.format === "file-path",
    });
  }
  return cols;
}

/** Bridges parsed columns to the existing samplesheet validator's spec. */
export function toColumnSpecs(cols: InputColumn[]): ColumnSpec[] {
  return cols.map((c) => ({ name: c.name, required: c.required }));
}

export interface SynthesizedSpec {
  params: SynthParam[];
  columns: InputColumn[];
}

async function fetchRawJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Fetches a pipeline's `nextflow_schema.json` (+ `assets/schema_input.json` when
 * present) at a pinned revision and synthesizes the parameter interview and the
 * samplesheet columns. Returns null only when the parameter schema is
 * unreachable; a missing input schema yields empty columns (rare).
 */
export async function fetchSynthesizedSpec(
  pipeline: string,
  revision: string,
): Promise<SynthesizedSpec | null> {
  const short = pipeline.replace(/^nf-core\//, "");
  const base = `https://raw.githubusercontent.com/nf-core/${short}/${revision}`;
  const schema = await fetchRawJson(`${base}/nextflow_schema.json`);
  if (schema === null) return null;
  const inputSchema = await fetchRawJson(`${base}/assets/schema_input.json`);
  return {
    params: synthesizeSchemaParams(schema),
    columns: inputSchema === null ? [] : parseInputSchema(inputSchema),
  };
}

/**
 * True when the samplesheet's required columns are only sample + FASTQ paths, so
 * Hirsh can safely build it from a folder of reads (its existing pair inference).
 * When a pipeline requires extra per-sample columns (replicate, condition,
 * strandedness…), auto-building would guess biology — so we ask for a ready CSV.
 */
export function isSimpleFastqSheet(cols: InputColumn[]): boolean {
  const req = cols.filter((c) => c.required).map((c) => c.name);
  if (req.length === 0) return false;
  const allowed = new Set(["sample", "fastq_1", "fastq_2"]);
  return req.every((n) => allowed.has(n));
}
