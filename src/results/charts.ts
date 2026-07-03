/**
 * Tiny inline terminal charts for results interpretation (Phase 2).
 *
 * Turns the concrete numbers Hirsh already extracts (per-sample library sizes,
 * significant genes per contrast, …) into a compact horizontal bar chart, so the
 * scientist *sees* the shape of the data, not just prose. Pure (data in, lines
 * out) so it is unit-tested.
 */

export interface ChartItem {
  label: string;
  value: number;
}

export interface ChartData {
  title: string;
  items: ChartItem[];
}

const LABEL_MAX = 22;
const BAR_WIDTH = 24;

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/**
 * Renders items as aligned horizontal bars scaled to the largest value:
 *   `SAMPLE_A   ████████████░░░░  1,234,567`
 * Returns one line per item (empty array for no items).
 */
export function renderBarChart(items: ChartItem[], width = BAR_WIDTH): string[] {
  if (items.length === 0) return [];
  const max = Math.max(0, ...items.map((i) => i.value));
  const labelW = Math.min(LABEL_MAX, Math.max(...items.map((i) => i.label.length)));
  return items.map((i) => {
    const label =
      i.label.length > labelW ? i.label.slice(0, labelW - 1) + "…" : i.label.padEnd(labelW);
    const filled = max > 0 ? Math.round((Math.max(0, i.value) / max) * width) : 0;
    const bar = "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
    return `${label} ${bar} ${fmt(i.value)}`;
  });
}
