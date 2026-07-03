import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillParameters } from "../src/conversation/parameterFilling.js";
import { createSession } from "../src/conversation/session.js";
import type { AgentIO } from "../src/conversation/io.js";
import type { PipelineDefinition } from "../src/pipelines/types.js";
import type { HirshConfig } from "../src/config/types.js";

/** Records every confirm/ask so we can assert what the flow did (or skipped). */
class RecordingIO implements AgentIO {
  confirmPrompts: string[] = [];
  askPrompts: string[] = [];
  say(): void {}
  info(): void {}
  warn(): void {}
  heading(): void {}
  raw(): void {}
  endStream(): void {}
  async ask(q: string): Promise<string> {
    this.askPrompts.push(q);
    return "";
  }
  async confirm(q: string): Promise<boolean> {
    this.confirmPrompts.push(q);
    return true;
  }
  async confirmOrText(): Promise<{ decision: boolean } | { text: string }> {
    return { decision: false };
  }
  async withSpinner<T>(_l: string, t: () => Promise<T>): Promise<T> {
    return t();
  }
}

const pipeline = {
  name: "nf-core/rnaseq",
  version: "3.14.0",
  params: [], // no genome/optional params → no reference prompts
  profiles: { hasTestProfile: true, testProfile: "test" },
  results: { outdirParam: "outdir", outputs: [] },
  samplesheet: {
    filename: "samplesheet.csv",
    description: "",
    columns: [
      { name: "sample", required: true, description: "" },
      { name: "fastq_1", required: true, description: "" },
      { name: "fastq_2", required: false, description: "" },
    ],
  },
} as unknown as PipelineDefinition;

describe("fillParameters — fetched-data guard", () => {
  let dir: string;
  let config: HirshConfig;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "hirsh-fetch-"));
    config = { execution: { workdir: dir, containerEngine: "docker" } } as unknown as HirshConfig;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("skips the test-profile question and samplesheet build when data is already fetched", async () => {
    const fetched = join(dir, "fetchngs", "samplesheet", "samplesheet.csv");
    const s = createSession();
    s.samplesheetPath = fetched;
    s.paramValues.input = fetched;

    const io = new RecordingIO();
    await fillParameters(io, s, pipeline, config);

    // The test-profile prompt must not be asked, and the pre-set samplesheet is kept.
    expect(io.confirmPrompts.some((p) => /TEST run/i.test(p))).toBe(false);
    expect(s.useTestProfile).toBe(false);
    expect(s.samplesheetPath).toBe(fetched);
    expect(s.paramValues.input).toBe(fetched);
    // A runnable command was still produced (params.yaml written, input carried).
    expect(s.command?.[0]).toBe("run");
    const params = readFileSync(s.paramsFile!, "utf8");
    expect(params).toContain("input:");
  });

  it("asks the test-profile question normally when no data is pre-set", async () => {
    const s = createSession();
    const io = new RecordingIO();
    await fillParameters(io, s, pipeline, config);
    expect(io.confirmPrompts.some((p) => /TEST run/i.test(p))).toBe(true);
    expect(s.useTestProfile).toBe(true); // RecordingIO confirms yes
  });
});
