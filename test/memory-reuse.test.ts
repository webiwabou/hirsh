import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fillReferenceParams,
  useRememberedSamplesheet,
  type MemorySuggestions,
} from "../src/conversation/parameterFilling.js";
import { createSession } from "../src/conversation/session.js";
import type { AgentIO } from "../src/conversation/io.js";
import type { PipelineDefinition } from "../src/pipelines/types.js";

class ScriptedIO implements AgentIO {
  constructor(private readonly answers: string[]) {}
  private i = 0;
  say(): void {}
  info(): void {}
  warn(): void {}
  heading(): void {}
  raw(): void {}
  endStream(): void {}
  async ask(): Promise<string> {
    return this.answers[this.i++] ?? "";
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
  confirms: boolean[] = [];
  private ci = 0;
}

// Minimal rnaseq-like pipeline: genome + fasta + gtf params and a samplesheet spec.
const pipeline = {
  name: "nf-core/rnaseq",
  params: [
    { name: "genome", type: "string", required: false, description: "", choices: ["GRCm39"] },
    { name: "fasta", type: "path", required: false, description: "" },
    { name: "gtf", type: "path", required: false, description: "" },
  ],
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

describe("fillReferenceParams — remembered genome reuse", () => {
  it("reuses the remembered genome on empty input", async () => {
    const io = new ScriptedIO([""]); // Enter at the genome prompt
    const s = createSession();
    const sug: MemorySuggestions = { references: { genome: ["GRCm39"] }, samplesheets: [] };
    await fillReferenceParams(io, s, pipeline, sug);
    expect(s.paramValues.genome).toBe("GRCm39");
  });

  it("lets 'none' fall through to a remembered FASTA/GTF default", async () => {
    // genome answer 'none' → fasta prompt (Enter reuses remembered) → gtf prompt (Enter reuses)
    const io = new ScriptedIO(["none", "", ""]);
    const s = createSession();
    const sug: MemorySuggestions = {
      references: { genome: ["GRCm39"], fasta: ["/ref/genome.fa"], gtf: ["/ref/genes.gtf"] },
      samplesheets: [],
    };
    await fillReferenceParams(io, s, pipeline, sug);
    expect(s.paramValues.genome).toBeUndefined();
    expect(String(s.paramValues.fasta)).toContain("genome.fa");
    expect(String(s.paramValues.gtf)).toContain("genes.gtf");
  });

  it("asks normally when nothing is remembered", async () => {
    const io = new ScriptedIO(["GRCh38"]);
    const s = createSession();
    await fillReferenceParams(io, s, pipeline, { references: {}, samplesheets: [] });
    expect(s.paramValues.genome).toBe("GRCh38");
  });
});

describe("useRememberedSamplesheet", () => {
  let dir: string;
  let csv: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "hirsh-mem-"));
    csv = join(dir, "samplesheet.csv");
    writeFileSync(csv, "sample,fastq_1,fastq_2\nS1,/d/s1_R1.fq.gz,/d/s1_R2.fq.gz\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reuses a remembered samplesheet the user accepts", async () => {
    const io = new ScriptedIO([]);
    io.confirms = [true]; // yes, reuse it
    const s = createSession();
    const ok = await useRememberedSamplesheet(io, s, pipeline, { references: {}, samplesheets: [csv] });
    expect(ok).toBe(true);
    expect(s.samplesheetPath).toBe(csv);
    expect(s.paramValues.input).toBe(csv);
  });

  it("returns false when there is no remembered samplesheet", async () => {
    const io = new ScriptedIO([]);
    const s = createSession();
    const ok = await useRememberedSamplesheet(io, s, pipeline, { references: {}, samplesheets: [] });
    expect(ok).toBe(false);
  });
});
