import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillParameters } from "../src/conversation/parameterFilling.js";
import { createSession } from "../src/conversation/session.js";
import type { AgentIO } from "../src/conversation/io.js";
import type { PipelineDefinition } from "../src/pipelines/types.js";
import type { HirshConfig } from "../src/config/types.js";

/** Scripted IO: separate ordered queues for ask() and confirm(). */
class ScriptedIO implements AgentIO {
  private ai = 0;
  private ci = 0;
  constructor(
    private readonly asks: string[],
    private readonly confirms: boolean[],
  ) {}
  say(): void {}
  info(): void {}
  warn(): void {}
  heading(): void {}
  raw(): void {}
  endStream(): void {}
  async ask(): Promise<string> {
    return this.asks[this.ai++] ?? "";
  }
  async confirm(): Promise<boolean> {
    return this.confirms[this.ci++] ?? false;
  }
  async confirmOrText(): Promise<{ decision: boolean } | { text: string }> {
    return { decision: false };
  }
  async withSpinner<T>(_l: string, t: () => Promise<T>): Promise<T> {
    return t();
  }
}

const pipeline = {
  name: "nf-core/proteinfamilies",
  version: "1.0.0",
  params: [],
  profiles: { hasTestProfile: true, testProfile: "test" },
  results: { outdirParam: "outdir", outputs: [] },
  samplesheet: {
    filename: "samplesheet.csv",
    description: "",
    columns: [
      { name: "sample", required: true, description: "" },
      { name: "fasta", required: true, description: "" },
    ],
  },
} as unknown as PipelineDefinition;

describe("Phase C — changing your mind to the test profile at the file prompt", () => {
  let dir: string;
  let config: HirshConfig;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "hirsh-switch-"));
    config = { execution: { workdir: dir, containerEngine: "docker" } } as unknown as HirshConfig;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("switches to the test profile instead of treating the sentence as a directory", async () => {
    const s = createSession();
    // confirms: [Run a TEST run? → no, Do you have a samplesheet CSV? → no]
    // asks:     [directory prompt → a change of mind]
    const io = new ScriptedIO(
      ["actually, i do want to run the test profile"],
      [false, false],
    );
    await fillParameters(io, s, pipeline, config);

    expect(s.useTestProfile).toBe(true);
    expect(s.samplesheetPath).toBeUndefined(); // no empty samplesheet written
    expect(s.paramValues.input).toBeUndefined();
    // The command carries the test profile and no -params input.
    expect(s.command?.join(" ")).toContain("test,docker");
    const params = readFileSync(s.paramsFile!, "utf8");
    expect(params).not.toContain("input:");
  });
});
