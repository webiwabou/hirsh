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
import { dirname, join, resolve } from "node:path";
import type { LLMProvider, ChatMessage } from "../llm/index.js";
import type { PipelineDefinition, ResultOutput } from "../pipelines/types.js";
import type { QueryContext } from "../conversation/session.js";
import { countVcfRecords, parseGeneralStats, summarizeTable } from "./parsers.js";

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

function describeTable(path: string): string {
  const text = readTextMaybeGzip(path);
  if (text === null) return "table present (too large to summarize inline).";
  const s = summarizeTable(text);
  const parts = [`${fmt(s.rows)} rows x ${s.cols} columns.`];
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
  }
  return parts.join(" ");
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

function walkVcfs(root: string, cap = 40, maxDepth = 5): string[] {
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
      } else if (/\.vcf(\.gz)?$/i.test(e) && out.length < cap) {
        out.push(full);
      }
    }
  }
  return out.sort();
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
export function gatherResults(pipeline: PipelineDefinition, outdir: string): ResultsReport {
  const absOut = resolve(outdir);
  const outputs: GatheredOutput[] = [];
  const htmlReports: string[] = [];

  for (const out of pipeline.results.outputs) {
    const absPath = join(absOut, out.path);
    const found = existsSync(absPath);
    let detail = "not found.";
    if (found) {
      if (out.kind === "multiqc_html") {
        detail = describeMultiqc(absPath);
        htmlReports.push(absPath);
      } else if (out.kind === "table") {
        detail = describeTable(absPath);
      } else if (out.kind === "vcf_dir") {
        detail = describeVcfDir(absPath);
      } else if (safeIsDir(absPath)) {
        detail = describeDirectory(absPath);
      } else {
        detail = "file present.";
      }
    }
    outputs.push({ output: out, absPath, found, detail });
  }

  return { outdir: absOut, outputs, htmlReports };
}

/** Generates the plain-language results summary using the LLM. */
export async function summarizeResults(
  provider: LLMProvider,
  pipeline: PipelineDefinition,
  query: QueryContext,
  report: ResultsReport,
  onToken: (chunk: string) => void,
): Promise<string> {
  const facts = report.outputs
    .map((o) => `• ${o.output.path} (${o.output.description})\n  → ${o.found ? o.detail : "NOT GENERATED"}`)
    .join("\n");

  const system = [
    "You are Hirsh, a bioinformatics assistant, in the INTERPRET-RESULTS phase.",
    "Summarize the findings for someone who understands biology but not the pipeline's technical detail.",
    "Use the concrete numbers provided (library sizes, QC metrics, variant counts); do not invent any.",
    "If an expected output was not generated, say so. Do not render HTML; only mention its location.",
    "Respond in English, in brief prose (not long lists).",
  ].join("\n");

  const user = [
    `Pipeline run: ${pipeline.name} — ${pipeline.title}.`,
    `User objective: ${query.objective ?? "(not specified)"}.`,
    `Organism: ${query.organism ?? "(not specified)"}.`,
    "",
    "Outputs found and their data:",
    facts,
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
