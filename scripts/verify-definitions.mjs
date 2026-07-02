// Verifies each curated pipeline definition against the real upstream
// nextflow_schema.json at its pinned revision: confirms the revision tag exists
// and that every param we declare is a real pipeline parameter (no silent drift).
// Network required. Run: `npm run verify:defs`.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const defsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/pipelines/definitions");

/** Collects every declared parameter name from an nf-core nextflow_schema.json. */
function collectSchemaProps(schema) {
  const names = new Set();
  const visit = (obj) => {
    if (!obj || typeof obj !== "object") return;
    if (obj.properties) for (const k of Object.keys(obj.properties)) names.add(k);
    for (const key of ["definitions", "$defs"]) {
      if (obj[key]) for (const d of Object.values(obj[key])) visit(d);
    }
    if (Array.isArray(obj.allOf)) obj.allOf.forEach(visit);
  };
  visit(schema);
  return names;
}

let failed = false;

for (const file of readdirSync(defsDir).filter((f) => /\.ya?ml$/.test(f))) {
  const def = parseYaml(readFileSync(join(defsDir, file), "utf8"));
  const shortName = def.name.split("/").pop();
  const url = `https://raw.githubusercontent.com/nf-core/${shortName}/${def.version}/nextflow_schema.json`;
  process.stdout.write(`${def.name}@${def.version}: `);

  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    console.log(`fetch error (${err.message})`);
    failed = true;
    continue;
  }
  if (!res.ok) {
    console.log(`schema not found (HTTP ${res.status}) — is the pinned revision tag correct?`);
    failed = true;
    continue;
  }

  const schema = await res.json();
  const props = collectSchemaProps(schema);
  const declared = (def.params ?? []).map((p) => p.name);
  const missing = declared.filter((p) => !props.has(p));
  if (missing.length > 0) {
    console.log(`MISSING from upstream schema: ${missing.join(", ")}`);
    failed = true;
  } else {
    console.log(`OK (${declared.length} params present in upstream schema)`);
  }
}

process.exit(failed ? 1 : 0);
