/**
 * Validating a curated pipeline definition against the upstream
 * `nextflow_schema.json` (used by `npm run verify:defs`).
 *
 * Beyond "does this parameter exist upstream", this also checks **enum values**:
 * that our declared `default` and `choices` are among the upstream allowed values
 * — the gap that let a wrong `clustering_tool: mmseqs` default ship. Pure, so it
 * is unit-tested without the network.
 */

export type SchemaProp = Record<string, unknown>;

/** Declared param shape we care about (a subset of PipelineParam). */
export interface DeclaredParam {
  name: string;
  default?: unknown;
  choices?: unknown[];
}

/** Collects every parameter property from an nf-core nextflow_schema.json. */
export function collectSchemaProperties(schema: unknown): Map<string, SchemaProp> {
  const props = new Map<string, SchemaProp>();
  const visit = (obj: unknown): void => {
    if (!obj || typeof obj !== "object") return;
    const o = obj as Record<string, unknown>;
    if (o.properties && typeof o.properties === "object") {
      for (const [k, v] of Object.entries(o.properties as Record<string, unknown>)) {
        if (!props.has(k)) props.set(k, (v ?? {}) as SchemaProp);
      }
    }
    for (const key of ["definitions", "$defs"]) {
      const section = o[key];
      if (section && typeof section === "object") Object.values(section).forEach(visit);
    }
    if (Array.isArray(o.allOf)) o.allOf.forEach(visit);
  };
  visit(schema);
  return props;
}

/**
 * Returns human-readable problems for a definition's params against the schema:
 * params absent upstream, defaults not in the upstream enum, and choices that
 * aren't upstream-valid. Empty array means the definition is consistent.
 */
export function checkParamsAgainstSchema(
  params: DeclaredParam[],
  props: Map<string, SchemaProp>,
): string[] {
  const problems: string[] = [];
  for (const p of params) {
    const spec = props.get(p.name);
    if (!spec) {
      problems.push(`${p.name}: not a parameter of the upstream schema`);
      continue;
    }
    const enumVals = Array.isArray(spec.enum) ? (spec.enum as unknown[]).map(String) : null;
    if (!enumVals) continue;

    if (p.default !== undefined && p.default !== null && !enumVals.includes(String(p.default))) {
      problems.push(`${p.name}: default "${p.default}" is not in the upstream enum [${enumVals.join(", ")}]`);
    }
    if (Array.isArray(p.choices)) {
      const bad = p.choices.map(String).filter((c) => !enumVals.includes(c));
      if (bad.length > 0) {
        problems.push(`${p.name}: choices [${bad.join(", ")}] are not in the upstream enum [${enumVals.join(", ")}]`);
      }
    }
  }
  return problems;
}

/**
 * Informational (non-failing) diff of **non-enum** default values: reports when a
 * curated definition's declared `default` differs from the upstream schema's
 * default. Enum defaults are validated by `checkParamsAgainstSchema`; this catches
 * silent drift in plain values (e.g. a changed default aligner path). Pure.
 */
export function diffDefaults(params: DeclaredParam[], props: Map<string, SchemaProp>): string[] {
  const notes: string[] = [];
  for (const p of params) {
    if (Array.isArray(p.choices)) continue; // enum defaults handled elsewhere
    if (p.default === undefined || p.default === null) continue;
    const spec = props.get(p.name);
    if (!spec) continue; // a missing param is reported by checkParamsAgainstSchema
    const upstream = spec.default;
    if (upstream === undefined || upstream === null) continue; // nothing to compare
    if (String(upstream) !== String(p.default)) {
      notes.push(`${p.name}: default "${p.default}" differs from the upstream default "${upstream}"`);
    }
  }
  return notes;
}
