/**
 * Phase E — results interpretation.
 *
 * Locates the relevant outputs declared in the pipeline definition, extracts the
 * concrete numbers a biologist cares about (per-sample library sizes from count
 * matrices, MultiQC general-stats, variant counts from VCFs) and asks the LLM for
 * a plain-language summary grounded in those figures. HTML (MultiQC) is not
 * rendered: its path is reported instead.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import type { LLMProvider, ChatMessage } from "../llm/index.js";
import type { ResultOutput } from "../pipelines/types.js";
import type { QueryContext } from "../conversation/session.js";
import { countDifferential, countVcfRecords, parseGeneralStats, summarizeTable } from "./parsers.js";
import type { ChartData } from "./charts.js";

/**
 * The minimal shape the interpreter needs. A full PipelineDefinition satisfies
 * it, and so does a synthesized follow-up (e.g. differentialabundance), so a
 * chained analysis is interpreted the same way as a primary run.
 */
export interface InterpretablePipeline {
  name: string;
  title: string;
  results: { outputs: ResultOutput[] };
}

export interface GatheredOutput {
  output: ResultOutput;
  absPath: string;
  found: boolean;
  /** Factual description of what was found (numbers, not just file listings). */
  detail: string;
}

export interface ResultsReport {
  outdir: string;
  outputs: GatheredOutput[];
  /** Paths of HTML reports for the user to open. */
  htmlReports: string[];
  /** Small inline charts of the key numbers, for the terminal. */
  charts?: ChartData[];
}

const MAX_READ_BYTES = 60_000_000;

function readTextMaybeGzip(path: string, maxBytes = MAX_READ_BYTES): string | null {
  try {
    if (statSync(path).size > maxBytes) return null;
    const buf = readFileSync(path);
    return path.endsWith(".gz") ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
  } catch {
    return null;
  }
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** Describes a count/TPM-style table and, when it has per-column totals, a chart. */
function describeTable(path: string, label: string): { detail: string; chart?: ChartData } {
  const text = readTextMaybeGzip(path);
  if (text === null) return { detail: "table present (too large to summarize inline)." };
  const s = summarizeTable(text);
  const parts = [`${fmt(s.rows)} rows x ${s.cols} columns.`];
  let chart: ChartData | undefined;
  if (s.numericColumns.length > 0) {
    const sizes = s.numericColumns
      .slice(0, 6)
      .map((c) => `${c}=${fmt(s.columnSums[c] ?? 0)}`)
      .join(", ");
    parts.push(
      `${s.numericColumns.length} numeric column(s); per-column totals: ${sizes}${
        s.numericColumns.length > 6 ? ", …" : ""
      }.`,
    );
    if (s.numericColumns.length >= 2) {
      chart = {
        title: `${label} — per-column totals`,
        items: s.numericColumns.slice(0, 12).map((c) => ({ label: c, value: s.columnSums[c] ?? 0 })),
      };
    }
  }
  return { detail: parts.join(" "), chart };
}

/** Finds the MultiQC general-stats table sitting next to a MultiQC report. */
function findGeneralStats(htmlPath: string): string | null {
  const dir = dirname(htmlPath);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const dataDir = entries.find((e) => e === "multiqc_data" || e.endsWith("_data"));
  const candidates = [
    dataDir ? join(dir, dataDir, "multiqc_general_stats.txt") : "",
    join(dir, "multiqc_data", "multiqc_general_stats.txt"),
  ].filter(Boolean);
  return candidates.find((c) => existsSync(c)) ?? null;
}

function describeMultiqc(htmlPath: string): string {
  const stats = findGeneralStats(htmlPath);
  if (!stats) return "HTML report available.";
  const text = readTextMaybeGzip(stats);
  if (text === null) return "HTML report available (general-stats table unreadable).";
  const g = parseGeneralStats(text);
  if (g.sampleCount === 0) return "HTML report available.";
  const shownMetrics = g.metrics.slice(0, 4);
  const rows = g.perSample
    .slice(0, 8)
    .map((s) => `${s.sample}: ${shownMetrics.map((m) => `${m}=${s.values[m]}`).join(", ")}`)
    .join("\n    ");
  return [
    `HTML report available; general stats for ${g.sampleCount} sample(s).`,
    `Metrics: ${shownMetrics.join(", ")}${g.metrics.length > 4 ? ", …" : ""}.`,
    `Per sample:\n    ${rows}${g.perSample.length > 8 ? "\n    …" : ""}`,
  ].join("\n  ");
}

/** Depth-bounded recursive file search matching a name predicate. */
function walkFiles(root: string, test: (name: string) => boolean, cap = 40, maxDepth = 5): string[] {
  const out: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && out.length < cap) {
    const { dir, depth } = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
      } else if (test(e) && out.length < cap) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function walkVcfs(root: string, cap = 40, maxDepth = 5): string[] {
  return walkFiles(root, (e) => /\.vcf(\.gz)?$/i.test(e), cap, maxDepth);
}

/** HTML reports anywhere under a directory (e.g. a follow-up's report/ folder). */
export function findHtmlReports(root: string, cap = 5): string[] {
  return walkFiles(root, (e) => /\.html?$/i.test(e), cap, 4);
}

/** All files under a directory, as paths relative to it (for learning outputs). */
export function listRelativeFiles(root: string, cap = 600): string[] {
  return walkFiles(root, () => true, cap, 6).map((p) => relative(root, p));
}

/**
 * Describes a directory of per-contrast differential-expression tables with
 * concrete numbers: how many genes were significant (and up/down) per contrast.
 * Falls back to a plain directory listing when no differential tables are found.
 */
function describeDiffDir(path: string, label: string): { detail: string; chart?: ChartData } {
  const files = walkFiles(path, (e) => /\.(tsv|csv|txt)(\.gz)?$/i.test(e), 60, 4);
  const lines: string[] = [];
  const items: ChartData["items"] = [];
  let contrasts = 0;
  let totalSig = 0;
  for (const file of files) {
    const text = readTextMaybeGzip(file);
    if (text === null) continue;
    const d = countDifferential(text);
    if (!d.padjColumn) continue; // not a differential table
    contrasts++;
    totalSig += d.significant;
    items.push({ label: basename(file).replace(/\.(tsv|csv|txt)(\.gz)?$/i, ""), value: d.significant });
    const thresh = `padj<${d.alpha}${d.lfcColumn ? `, |log2FC|>${d.lfcThreshold}` : ""}`;
    lines.push(
      `${basename(file)}: ${fmt(d.significant)} of ${fmt(d.tested)} tested genes significant (${thresh})` +
        (d.lfcColumn ? ` — ${fmt(d.up)} up, ${fmt(d.down)} down` : ""),
    );
  }
  if (contrasts === 0) return { detail: describeDirectory(path) };
  const detail = [
    `${contrasts} contrast(s), ${fmt(totalSig)} significant gene(s) total.`,
    ...lines.slice(0, 8).map((l) => "    " + l),
    lines.length > 8 ? "    …" : "",
  ]
    .filter(Boolean)
    .join("\n  ");
  const chart = items.length >= 2 ? { title: `${label} — significant genes per contrast`, items } : undefined;
  return { detail, chart };
}

function describeVcfDir(path: string): string {
  const vcfs = walkVcfs(path);
  if (vcfs.length === 0) return describeDirectory(path);
  let total = 0;
  const perFile: string[] = [];
  for (const vcf of vcfs) {
    const text = readTextMaybeGzip(vcf);
    if (text === null) {
      perFile.push(`${basename(vcf)}: (too large to count)`);
      continue;
    }
    const n = countVcfRecords(text);
    total += n;
    perFile.push(`${basename(vcf)}: ${fmt(n)} variants`);
  }
  return [
    `${vcfs.length} VCF file(s), ${fmt(total)} variants total.`,
    ...perFile.slice(0, 8).map((l) => "    " + l),
    perFile.length > 8 ? "    …" : "",
  ]
    .filter(Boolean)
    .join("\n  ");
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function describeDirectory(path: string): string {
  try {
    const entries = readdirSync(path);
    const preview = entries.slice(0, 12).join(", ");
    return `${entries.length} items. ${preview}${entries.length > 12 ? ", …" : ""}`;
  } catch (err) {
    return `could not list: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Walks the declared outputs and collects concrete facts about what exists. */
export function gatherResults(pipeline: InterpretablePipeline, outdir: string): ResultsReport {
  const absOut = resolve(outdir);
  const outputs: GatheredOutput[] = [];
  const htmlReports: string[] = [];
  const charts: ChartData[] = [];

  for (const out of pipeline.results.outputs) {
    const absPath = join(absOut, out.path);
    const found = existsSync(absPath);
    let detail = "not found.";
    if (found) {
      if (out.kind === "multiqc_html") {
        detail = describeMultiqc(absPath);
        htmlReports.push(absPath);
      } else if (out.kind === "table") {
        const r = describeTable(absPath, out.path);
        detail = r.detail;
        if (r.chart) charts.push(r.chart);
      } else if (out.kind === "vcf_dir") {
        detail = describeVcfDir(absPath);
      } else if (out.kind === "de_table_dir") {
        const r = describeDiffDir(absPath, out.path);
        detail = r.detail;
        if (r.chart) charts.push(r.chart);
      } else if (safeIsDir(absPath)) {
        detail = describeDirectory(absPath);
      } else {
        detail = "file present.";
      }
    }
    outputs.push({ output: out, absPath, found, detail });
  }

  return { outdir: absOut, outputs, htmlReports, charts };
}

/** Generates the plain-language results summary using the LLM. */
export async function summarizeResults(
  provider: LLMProvider,
  pipeline: InterpretablePipeline,
  query: QueryContext,
  report: ResultsReport,
  onToken: (chunk: string) => void,
  designNotes: string[] = [],
): Promise<string> {
  const facts = report.outputs
    .map((o) => `• ${o.output.path} (${o.output.description})\n  → ${o.found ? o.detail : "NOT GENERATED"}`)
    .join("\n");

  const system = [
    "You are Hirsh, a bioinformatics co-scientist, in the INTERPRET-RESULTS phase.",
    "Explain the findings for someone who understands biology but not the pipeline's technical detail.",
    "Use the concrete numbers provided (library sizes, QC metrics, variant counts); do not invent any.",
    "Go beyond restating numbers: say what they mean BIOLOGICALLY in the context of the user's",
    "objective, and whether the run looks trustworthy (e.g. flag samples with outlier QC).",
    "If experimental-design caveats were flagged before the run (e.g. low replication, batch",
    "effects), revisit them here and state honestly how they could affect these results.",
    "If an expected output was not generated, say so. Do not render HTML; only mention its location.",
    "End with one concrete, appropriate next step. Be honest about limitations; do not overstate.",
    "Respond in English, in brief prose (not long lists).",
  ].join("\n");

  const user = [
    `Pipeline run: ${pipeline.name} — ${pipeline.title}.`,
    `User objective: ${query.objective ?? "(not specified)"}.`,
    `Organism: ${query.organism ?? "(not specified)"}.`,
    `Experimental design: ${query.experimentalDesign ?? "(not specified)"}.`,
    "",
    "Outputs found and their data:",
    facts,
    "",
    designNotes.length
      ? `Design caveats flagged before the run (revisit their impact on these results):\n${designNotes
          .map((n) => `- ${n}`)
          .join("\n")}`
      : "No design caveats were flagged before the run.",
    "",
    report.htmlReports.length
      ? `HTML reports (mention their path so they can be opened): ${report.htmlReports.join(", ")}`
      : "No HTML reports were generated.",
  ].join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];

  const resp = await provider.chat({ messages, onToken });
  return resp.text;
}
