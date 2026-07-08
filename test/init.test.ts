import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeGitignore,
  runInit,
  starterConfigYaml,
  WORKSPACE_GITIGNORE,
} from "../src/cli/init.js";

describe("starterConfigYaml", () => {
  it("is a valid-looking starter with the key sections and no inline secret", () => {
    const y = starterConfigYaml();
    expect(y).toMatch(/provider: ollama/);
    expect(y).toMatch(/execution:/);
    expect(y).toMatch(/workdir: \.\/runs/);
    expect(y).toMatch(/apiKeyEnv: ANTHROPIC_API_KEY/);
    expect(y).not.toMatch(/sk-|gsk_/); // never embeds a real key
  });
});

describe("mergeGitignore", () => {
  it("creates a block when there is no existing file", () => {
    const { content, added } = mergeGitignore(null, WORKSPACE_GITIGNORE);
    expect(added).toEqual(WORKSPACE_GITIGNORE);
    expect(content).toMatch(/runs\//);
    expect(content).toMatch(/\.hirsh\//);
  });

  it("appends only the missing entries, preserving existing content", () => {
    const existing = "node_modules/\nruns/\n";
    const { content, added } = mergeGitignore(existing, WORKSPACE_GITIGNORE);
    expect(added).not.toContain("runs/"); // already present
    expect(added).toContain(".hirsh/");
    expect(content.startsWith("node_modules/\nruns/\n")).toBe(true);
  });

  it("is a no-op when everything is already present", () => {
    const existing = WORKSPACE_GITIGNORE.join("\n") + "\n";
    const { content, added } = mergeGitignore(existing, WORKSPACE_GITIGNORE);
    expect(added).toEqual([]);
    expect(content).toBe(existing);
  });
});

describe("runInit", () => {
  it("scaffolds config.yaml, .gitignore and .hirsh/ in a fresh dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "hirsh-init-"));
    try {
      const res = runInit(dir);
      expect(res.created).toContain("config.yaml");
      expect(res.created).toContain(".gitignore");
      expect(res.created).toContain(".hirsh/");
      expect(existsSync(join(dir, "config.yaml"))).toBe(true);
      expect(existsSync(join(dir, ".hirsh"))).toBe(true);
      expect(readFileSync(join(dir, ".gitignore"), "utf8")).toMatch(/runs\//);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never overwrites an existing config.yaml and only tops up .gitignore", () => {
    const dir = mkdtempSync(join(tmpdir(), "hirsh-init-"));
    try {
      writeFileSync(join(dir, "config.yaml"), "provider: anthropic\n", "utf8");
      writeFileSync(join(dir, ".gitignore"), "runs/\n", "utf8");
      const res = runInit(dir);
      expect(res.skipped).toContain("config.yaml");
      expect(readFileSync(join(dir, "config.yaml"), "utf8")).toBe("provider: anthropic\n");
      // .gitignore kept runs/ and gained the rest.
      const gi = readFileSync(join(dir, ".gitignore"), "utf8");
      expect(gi).toMatch(/^runs\/$/m);
      expect(gi).toMatch(/\.hirsh\//);
      expect(res.updated.some((u) => u.startsWith(".gitignore"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
