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
  /** Paths of HTML reports (e.g. MultiQC) to link. */
  htmlReports: string[];
  /** Other files to link (methods, provenance, params). */
  artifacts: ReportArtifact[];
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

  const chartsHtml = input.charts
    .filter((c) => c.items.length > 0)
    .map((c) => `<figure><figcaption>${esc(c.title)}</figcaption>${chartToSvg(c)}</figure>`)
    .join("\n");

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

${linksSection(input)}

<footer>Generated by Hirsh from run outputs in <code>${esc(input.outdir)}</code>. Figures are inline SVG; this file has no external dependencies. Numbers are read directly from the pipeline's output files.</footer>
</main>
</body>
</html>
`;
}
