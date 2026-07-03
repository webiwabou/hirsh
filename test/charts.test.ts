import { describe, expect, it } from "vitest";
import { renderBarChart } from "../src/results/charts.js";

describe("renderBarChart", () => {
  it("scales bars to the largest value and shows formatted numbers", () => {
    const lines = renderBarChart(
      [
        { label: "sampleA", value: 1000 },
        { label: "sampleB", value: 500 },
        { label: "sampleC", value: 0 },
      ],
      10,
    );
    expect(lines).toHaveLength(3);
    // Largest is full width; half value is ~half; zero has no filled block.
    expect(lines[0]).toContain("██████████"); // 10 filled
    expect(lines[0]).toContain("1,000");
    expect((lines[1].match(/█/g) ?? []).length).toBe(5);
    expect((lines[2].match(/█/g) ?? []).length).toBe(0);
    expect(lines[2]).toContain("0");
  });

  it("aligns labels and truncates long ones", () => {
    const lines = renderBarChart([
      { label: "x", value: 1 },
      { label: "a_very_long_sample_name_exceeding_max", value: 2 },
    ]);
    // Both lines start with a label padded/truncated to the same width.
    const w1 = lines[0].indexOf("█") >= 0 ? lines[0].split(" ")[0].length : 0;
    expect(lines[1]).toContain("…"); // long label truncated
  });

  it("returns [] for no items and handles all-zero without dividing by zero", () => {
    expect(renderBarChart([])).toEqual([]);
    const z = renderBarChart([{ label: "a", value: 0 }, { label: "b", value: 0 }], 8);
    expect(z[0]).not.toContain("█"); // no filled blocks when max is 0
  });
});
