/**
 * Pipeline registry.
 *
 * Loads all YAML definitions from ./definitions and exposes them as
 * PipelineDefinition[]. Path resolution uses import.meta.url so it works both in
 * development (tsx over src/) and compiled (dist/, where copy-assets.mjs places
 * the YAML next to the JS).
 *
 * To ADD A FOURTH PIPELINE: create a new file in ./definitions with the same
 * fields (see types.ts). No need to touch this file or the core logic: the
 * registry picks it up automatically at startup.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { PipelineDefinition } from "./types.js";

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

function definitionsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "definitions");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RegistryError(message);
}

function validate(def: unknown, file: string): PipelineDefinition {
  assert(def && typeof def === "object", `${file}: the definition must be a map.`);
  const d = def as Record<string, unknown>;
  const required = ["name", "version", "title", "purpose", "samplesheet", "params", "profiles", "results"];
  for (const key of required) {
    assert(d[key] !== undefined, `${file}: missing required field "${key}".`);
  }
  assert(Array.isArray(d.params), `${file}: "params" must be a list.`);
  const results = d.results as Record<string, unknown>;
  assert(typeof results.outdirParam === "string", `${file}: "results.outdirParam" is required.`);
  // We trust the rest of the shape; the YAML is curated by whoever adds the pipeline.
  return def as PipelineDefinition;
}

let cache: PipelineDefinition[] | null = null;

/** Loads (and caches) all pipeline definitions from the directory. */
export function loadRegistry(): PipelineDefinition[] {
  if (cache) return cache;
  const dir = definitionsDir();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch (err) {
    throw new RegistryError(
      `Could not read the definitions directory ${dir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  assert(files.length > 0, `No pipeline definitions found in ${dir}.`);

  const defs: PipelineDefinition[] = [];
  for (const file of files.sort()) {
    const full = join(dir, file);
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(full, "utf8"));
    } catch (err) {
      throw new RegistryError(
        `${file}: invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    defs.push(validate(parsed, file));
  }
  cache = defs;
  return defs;
}

/** Finds a pipeline by its exact name (e.g. "nf-core/rnaseq"). */
export function findPipeline(name: string): PipelineDefinition | undefined {
  return loadRegistry().find((p) => p.name === name);
}
