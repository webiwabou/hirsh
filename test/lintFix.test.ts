import { describe, expect, it } from "vitest";
import { planLintFixes, shouldContinueFixing, stripNfCoreTodos } from "../src/composition/lintFix.js";

describe("planLintFixes", () => {
  it("plans a repackage for missing-file and manifest findings", () => {
    expect(planLintFixes(["files_exist: File not found: CHANGELOG.md"])).toEqual({
      repackage: true,
      stripTodos: false,
    });
    expect(planLintFixes(["nextflow_config: manifest.homePage not set"]).repackage).toBe(true);
  });

  it("plans a TODO strip for pipeline_todos findings", () => {
    const plan = planLintFixes(["pipeline_todos: TODO string found in main.nf"]);
    expect(plan.stripTodos).toBe(true);
  });

  it("leaves both flags false for findings it can't fix", () => {
    expect(planLintFixes(["files_unchanged: main.nf does not match the template"])).toEqual({
      repackage: false,
      stripTodos: false,
    });
    expect(planLintFixes([])).toEqual({ repackage: false, stripTodos: false });
  });
});

describe("stripNfCoreTodos", () => {
  it("removes lines carrying a TODO nf-core marker, keeping the rest", () => {
    const text = ["process FOO {", "  // TODO nf-core: add resources", "  script:", "}"].join("\n");
    const { text: out, removed } = stripNfCoreTodos(text);
    expect(removed).toBe(1);
    expect(out).not.toMatch(/TODO nf-core/);
    expect(out).toContain("process FOO {");
    expect(out).toContain("script:");
  });

  it("is a no-op when there are no markers", () => {
    expect(stripNfCoreTodos("a\nb").removed).toBe(0);
  });
});

describe("shouldContinueFixing", () => {
  const plan = { repackage: true, stripTodos: false };
  it("stops when green, when lint didn't run, or with no progress", () => {
    expect(shouldContinueFixing({ ran: true, failed: 0 }, 5, plan)).toBe(false);
    expect(shouldContinueFixing({ ran: false }, 5, plan)).toBe(false);
    expect(shouldContinueFixing({ ran: true, failed: 5 }, 5, plan)).toBe(false); // no improvement
    expect(shouldContinueFixing({ ran: true, failed: 6 }, 5, plan)).toBe(false); // got worse
  });
  it("continues when failures improved and a fix is available", () => {
    expect(shouldContinueFixing({ ran: true, failed: 3 }, 5, plan)).toBe(true);
    expect(shouldContinueFixing({ ran: true, failed: 3 }, 5, { repackage: false, stripTodos: false })).toBe(
      false,
    );
  });
});
