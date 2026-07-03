// Verifies each curated pipeline definition against the real upstream
// nextflow_schema.json at its pinned revision: confirms the revision tag exists,
// that every param we declare is a real pipeline parameter, and that enum
// defaults/choices are among the upstream allowed values (no silent drift).
// Network required. Run: `npm run verify:defs`.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  checkParamsAgainstSchema,
  collectSchemaProperties,
  type DeclaredParam,
} from "../src/pipelines/schemaCheck.js";

const defsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/pipelines/definitions");

let failed = false;

for (const file of readdirSync(defsDir).filter((f) => /\.ya?ml$/.test(f))) {
  const def = parseYaml(readFileSync(join(defsDir, file), "utf8")) as {
    name: string;
    version: string;
    params?: DeclaredParam[];
  };
  const shortName = def.name.split("/").pop();
  const url = `https://raw.githubusercontent.com/nf-core/${shortName}/${def.version}/nextflow_schema.json`;
  process.stdout.write(`${def.name}@${def.version}: `);

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    console.log(`fetch error (${err instanceof Error ? err.message : String(err)})`);
    failed = true;
    continue;
  }
  if (!res.ok) {
    console.log(`schema not found (HTTP ${res.status}) — is the pinned revision tag correct?`);
    failed = true;
    continue;
  }

  const schema = await res.json();
  const props = collectSchemaProperties(schema);
  const params = def.params ?? [];
  const problems = checkParamsAgainstSchema(params, props);
  if (problems.length > 0) {
    console.log("issues:");
    for (const p of problems) console.log(`  - ${p}`);
    failed = true;
  } else {
    console.log(`OK (${params.length} params present; enum defaults/choices valid)`);
  }
}

process.exit(failed ? 1 : 0);
