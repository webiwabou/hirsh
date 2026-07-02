import { describe, expect, it } from "vitest";
import { AutonomousIO } from "../src/cli/autonomousIO.js";
import type { AgentIO } from "../src/conversation/io.js";

/** Records confirm/ask delegations and returns scripted answers. */
class RecordingIO implements AgentIO {
  confirmCalls: Array<{ q: string; def?: boolean }> = [];
  askCalls: string[] = [];
  confirmReturn = true;
  askReturn = "answer";
  say(): void {}
  info(): void {}
  warn(): void {}
  heading(): void {}
  raw(): void {}
  endStream(): void {}
  async withSpinner<T>(_l: string, t: () => Promise<T>): Promise<T> {
    return t();
  }
  async ask(q: string): Promise<string> {
    this.askCalls.push(q);
    return this.askReturn;
  }
  async confirm(q: string, def?: boolean): Promise<boolean> {
    this.confirmCalls.push({ q, def });
    return this.confirmReturn;
  }
  async confirmOrText(): Promise<{ decision: boolean } | { text: string }> {
    return { decision: false };
  }
}

describe("AutonomousIO", () => {
  it("auto-answers a reversible confirmation with its default, without asking", async () => {
    const base = new RecordingIO();
    const io = new AutonomousIO(base);
    expect(await io.confirm("Run a TEST run?", true)).toBe(true);
    expect(await io.confirm("Somatic analysis?", false)).toBe(false);
    expect(base.confirmCalls).toHaveLength(0); // never delegated to the human
  });

  it("uses opts.auto to override the default for reversible confirmations", async () => {
    const base = new RecordingIO();
    const io = new AutonomousIO(base);
    // interactive default is false (safety), but auto mode proceeds
    expect(await io.confirm("Run this command now?", false, { auto: true })).toBe(true);
    expect(base.confirmCalls).toHaveLength(0);
  });

  it("delegates consequential confirmations to the human", async () => {
    const base = new RecordingIO();
    base.confirmReturn = false;
    const io = new AutonomousIO(base);
    const r = await io.confirm("Publish to GitHub?", false, { consequential: true });
    expect(r).toBe(false);
    expect(base.confirmCalls).toEqual([{ q: "Publish to GitHub?", def: false }]);
  });

  it("still asks open questions (missing info needs a human)", async () => {
    const base = new RecordingIO();
    base.askReturn = "/data/fastqs";
    const io = new AutonomousIO(base);
    expect(await io.ask("Directory with FASTQ files:")).toBe("/data/fastqs");
    expect(base.askCalls).toEqual(["Directory with FASTQ files:"]);
  });

  it("takes the default decision for confirmOrText", async () => {
    const io = new AutonomousIO(new RecordingIO());
    expect(await io.confirmOrText("Continue with rnaseq?", true)).toEqual({ decision: true });
  });
});
