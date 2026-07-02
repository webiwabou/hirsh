import { describe, expect, it } from "vitest";
import { parseLintOutput } from "../src/composition/validate.js";

// Representative nf-core lint summary (rich box, with a few failures above it).
const SAMPLE = `
╭─ [✗] Pipeline Tests ───────────────────────────────────────────────╮
│                                                                     │
│ ✗ files_exist: File not found: 'CHANGELOG.md'                       │
│ ✗ files_exist: File not found: '.github/workflows/ci.yml'           │
│ ✗ nextflow_config: Config variable not found: manifest.homePage     │
│                                                                     │
╰─────────────────────────────────────────────────────────────────────╯
╭───────────────────────────╮
│      LINT RESULTS SUMMARY  │
├───────────────────────────┤
│ [✔]  40 Tests Passed       │
│ [?]   2 Tests Ignored      │
│ [!]   5 Test Warnings      │
│ [✗]   3 Tests Failed       │
╰───────────────────────────╯
`;

describe("parseLintOutput", () => {
  it("extracts pass/warn/fail counts from the summary", () => {
    const r = parseLintOutput(SAMPLE);
    expect(r.passed).toBe(40);
    expect(r.warned).toBe(5);
    expect(r.failed).toBe(3);
  });

  it("collects failure findings without the summary line", () => {
    const r = parseLintOutput(SAMPLE);
    expect(r.findings.length).toBe(3);
    expect(r.findings[0]).toContain("files_exist");
    // the "3 Tests Failed" summary line must not be treated as a finding
    expect(r.findings.some((f) => /Tests Failed/i.test(f))).toBe(false);
  });

  it("tolerates ANSI colour codes", () => {
    const colored = "[32m[✔] 12 Tests Passed[0m\n[31m[✗] 1 Tests Failed[0m";
    const r = parseLintOutput(colored);
    expect(r.passed).toBe(12);
    expect(r.failed).toBe(1);
  });

  it("returns undefined counts when there is no summary", () => {
    const r = parseLintOutput("just some unrelated output");
    expect(r.passed).toBeUndefined();
    expect(r.failed).toBeUndefined();
    expect(r.findings).toEqual([]);
  });
});
