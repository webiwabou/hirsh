import { describe, expect, it } from "vitest";
import {
  buildExecutorConfig,
  chooseExecutor,
  describeExecutor,
  EXECUTOR_ORDER,
  type ExecutorSettings,
} from "../src/execution/executor.js";
import type { AgentIO } from "../src/conversation/io.js";

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
    return false;
  }
  async confirmOrText(): Promise<{ decision: boolean } | { text: string }> {
    return { decision: false };
  }
  async withSpinner<T>(_label: string, task: () => Promise<T>): Promise<T> {
    return task();
  }
}

describe("buildExecutorConfig", () => {
  it("returns null for local (no config needed)", () => {
    expect(buildExecutorConfig({ executor: "local" })).toBeNull();
  });

  it("writes process.executor and queue for a scheduler", () => {
    const cfg = buildExecutorConfig({ executor: "slurm", queue: "short" })!;
    expect(cfg).toContain("executor = 'slurm'");
    expect(cfg).toContain("queue = 'short'");
    expect(cfg).toContain("process {");
  });

  it("omits queue when not provided", () => {
    const cfg = buildExecutorConfig({ executor: "sge" })!;
    expect(cfg).toContain("executor = 'sge'");
    expect(cfg).not.toContain("queue");
  });

  it("adds region and S3 workDir for awsbatch", () => {
    const cfg = buildExecutorConfig({
      executor: "awsbatch",
      queue: "hirsh-queue",
      awsRegion: "eu-west-1",
      workDir: "s3://bucket/work",
    })!;
    expect(cfg).toContain("executor = 'awsbatch'");
    expect(cfg).toContain("aws.region = 'eu-west-1'");
    expect(cfg).toContain("workDir = 's3://bucket/work'");
  });
});

describe("describeExecutor", () => {
  it("summarizes local plainly", () => {
    expect(describeExecutor({ executor: "local" })).toBe("local machine");
  });
  it("includes the queue for clusters", () => {
    expect(describeExecutor({ executor: "slurm", queue: "gpu" })).toContain("gpu");
    expect(describeExecutor({ executor: "slurm", queue: "gpu" })).toContain("Slurm");
  });
});

describe("chooseExecutor", () => {
  it("keeps the configured executor on empty input", async () => {
    const io = new ScriptedIO([""]);
    const s = await chooseExecutor(io, "local");
    expect(s.executor).toBe("local");
  });

  it("selects a scheduler by number and asks for the queue", async () => {
    // menu order: 1 local, 2 slurm, ... → "2" then queue "short"
    const io = new ScriptedIO(["2", "short"]);
    const s = await chooseExecutor(io, "local");
    expect(s.executor).toBe("slurm");
    expect(s.queue).toBe("short");
  });

  it("selects by name and falls back to the default queue when blank", async () => {
    const io = new ScriptedIO(["sge", ""]);
    const s = await chooseExecutor(io, "local", "all.q");
    expect(s.executor).toBe("sge");
    expect(s.queue).toBe("all.q");
  });

  it("gathers region and work dir for awsbatch", async () => {
    const idx = String(EXECUTOR_ORDER.indexOf("awsbatch") + 1);
    const io = new ScriptedIO([idx, "hirsh-queue", "eu-west-1", "s3://bucket/work"]);
    const s = await chooseExecutor(io, "local");
    expect(s.executor).toBe("awsbatch");
    expect(s.queue).toBe("hirsh-queue");
    expect(s.awsRegion).toBe("eu-west-1");
    expect(s.workDir).toBe("s3://bucket/work");
  });
});
