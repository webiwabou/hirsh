/**
 * Nextflow execution as a subprocess, with stdout/stderr streaming.
 *
 * Never called without explicit user confirmation (the state machine guarantees
 * this in Phase D). On failure, the relevant error is extracted instead of
 * dumping the entire raw log.
 */
import { spawn } from "node:child_process";
import type { AgentIO } from "../conversation/io.js";

export interface RunResult {
  exitCode: number;
  /** Relevant error snippet extracted from the log (if it failed). */
  errorSummary?: string;
}

/**
 * Launches `nextflow <args>` in `cwd`. Streams output in real time via io.raw.
 * Returns the exit code and, on failure, an error summary.
 */
export function runNextflow(args: string[], cwd: string, io: AgentIO): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("nextflow", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Circular buffer of the last stderr lines for the error summary.
    const tail: string[] = [];
    const pushTail = (chunk: string) => {
      for (const line of chunk.split("\n")) {
        tail.push(line);
        if (tail.length > 60) tail.shift();
      }
    };

    child.stdout.on("data", (buf: Buffer) => {
      io.raw(buf.toString());
    });
    child.stderr.on("data", (buf: Buffer) => {
      const text = buf.toString();
      io.raw(text);
      pushTail(text);
    });

    // Forward Ctrl+C to Nextflow so it can shut down its jobs/containers cleanly
    // instead of being orphaned. Restored when the child exits.
    const onSigint = () => {
      io.raw("\nReceived interrupt — asking Nextflow to stop…\n");
      child.kill("SIGINT");
    };
    process.on("SIGINT", onSigint);

    child.on("error", (err) => {
      process.removeListener("SIGINT", onSigint);
      io.endStream();
      resolvePromise({
        exitCode: 127,
        errorSummary:
          `Could not start Nextflow: ${err.message}. ` +
          "Check that `nextflow` is installed and on PATH.",
      });
    });

    child.on("close", (code) => {
      process.removeListener("SIGINT", onSigint);
      io.endStream();
      const exitCode = code ?? 1;
      if (exitCode === 0) {
        resolvePromise({ exitCode });
      } else {
        resolvePromise({ exitCode, errorSummary: extractError(tail) });
      }
    });
  });
}

/** Extracts the most relevant error block from the end of the Nextflow log. */
function extractError(tailLines: string[]): string {
  const text = tailLines.join("\n");
  // Nextflow usually marks the error with an "ERROR ~ ..." line followed by detail.
  const idx = text.lastIndexOf("ERROR ~");
  if (idx >= 0) {
    return text.slice(idx).split("\n").slice(0, 20).join("\n").trim();
  }
  // Otherwise, return the last non-empty lines.
  const nonEmpty = tailLines.filter((l) => l.trim().length > 0);
  return nonEmpty.slice(-15).join("\n").trim() || "Nextflow exited with an error and no detailed output.";
}
