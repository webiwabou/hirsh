/**
 * Writing config back (Phase 6).
 *
 * When a scientist keeps picking the same backend/executor, Hirsh can save it as
 * their default. We edit the YAML with the Document API so **comments and the
 * rest of the file are preserved** — only the touched keys change.
 *
 * updateExecutionConfig is pure (text in, text out) for testing; persist writes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseDocument } from "yaml";

export interface ExecutionUpdates {
  containerEngine?: string;
  executor?: string;
  queue?: string;
}

/**
 * Returns the YAML text with the given `execution.*` keys set, preserving the
 * rest of the document (including comments). Creates the `execution` map if the
 * file is empty or lacks it. Pure.
 */
export function updateExecutionConfig(text: string, updates: ExecutionUpdates): string {
  // A blank file has no document to edit — write a clean block `execution:` map.
  if ((text ?? "").trim() === "") {
    const lines = ["execution:"];
    if (updates.containerEngine !== undefined) lines.push(`  containerEngine: ${updates.containerEngine}`);
    if (updates.executor !== undefined) lines.push(`  executor: ${updates.executor}`);
    if (updates.queue) lines.push(`  queue: ${updates.queue}`);
    return lines.join("\n") + "\n";
  }

  const doc = parseDocument(text);

  if (updates.containerEngine !== undefined) {
    doc.setIn(["execution", "containerEngine"], updates.containerEngine);
  }
  if (updates.executor !== undefined) {
    doc.setIn(["execution", "executor"], updates.executor);
  }
  if (updates.queue !== undefined) {
    if (updates.queue === "") doc.deleteIn(["execution", "queue"]);
    else doc.setIn(["execution", "queue"], updates.queue);
  }
  return doc.toString();
}

/** Reads the config file (if any), applies the updates, and writes it back. */
export function persistExecutionChoice(path: string, updates: ExecutionUpdates): void {
  let text = "";
  try {
    if (existsSync(path)) text = readFileSync(path, "utf8");
  } catch {
    /* treat as empty */
  }
  const out = updateExecutionConfig(text, updates);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, out, "utf8");
}
