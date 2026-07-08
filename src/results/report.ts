/**
 * Self-contained HTML results report (Phase 6 — publication-ready output).
 *
 * A co-scientist hands over *science*, not logs: after interpreting a run, Hirsh
 * writes a single, dependency-free `REPORT.html` into the run directory that
 * bundles the plain-language interpretation, the key numbers, inline **SVG
 * figures** (no external libraries), and links to the MultiQC report, methods and
 * provenance. It opens in any browser and is safe to share or archive.
 *
 * Pure (data in, HTML string out) so it is unit-tested. SVG is inlined, so the
 * file has no external dependencies.
 */
import type { ChartData } from "./charts.js";
import type { VolcanoData } from "./parsers.js";
import type { QueryContext } from "../conversation/session.js";

export interface ReportOutputFact {
  path: string;
  description: string;
  found: boolean;
  detail: string;
}

export interface ReportArtifact {
  label: string;
  path: string;
}

export interface ResultsReportInput {
  pipelineName: string;
  pipelineTitle: string;
  query: QueryContext;
  outdir: string;
  outputs: ReportOutputFact[];
  charts: ChartData[];
  /** The plain-language interpretation prose (as produced by the LLM). */
  summaryText: string;
  /** Differential-expression volcano plots (one per contrast), if any. */
  volcanoFigures?: VolcanoFigure[];
  /** Paths of HTML reports (e.g. MultiQC) to link. */
  htmlReports: string[];
  /** Other files to link (methods, provenance, params). */
  artifacts: ReportArtifact[];
  /** Actual tool → version used (from nf-core software_versions), for methods. */
  tools?: Record<string, string>;
  /** ISO-ish date string, e.g. "2026-07-07". */
  generatedOn: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/** -log10 with a floor, matching the parser's y-axis mapping. */
function negLog10(p: number): number {
  return -Math.log10(Math.max(p, 1e-300));
}

/** Turns interpretation prose into HTML paragraphs (blank line = new paragraph). */
function proseToHtml(text: string): string {
  const paras = text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length === 0) return "<p class=\"muted\">No summary was produced.</p>";
  return paras.map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("\n");
}

/**
 * Renders a horizontal bar chart as a standalone SVG (no external deps). Bars are
 * scaled to the largest value; labels and values are drawn as text. Pure.
 */
export function chartToSvg(chart: ChartData, opts: { width?: number } = {}): string {
  const width = opts.width ?? 560;
  const items = chart.items.slice(0, 20);
  if (items.length === 0) return "";
  const rowH = 26;
  const labelW = 150;
  const valueW = 90;
  const barMax = Math.max(40, width - labelW - valueW - 20);
  const top = 8;
  const height = top * 2 + items.length * rowH;
  const max = Math.max(0, ...items.map((i) => i.value));

  const rows = items
    .map((it, idx) => {
      const y = top + idx * rowH;
      const barW = max > 0 ? Math.max(1, Math.round((Math.max(0, it.value) / max) * barMax)) : 0;
      const label = it.label.length > 22 ? it.label.slice(0, 21) + "…" : it.label;
      return [
        `<text x="0" y="${y + 17}" class="lbl">${esc(label)}</text>`,
        `<rect x="${labelW}" y="${y + 4}" width="${barW}" height="16" rx="3" class="bar"/>`,
        `<text x="${labelW + barW + 6}" y="${y + 17}" class="val">${esc(fmt(it.value))}</text>`,
      ].join("");
    })
    .join("\n");

  return [
    `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(chart.title)}" xmlns="http://www.w3.org/2000/svg">`,
    `<style>`,
    `.lbl{font:12px system-ui,sans-serif;fill:#334155}`,
    `.val{font:12px system-ui,sans-serif;fill:#475569}`,
    `.bar{fill:#2563eb}`,
    `</style>`,
    rows,
    `</svg>`,
  ].join("\n");
}

export interface VolcanoFigure {
  title: string;
  data: VolcanoData;
}

const VOLCANO_COLORS = { up: "#dc2626", down: "#2563eb", ns: "#cbd5e1" } as const;

/**
 * Renders a differential-expression volcano plot (log2FC vs -log10 padj) as a
 * standalone SVG: significant up/down genes coloured, thresholds drawn as dashed
 * guides. No external deps. Pure.
 */
export function volcanoToSvg(data: VolcanoData, opts: { width?: number; height?: number } = {}): string {
  const width = opts.width ?? 560;
  const height = opts.height ?? 340;
  const m = { top: 12, right: 12, bottom: 40, left: 46 };
  const pw = width - m.left - m.right;
  const ph = height - m.top - m.bottom;
  if (data.points.length === 0) return "";

  const xAbs = Math.max(data.lfcThreshold * 1.5, ...data.points.map((p) => Math.abs(p.x)));
  const yMax = Math.max(negLog10(data.alpha) * 1.2, ...data.points.map((p) => p.y), 1);
  const sx = (x: number) => m.left + ((x + xAbs) / (2 * xAbs)) * pw;
  const sy = (y: number) => m.top + ph - (y / yMax) * ph;
  const r2 = (n: number) => Math.round(n * 10) / 10;

  // Draw non-significant first (background), then significant on top.
  const ordered = [...data.points].sort((a, b) => (a.cls === "ns" ? -1 : 1) - (b.cls === "ns" ? -1 : 1));
  const dots = ordered
    .map((p) => `<circle cx="${r2(sx(p.x))}" cy="${r2(sy(p.y))}" r="1.7" fill="${VOLCANO_COLORS[p.cls]}"/>`)
    .join("");

  const yThresh = sy(negLog10(data.alpha));
  const xNeg = sx(-data.lfcThreshold);
  const xPos = sx(data.lfcThreshold);
  const guides = [
    `<line x1="${m.left}" y1="${r2(yThresh)}" x2="${m.left + pw}" y2="${r2(yThresh)}" class="th"/>`,
    `<line x1="${r2(xNeg)}" y1="${m.top}" x2="${r2(xNeg)}" y2="${m.top + ph}" class="th"/>`,
    `<line x1="${r2(xPos)}" y1="${m.top}" x2="${r2(xPos)}" y2="${m.top + ph}" class="th"/>`,
  ].join("");

  const axes = [
    `<line x1="${m.left}" y1="${m.top + ph}" x2="${m.left + pw}" y2="${m.top + ph}" class="ax"/>`,
    `<line x1="${m.left}" y1="${m.top}" x2="${m.left}" y2="${m.top + ph}" class="ax"/>`,
    `<text x="${m.left + pw / 2}" y="${height - 6}" text-anchor="middle" class="axl">log2 fold-change</text>`,
    `<text transform="translate(12,${m.top + ph / 2}) rotate(-90)" text-anchor="middle" class="axl">-log10(padj)</text>`,
    `<text x="${m.left}" y="${m.top + ph + 14}" text-anchor="middle" class="tick">${r2(-xAbs)}</text>`,
    `<text x="${m.left + pw}" y="${m.top + ph + 14}" text-anchor="middle" class="tick">${r2(xAbs)}</text>`,
    `<text x="${m.left - 4}" y="${m.top + 4}" text-anchor="end" class="tick">${Math.round(yMax)}</text>`,
    `<text x="${m.left - 4}" y="${m.top + ph}" text-anchor="end" class="tick">0</text>`,
  ].join("");

  const legend = `<text x="${m.left + pw}" y="${m.top + 10}" text-anchor="end" class="leg"><tspan fill="${VOLCANO_COLORS.up}">● up ${fmt(data.up)}</tspan>  <tspan fill="${VOLCANO_COLORS.down}">● down ${fmt(data.down)}</tspan></text>`;

  return [
    `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="volcano plot" xmlns="http://www.w3.org/2000/svg">`,
    `<style>.ax{stroke:#94a3b8;stroke-width:1}.th{stroke:#cbd5e1;stroke-width:1;stroke-dasharray:3 3}.axl{font:12px system-ui,sans-serif;fill:#475569}.tick{font:10px system-ui,sans-serif;fill:#94a3b8}.leg{font:11px system-ui,sans-serif}</style>`,
    guides,
    dots,
    axes,
    legend,
    `</svg>`,
  ].join("\n");
}

function factsSection(outputs: ReportOutputFact[]): string {
  const rows = outputs
    .map((o) => {
      const status = o.found ? "" : ' <span class="warn">(not generated)</span>';
      const detail = o.found ? esc(o.detail).replace(/\n/g, "<br>") : "";
      return `<tr><td><code>${esc(o.path)}</code>${status}<div class="muted">${esc(o.description)}</div></td><td>${detail}</td></tr>`;
    })
    .join("\n");
  return `<table class="facts"><thead><tr><th>Output</th><th>What was found</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function toolsSection(tools: Record<string, string> | undefined): string {
  const entries = Object.entries(tools ?? {});
  if (entries.length === 0) return "";
  const chips = entries
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([tool, v]) => `<span class="chip"><b>${esc(tool)}</b> ${esc(v)}</span>`)
    .join(" ");
  return `<section><h2>Tools &amp; versions</h2><div class="chips">${chips}</div><p class="muted">Exact versions nf-core recorded for this run — cite these in your methods (see METHODS.md for the full statement and DOIs).</p></section>`;
}

function linksSection(input: ResultsReportInput): string {
  const items: string[] = [];
  for (const h of input.htmlReports) items.push(`<li><a href="${esc(h)}">${esc(h)}</a> <span class="muted">(open in browser)</span></li>`);
  for (const a of input.artifacts) items.push(`<li>${esc(a.label)}: <a href="${esc(a.path)}">${esc(a.path)}</a></li>`);
  if (items.length === 0) return "";
  return `<section><h2>Reports &amp; provenance</h2><ul class="links">${items.join("\n")}</ul></section>`;
}

/**
 * Renders the full self-contained HTML report. Pure: returns the HTML string,
 * which the caller writes to `REPORT.html` in the run directory.
 */
export function renderResultsReportHtml(input: ResultsReportInput): string {
  const q = input.query;
  const meta = [
    ["Objective", q.objective],
    ["Organism", q.organism],
    ["Data type", q.dataType],
    ["Experimental design", q.experimentalDesign],
  ]
    .filter(([, v]) => Boolean(v))
    .map(([k, v]) => `<div><dt>${esc(String(k))}</dt><dd>${esc(String(v))}</dd></div>`)
    .join("\n");

  const barsHtml = input.charts
    .filter((c) => c.items.length > 0)
    .map((c) => `<figure><figcaption>${esc(c.title)}</figcaption>${chartToSvg(c)}</figure>`)
    .join("\n");
  const volcanoHtml = (input.volcanoFigures ?? [])
    .filter((f) => f.data.points.length > 0)
    .map((f) => `<figure><figcaption>${esc(f.title)}</figcaption>${volcanoToSvg(f.data)}</figure>`)
    .join("\n");
  const chartsHtml = barsHtml + volcanoHtml;

  const css = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1e293b;background:#f8fafc}
main{max-width:820px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:16px;margin:32px 0 10px;padding-bottom:6px;border-bottom:1px solid #e2e8f0}
.sub{color:#64748b;margin:0 0 20px}
dl{display:grid;grid-template-columns:1fr;gap:8px;margin:0}
dl>div{display:grid;grid-template-columns:170px 1fr;gap:8px}
dt{color:#64748b}
dd{margin:0}
table.facts{width:100%;border-collapse:collapse;font-size:14px}
.facts th{text-align:left;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0;padding:6px 8px}
.facts td{border-bottom:1px solid #eef2f7;padding:8px;vertical-align:top}
code{background:#eef2f7;padding:1px 5px;border-radius:4px;font-size:13px}
.muted{color:#94a3b8;font-size:13px}
.warn{color:#b45309;font-size:13px}
figure{margin:16px 0}
figcaption{font-size:13px;color:#475569;margin-bottom:4px}
ul.links{padding-left:18px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-block;background:#eef2f7;border-radius:12px;padding:2px 10px;font-size:13px}
.chip b{font-weight:600}
a{color:#2563eb}
footer{margin-top:40px;color:#94a3b8;font-size:12px;border-top:1px solid #e2e8f0;padding-top:12px}
`.trim();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.pipelineName)} results — Hirsh</title>
<style>${css}</style>
</head>
<body>
<main>
<h1>${esc(input.pipelineTitle)}</h1>
<p class="sub">${esc(input.pipelineName)} · results interpretation · ${esc(input.generatedOn)}</p>

${meta ? `<section><h2>Study</h2><dl>${meta}</dl></section>` : ""}

<section><h2>Interpretation</h2>${proseToHtml(input.summaryText)}</section>

${chartsHtml ? `<section><h2>Figures</h2>${chartsHtml}</section>` : ""}

<section><h2>Outputs</h2>${factsSection(input.outputs)}</section>

${toolsSection(input.tools)}

${linksSection(input)}

<footer>Generated by Hirsh from run outputs in <code>${esc(input.outdir)}</code>. Figures are inline SVG; this file has no external dependencies. Numbers are read directly from the pipeline's output files.</footer>
</main>
</body>
</html>
`;
}
