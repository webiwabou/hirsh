/**
 * Standards-compliant packaging (Phase 5).
 *
 * Turns a generated pipeline into a shareable, community-grade project by adding
 * the files a full nf-core template carries and that `nf-core lint` flags as
 * missing: a LICENSE (MIT by default), CHANGELOG, code of conduct, .gitignore, a
 * CI workflow, usage/output docs, and a filled-in `manifest` (author/homePage).
 *
 * Renderers are pure (spec in, text out) so they're unit-tested; only
 * packagePipeline touches disk.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface PackageSpec {
  pipelineName: string;
  /** Author/maintainer name for LICENSE + manifest. */
  author: string;
  /** GitHub "owner/repo" or full URL, used for manifest.homePage. */
  homePage?: string;
  /** LICENSE copyright holder; defaults to the author. */
  licenseHolder?: string;
  /** Copyright year; defaults to the current year. */
  year?: number;
  description?: string;
}

/** Normalizes "owner/repo" or a URL into an https GitHub URL (or "" if absent). */
export function homePageUrl(homePage?: string): string {
  if (!homePage) return "";
  if (/^https?:\/\//i.test(homePage)) return homePage;
  return `https://github.com/${homePage.replace(/^\/+|\/+$/g, "")}`;
}

export function renderMitLicense(spec: PackageSpec): string {
  const year = spec.year ?? new Date().getFullYear();
  const holder = spec.licenseHolder ?? spec.author;
  return `MIT License

Copyright (c) ${year} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

export function renderChangelog(spec: PackageSpec): string {
  const date = new Date().toISOString().slice(0, 10);
  return `# ${spec.pipelineName}: Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## v1.0.0dev - ${date}

Initial release scaffold composed by Hirsh from nf-core modules.

### Added

- Composed pipeline with channel-type-matched wiring and a runnable \`test\` profile.
`;
}

export function renderCodeOfConduct(): string {
  return `# Contributor Covenant Code of Conduct

## Our Pledge

We as members, contributors, and leaders pledge to make participation in our
community a harassment-free experience for everyone, regardless of age, body
size, visible or invisible disability, ethnicity, sex characteristics, gender
identity and expression, level of experience, education, socio-economic status,
nationality, personal appearance, race, religion, or sexual identity and
orientation.

## Our Standards

Examples of behavior that contributes to a positive environment include showing
empathy and kindness, respecting differing opinions, giving and gracefully
accepting constructive feedback, and focusing on what is best for the community.

Unacceptable behavior includes harassment, insulting or derogatory comments, and
publishing others' private information without permission.

## Enforcement

Instances of abusive, harassing, or otherwise unacceptable behavior may be
reported to the project maintainers. All complaints will be reviewed and
investigated promptly and fairly.

This Code of Conduct is adapted from the [Contributor Covenant](https://www.contributor-covenant.org),
version 2.1.
`;
}

export function renderGitignore(): string {
  return `.nextflow*
work/
results/
results_*/
.DS_Store
*.pyc
__pycache__/
`;
}

export function renderEditorConfig(): string {
  return `root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
trim_trailing_whitespace = true
indent_size = 4
indent_style = space

[*.{md,yml,yaml,cff}]
indent_size = 2

[*.{nf,config}]
indent_size = 4
`;
}

export function renderGitattributes(): string {
  return `*.config linguist-language=nextflow
*.nf linguist-language=nextflow
modules/nf-core/** linguist-generated
`;
}

export function renderContributing(spec: PackageSpec): string {
  return `# Contributing to ${spec.pipelineName}

Contributions are welcome. Please open an issue to discuss a change before a large
pull request, keep changes focused, and make sure the stub test passes
(\`nextflow run . -profile test -stub-run --outdir results_test\`).

This project follows the [nf-core](https://nf-co.re) conventions.
`;
}

export function renderPullRequestTemplate(spec: PackageSpec): string {
  return `## PR checklist

- [ ] This comment contains a description of the changes (with reason).
- [ ] The stub test passes (\`nextflow run . -profile test -stub-run --outdir results_test\`).
- [ ] Documentation (\`docs/usage.md\`, \`docs/output.md\`) is updated if needed.
- [ ] \`CHANGELOG.md\` is updated.

<!-- ${spec.pipelineName} -->
`;
}

export function renderCitationCff(spec: PackageSpec): string {
  return `cff-version: 1.2.0
message: "If you use ${spec.pipelineName}, please cite it as below."
title: "${spec.pipelineName}"
authors:
  - name: "${spec.author}"
${spec.homePage ? `repository-code: "${homePageUrl(spec.homePage)}"\n` : ""}license: MIT
`;
}

export function renderCiWorkflow(): string {
  return `name: CI
# Runs the pipeline's stub test on push/PR to catch breakages early.
on:
  push:
    branches: [master, main, dev]
  pull_request:

jobs:
  test:
    name: Stub run
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install Nextflow
        uses: nf-core/setup-nextflow@v2
      - name: Structural stub run
        run: |
          nextflow run . -profile test -stub-run --outdir results_test
`;
}

export function renderUsageDoc(spec: PackageSpec): string {
  return `# ${spec.pipelineName}: Usage

## Introduction

${spec.description ?? "This pipeline was composed by Hirsh from nf-core modules."}

## Samplesheet input

Provide a CSV samplesheet with \`--input\`:

\`\`\`csv
sample,fastq_1,fastq_2
SAMPLE1,/path/to/s1_R1.fastq.gz,/path/to/s1_R2.fastq.gz
\`\`\`

## Running the pipeline

\`\`\`bash
nextflow run ${spec.pipelineName} -profile docker --input samplesheet.csv --outdir results
\`\`\`

Provide any reference parameters listed in the project README for a real run.
`;
}

export function renderOutputDoc(spec: PackageSpec): string {
  return `# ${spec.pipelineName}: Output

Results are written under the directory given by \`--outdir\`. Each module writes
its outputs into a subdirectory named after the tool. See the pipeline README for
the specific steps this pipeline runs.
`;
}

/**
 * Adds `author` and `homePage` to the generated `nextflow.config` manifest block
 * (idempotent — skips a field that is already present). Pure.
 */
export function patchManifest(configText: string, spec: PackageSpec): string {
  const url = homePageUrl(spec.homePage);
  const additions: string[] = [];
  if (!/^\s*author\s*=/m.test(configText)) {
    additions.push(`    author          = ${JSON.stringify(spec.author)}`);
  }
  if (url && !/^\s*homePage\s*=/m.test(configText)) {
    additions.push(`    homePage        = '${url}'`);
  }
  if (additions.length === 0) return configText;

  // Insert right after the `name = '...'` line inside `manifest { ... }`.
  const nameLine = /(\n\s*name\s*=\s*'[^']*')/;
  if (nameLine.test(configText)) {
    return configText.replace(nameLine, `$1\n${additions.join("\n")}`);
  }
  // Fallback: insert after the opening of the manifest block.
  return configText.replace(/(manifest\s*\{)/, `$1\n${additions.join("\n")}`);
}

export interface PackageResult {
  files: string[];
  manifestPatched: boolean;
}

/** Writes the packaging files into a generated pipeline directory. */
export function packagePipeline(dir: string, spec: PackageSpec): PackageResult {
  const files: string[] = [];
  const write = (rel: string, contents: string) => {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents, "utf8");
    files.push(rel);
  };

  write("LICENSE", renderMitLicense(spec));
  write("CHANGELOG.md", renderChangelog(spec));
  write("CODE_OF_CONDUCT.md", renderCodeOfConduct());
  write(".gitignore", renderGitignore());
  write(".editorconfig", renderEditorConfig());
  write(".gitattributes", renderGitattributes());
  write("CITATION.cff", renderCitationCff(spec));
  write(".github/workflows/ci.yml", renderCiWorkflow());
  write(".github/CONTRIBUTING.md", renderContributing(spec));
  write(".github/PULL_REQUEST_TEMPLATE.md", renderPullRequestTemplate(spec));
  write("docs/usage.md", renderUsageDoc(spec));
  write("docs/output.md", renderOutputDoc(spec));

  let manifestPatched = false;
  const configPath = join(dir, "nextflow.config");
  try {
    const text = readFileSync(configPath, "utf8");
    const patched = patchManifest(text, spec);
    if (patched !== text) {
      writeFileSync(configPath, patched, "utf8");
      manifestPatched = true;
    }
  } catch {
    /* config missing/unreadable — packaging files still written */
  }

  return { files, manifestPatched };
}
