/**
 * nf-core inclusion guidance (Phase 5).
 *
 * Walks the scientist through the community process to have a pipeline adopted
 * into nf-core: naming, scope proposal, template/lint requirements, and the
 * request/review steps. Honest by design — acceptance is a community decision the
 * agent cannot guarantee; it prepares and advises, people decide.
 *
 * Pure: name validation and guide text are produced from inputs, no I/O.
 */

export interface NameCheck {
  ok: boolean;
  /** A valid nf-core-style name derived from the input. */
  normalized: string;
  /** Human-readable issues with the given name (empty if ok). */
  issues: string[];
}

/**
 * Validates a candidate nf-core pipeline name. nf-core names are short, lowercase
 * and alphanumeric only (no spaces, hyphens or underscores) and must not start
 * with a digit. Returns a normalized suggestion regardless.
 */
export function validateNfCoreName(input: string): NameCheck {
  const raw = input.trim().replace(/^nf-core\//i, "");
  const issues: string[] = [];
  if (raw === "") issues.push("The name is empty.");
  if (/[A-Z]/.test(raw)) issues.push("Use lowercase only.");
  if (/[^a-zA-Z0-9]/.test(raw)) issues.push("Use letters and digits only — no spaces, hyphens or underscores.");
  if (/^[0-9]/.test(raw)) issues.push("The name must not start with a digit.");
  if (raw.length > 0 && raw.length < 3) issues.push("The name is very short; prefer something descriptive.");

  const normalized = raw.toLowerCase().replace(/[^a-z0-9]/g, "") || "mypipeline";
  return { ok: issues.length === 0, normalized, issues };
}

const CONTRIBUTING_DOCS = "https://nf-co.re/docs/contributing/pipelines";
const PROPOSALS = "https://github.com/nf-core/proposals";
const JOIN_SLACK = "https://nf-co.re/join";

/** Builds the step-by-step inclusion guide for a pipeline (Markdown). */
export function buildInclusionGuide(pipelineName: string): string {
  const check = validateNfCoreName(pipelineName);
  const nameLine = check.ok
    ? `\`${check.normalized}\` is a valid nf-core-style name.`
    : `The name would need to be adjusted (e.g. \`${check.normalized}\`): ${check.issues.join(" ")}`;

  return `# Getting "${pipelineName}" into nf-core

> **Honest note:** adoption into nf-core is a **community decision** — Hirsh
> prepares and advises, but cannot guarantee acceptance. The steps below reflect the
> community process; the official docs are the source of truth: ${CONTRIBUTING_DOCS}

## 1. Naming
nf-core pipeline names are short, lowercase and alphanumeric (\`nf-core/<name>\`).
${nameLine}

## 2. Propose it (scope check)
Before building, propose the pipeline so the community can confirm it's in scope and
not duplicating an existing one:
- Join the nf-core Slack (${JOIN_SLACK}) and raise it in the #new-pipelines channel, and/or
- open a proposal at ${PROPOSALS}.
Duplicating an existing nf-core pipeline is the most common reason a proposal stalls.

## 3. Use the official template
Adopted pipelines are built from the nf-core pipeline template:
\`nf-core pipelines create\`. Port your composed steps into that structure (Hirsh's
generated project is template-shaped but is not a substitute for the official
template).

## 4. Meet the requirements
- Green \`nf-core pipelines lint\`.
- CI that runs the test profile; full-size \`test\`/\`test_full\` data.
- Docs (usage/output), \`CHANGELOG\`, licence (MIT), code of conduct.
- \`nf-test\` tests for modules/subworkflows.

## 5. Request creation & review
A maintainer creates the repository under the nf-core organisation; development then
happens there with **reviews from at least two community members** before a release.

## 6. Release
Once lint and tests are green and reviewers approve, the pipeline is released under
nf-core and announced. Ongoing maintenance is expected.

_Hirsh has already helped with packaging, a lint gate and (for custom tools) an
nf-core/modules-style contribution — those are inputs to this process, not a
replacement for it._
`;
}
