/**
 * Channel-type-aware wiring (Phase F4).
 *
 * Builds a workflow by tracking a typed "channel environment": each data kind
 * (reads, bam, vcf, fasta, gtf, indexes, reports, …) maps to the channel
 * expression currently producing it. For every module input channel we:
 *   - reuse a matching upstream channel, adapting the `meta` map, and building
 *     the full tuple when a channel bundles several files (e.g. fastp's
 *     `[meta, reads, adapter_fasta]`),
 *   - wire reference inputs (fasta/gtf/index/…) to pipeline params,
 *   - fill genuinely-optional / bundled add-on inputs with valid placeholders.
 * Module outputs are registered back into the environment; MultiQC-like
 * reporters collect all upstream report files into their tuple.
 *
 * Pure and unit-tested; the generator turns the result into files.
 */
import { primaryInput, processName, type ModuleInputChannel, type NfCoreModule } from "../modules/types.js";

/**
 * What the pipeline's own input channel carries, derived from the first module's
 * primary input rather than assumed to be reads. `reads` means the paired-FASTQ
 * channel shape `[ meta, [ reads ] ]`; otherwise it's a single file per sample
 * `[ meta, file ]` (e.g. a protein/nucleotide FASTA). The generator uses this to
 * emit the matching samplesheet reader, schema and test data.
 */
export interface InputSpec {
  /** Canonical data kind seeding ch_input (e.g. "reads", "fasta"). */
  kind: string;
  /** True for the paired-reads channel shape; false for a single-file channel. */
  reads: boolean;
}

/**
 * Determines the composed pipeline's entry input kind from the first module's
 * primary (first file) input. Falls back to reads when there's no module or no
 * file input. Pure.
 */
export function entryInputSpec(modules: NfCoreModule[]): InputSpec {
  const el = modules[0] ? primaryInput(modules[0]) : undefined;
  const kind = el ? classifyKind(el.name) : "reads";
  return { kind, reads: kind === "reads" };
}

/** The samplesheet column holding a single-file input's path, per data kind. Pure. */
export function inputColumn(kind: string): string {
  return kind === "fasta" ? "fasta" : kind;
}

/** A representative file extension for a single-file input kind (for test data). Pure. */
export function inputExtension(kind: string): string {
  const map: Record<string, string> = {
    fasta: "fasta",
    bam: "bam",
    cram: "cram",
    vcf: "vcf.gz",
    gtf: "gtf",
    gff: "gff",
    bed: "bed",
  };
  return map[kind] ?? kind;
}

export interface WiringResult {
  workflow: string;
  /** Reference param names that need a value (and a dummy file for the test profile). */
  referenceParams: string[];
  /** Human-readable notes about non-obvious wiring decisions. */
  notes: string[];
  /** What the pipeline's input channel carries (for the samplesheet reader/schema). */
  input: InputSpec;
}

interface EnvEntry {
  expr: string;
  /** Whether the channel elements are shaped [meta, ...] (carry a meta map). */
  meta: boolean;
}

const REFERENCE_KINDS = new Set(["fasta", "fai", "gtf", "gff", "bed", "dict", "index", "tbi"]);

/** Classifies a channel element / output channel into a canonical data kind. */
export function classifyKind(name: string, pattern?: string): string {
  const n = name.toLowerCase();
  const s = `${n} ${(pattern ?? "").toLowerCase()}`;
  if (n === "meta" || n.startsWith("meta")) return "meta";
  if (/\b(bai|csi|crai)\b/.test(n) || /\.(bai|csi|crai)/.test(s)) return "bam_index";
  if (/\btbi\b/.test(n) || /\.tbi/.test(s)) return "tbi";
  if (/\bfai\b/.test(n) || /\.fai\b/.test(s)) return "fai"; // avoid matching ".fail"
  if (/\bdict\b/.test(n) || /\.dict/.test(s)) return "dict";
  if (/read|fastq|\bfq\b|\.fq|\.fastq/.test(s)) return "reads";
  if (/\bbam\b/.test(n) || /\.bam/.test(s)) return "bam";
  if (/\bcram\b/.test(n) || /\.cram/.test(s)) return "cram";
  if (/\bsam\b/.test(n) || /\.sam/.test(s)) return "sam";
  if (/\bvcf\b/.test(n) || /\.vcf/.test(s)) return "vcf";
  if (/\bgtf\b/.test(n) || /\.gtf/.test(s)) return "gtf";
  if (/\bgff\b|gff3/.test(s)) return "gff";
  if (/\bbed\b/.test(n) || /\.bed/.test(s)) return "bed";
  if (/fasta|\.fa\b|\.fna|genome|\bfa\b/.test(s)) return "fasta";
  if (/index/.test(n)) return "index";
  if (/html|\.zip|\.json|\.log|report|multiqc|\.txt|\.tsv|stats|summary/.test(s)) return "report";
  return n.replace(/[^a-z0-9]/g, "_");
}

function channelHasMeta(ch: ModuleInputChannel): boolean {
  const first = ch.elements[0];
  return Boolean(first && (first.type === "map" || first.name.startsWith("meta")));
}

function fileElements(ch: ModuleInputChannel) {
  return ch.elements.filter((e) => e.type === "file" || e.type === "directory");
}

function adaptMeta(entry: EnvEntry, wantMeta: boolean): string {
  if (wantMeta === entry.meta) return entry.expr;
  if (wantMeta && !entry.meta) return `${entry.expr}.map { [ [:], it ] }`;
  return `${entry.expr}.map { it[1] }`;
}

/** Placeholder for a non-file (val) input channel. */
function valuePlaceholder(ch: ModuleInputChannel): string {
  const el = ch.elements[0];
  if (!el) return "[]";
  if (el.type === "string") return "''";
  if (el.type === "boolean") return "false";
  if (el.type === "integer" || el.type === "float") return "0";
  return "[]";
}

function isMultiqcLike(name: string): boolean {
  return /multiqc/.test(name.toLowerCase());
}

export function buildWorkflow(
  plan: { pipelineName: string; steps: { module: string }[] },
  modules: NfCoreModule[],
): WiringResult {
  const wf = `HIRSH_${plan.pipelineName.toUpperCase()}`;
  const includes = modules.map((m) => {
    const dir = m.local ? "local" : "nf-core";
    return `include { ${processName(m.name)} } from '../modules/${dir}/${m.name}/main'`;
  });

  const input = entryInputSpec(modules);
  const env = new Map<string, EnvEntry>();
  // Seed the environment with whatever the input channel actually carries, so a
  // downstream consumer of that kind anchors to ch_input (a protein FASTA feeds a
  // FASTA consumer, not only a reads consumer).
  env.set(input.kind, { expr: "ch_input", meta: true });
  const reportExprs: string[] = [];
  const referenceParams = new Set<string>();
  const notes: string[] = [];
  // Modern nf-core modules publish versions to the `versions` channel topic, so
  // we collect them globally at the emit rather than mixing per module.
  const body: string[] = [];

  /** Placeholder for one extra file element bundled inside a tuple. */
  const bundledExtra = (name: string): string => {
    if (REFERENCE_KINDS.has(classifyKind(name))) {
      referenceParams.add(name);
      return `file(params.${name})`;
    }
    return "[]";
  };

  /** Resolves one input channel of a module to a call argument expression. */
  const resolveChannel = (ch: ModuleInputChannel, proc: string): string => {
    const files = fileElements(ch);
    const wantMeta = channelHasMeta(ch);
    if (files.length === 0) return valuePlaceholder(ch);

    // Anchor: the first file whose kind is already produced upstream.
    let anchorPos = -1;
    let anchor: EnvEntry | undefined;
    for (let i = 0; i < files.length; i++) {
      const entry = env.get(classifyKind(files[i].name));
      if (entry) {
        anchorPos = i;
        anchor = entry;
        break;
      }
    }

    if (anchor) {
      if (files.length === 1) return adaptMeta(anchor, wantMeta);
      // Multi-file tuple: rebuild [ meta, <files...> ] carrying the anchor file.
      if (wantMeta && anchor.meta) {
        const parts = files.map((f, i) => (i === anchorPos ? "it[1]" : bundledExtra(f.name)));
        return `${anchor.expr}.map { [ it[0], ${parts.join(", ")} ] }`;
      }
      return adaptMeta(anchor, wantMeta);
    }

    // No upstream source for this channel.
    if (files.length === 1) {
      const f = files[0];
      const kind = classifyKind(f.name);
      if (REFERENCE_KINDS.has(kind)) {
        referenceParams.add(f.name);
        return wantMeta ? `[ [ id:'${f.name}' ], file(params.${f.name}) ]` : `file(params.${f.name})`;
      }
      if (f.optional) return wantMeta ? "[ [:], [] ]" : "[]";
      referenceParams.add(f.name);
      notes.push(`${proc}: required input '${f.name}' (${kind}) had no upstream source; wired to params.${f.name} — set it for a real run.`);
      return wantMeta ? `[ [ id:'${f.name}' ], file(params.${f.name}) ]` : `file(params.${f.name})`;
    }
    // Multi-file, no anchor: build a value tuple of placeholders/params.
    const parts = files.map((f) => bundledExtra(f.name));
    return wantMeta ? `[ [:], ${parts.join(", ")} ]` : `[ ${parts.join(", ")} ]`;
  };

  for (const mod of modules) {
    const proc = processName(mod.name);

    if (isMultiqcLike(mod.name)) {
      body.push("    ch_multiqc_files = Channel.empty()");
      for (const rep of reportExprs) {
        body.push(`    ch_multiqc_files = ch_multiqc_files.mix( ${rep}.map { it instanceof List ? it[1] : it } )`);
      }
      const ch0 = mod.inputs[0] ?? { elements: [] };
      const extraSlots = Math.max(0, fileElements(ch0).length - 1);
      const empties = ", []".repeat(extraSlots);
      const firstArg = channelHasMeta(ch0)
        ? `ch_multiqc_files.collect().map { [ [ id:'multiqc' ], it${empties} ] }`
        : "ch_multiqc_files.collect()";
      const rest = mod.inputs.slice(1).map((ch) =>
        channelHasMeta(ch) ? "[ [:], [] ]" : fileElements(ch).length ? "[]" : valuePlaceholder(ch),
      );
      body.push(`    ${proc} ( ${[firstArg, ...rest].join(", ")} )`, "");
      continue;
    }

    const args = mod.inputs.map((ch) => resolveChannel(ch, proc));
    body.push(`    ${proc} ( ${args.join(", ")} )`, "");

    // Register outputs into the environment for downstream steps. When a module
    // emits several outputs of the same kind (e.g. fastp's reads / reads_merged /
    // reads_fail), prefer the one whose emit name matches the kind exactly, then
    // the shortest — so the main data stream, not a side output, flows on.
    const bestByKind = new Map<string, { name: string; meta: boolean; expr: string }>();
    for (const out of mod.outputs) {
      const outFiles = out.elements.filter((e) => e.type === "file" || e.type === "directory");
      if (outFiles.length === 0) continue;
      const kind = classifyKind(out.name, outFiles[0]?.name);
      const outMeta = out.elements[0]?.type === "map" || out.elements[0]?.name.startsWith("meta");
      const expr = `${proc}.out.${out.name}`;
      if (kind === "report") {
        reportExprs.push(expr);
        continue;
      }
      const existing = bestByKind.get(kind);
      const better =
        !existing ||
        (out.name === kind && existing.name !== kind) ||
        (existing.name !== kind && out.name.length < existing.name.length);
      if (better) bestByKind.set(kind, { name: out.name, meta: outMeta, expr });
    }
    for (const [kind, best] of bestByKind) {
      env.set(kind, { expr: best.expr, meta: best.meta });
    }
  }

  const takeComment = input.reads
    ? "channel: [ val(meta), [ path(reads) ] ]"
    : `channel: [ val(meta), path(${input.kind}) ]`;
  const lines = [
    "// Auto-generated by Hirsh — channel-type-matched wiring.",
    "",
    includes.join("\n"),
    "",
    `workflow ${wf} {`,
    "    take:",
    `    ch_input   // ${takeComment}`,
    "",
    "    main:",
    body.join("\n"),
    "    emit:",
    "    versions = Channel.topic('versions')   // nf-core modules publish here",
    "}",
    "",
  ];

  return { workflow: lines.join("\n"), referenceParams: [...referenceParams], notes, input };
}
