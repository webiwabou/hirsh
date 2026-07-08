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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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

/**
 * User-local definitions directory, for pipelines Hirsh auto-curates from the
 * nf-core catalog (see `synthDefinition.ts`). Kept separate from the bundled
 * ones so learned pipelines persist across sessions without touching the
 * installed package, and so a bundled (hand-curated) definition always wins over
 * a user one of the same name.
 */
export function userDefinitionsDir(): string {
  return resolve(homedir(), ".bioagent", "pipelines");
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

function readYamlFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .sort();
  } catch {
    return [];
  }
}

let cache: PipelineDefinition[] | null = null;

/**
 * Loads (and caches) all pipeline definitions: the bundled curated ones, plus
 * any user-curated ones in `~/.bioagent/pipelines`. A bundled definition wins
 * over a user one of the same name (hand-curated beats auto-generated), and
 * later user files never shadow an already-loaded name.
 */
export function loadRegistry(): PipelineDefinition[] {
  if (cache) return cache;
  const bundledDir = definitionsDir();
  const bundled = readYamlFiles(bundledDir);
  if (bundled.length === 0) {
    throw new RegistryError(`No pipeline definitions found in ${bundledDir}.`);
  }

  const defs: PipelineDefinition[] = [];
  const seen = new Set<string>();
  const load = (dir: string, file: string, tolerant: boolean): void => {
    const full = join(dir, file);
    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(full, "utf8"));
    } catch (err) {
      if (tolerant) return; // a broken user file must not sink startup
      throw new RegistryError(`${file}: invalid YAML: ${err instanceof Error ? err.message : String(err)}`);
    }
    let def: PipelineDefinition;
    try {
      def = validate(parsed, file);
    } catch (err) {
      if (tolerant) return;
      throw err;
    }
    if (seen.has(def.name)) return; // bundled/earlier wins
    seen.add(def.name);
    defs.push(def);
  };

  for (const file of bundled) load(bundledDir, file, false);
  const userDir = userDefinitionsDir();
  if (existsSync(userDir)) {
    for (const file of readYamlFiles(userDir)) load(userDir, file, true);
  }

  cache = defs;
  return defs;
}

/** Clears the registry cache so a freshly curated definition is picked up. */
export function invalidateRegistryCache(): void {
  cache = null;
}

/** Finds a pipeline by its exact name (e.g. "nf-core/rnaseq"). */
export function findPipeline(name: string): PipelineDefinition | undefined {
  return loadRegistry().find((p) => p.name === name);
}
