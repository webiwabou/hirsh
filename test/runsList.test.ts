import { describe, expect, it } from "vitest";
import { formatRunsTable, runStatus, summarizeRun } from "../src/cli/runsList.js";

describe("runStatus", () => {
  it("labels prepared, completed and failed runs", () => {
    expect(runStatus({ execution: { executed: false } })).toBe("prepared (not run)");
    expect(runStatus({ execution: { executed: true, exitCode: 0 } })).toBe("completed");
    expect(runStatus({ execution: { executed: true, exitCode: 1 } })).toBe("failed (exit 1)");
  });
});

describe("summarizeRun", () => {
  it("extracts date, pipeline+revision, status and outdir", () => {
    const e = summarizeRun("/runs/rnaseq-2026", {
      createdAt: "2026-07-08T10:20:30.000Z",
      pipeline: { name: "nf-core/rnaseq", revision: "3.14.0" },
      outdir: "/runs/rnaseq-2026/results",
      execution: { executed: true, exitCode: 0 },
    });
    expect(e).toMatchObject({
      dir: "/runs/rnaseq-2026",
      date: "2026-07-08 10:20:30",
      pipeline: "nf-core/rnaseq 3.14.0",
      status: "completed",
    });
  });
});

describe("formatRunsTable", () => {
  it("renders a header and one aligned row per entry", () => {
    const table = formatRunsTable([
      { dir: "/runs/a", date: "2026-07-08 10:00:00", pipeline: "nf-core/rnaseq", status: "completed" },
    ]);
    expect(table).toMatch(/DATE\s+PIPELINE\s+STATUS\s+DIRECTORY/);
    expect(table).toContain("nf-core/rnaseq");
    expect(table).toContain("/runs/a");
  });

  it("has a friendly empty message", () => {
    expect(formatRunsTable([])).toMatch(/No runs found/);
  });
});
