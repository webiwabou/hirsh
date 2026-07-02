// Copies non-TypeScript assets (pipeline YAML definitions) to dist/ after
// compiling, so the registry finds them the same way as in development.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "src/pipelines/definitions");
const dest = resolve(root, "dist/pipelines/definitions");

if (!existsSync(src)) {
  console.warn(`[copy-assets] ${src} does not exist, nothing to copy.`);
  process.exit(0);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-assets] Pipeline definitions copied to ${dest}`);
