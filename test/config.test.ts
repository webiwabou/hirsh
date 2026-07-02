import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, resolveAnthropicApiKey } from "../src/config/loadConfig.js";

function writeTempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hirsh-cfg-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, contents, "utf8");
  return path;
}

afterEach(() => {
  delete process.env.HIRSH_CONFIG;
  delete process.env.MY_TEST_KEY;
});

describe("loadConfig", () => {
  it("reads provider and sections from HIRSH_CONFIG", () => {
    process.env.HIRSH_CONFIG = writeTempConfig(
      ["provider: anthropic", "anthropic:", "  apiKeyEnv: MY_TEST_KEY", "  model: some-model"].join("\n"),
    );
    const { config, sourcePath } = loadConfig();
    expect(sourcePath).toBe(process.env.HIRSH_CONFIG);
    expect(config.provider).toBe("anthropic");
    expect(config.anthropic.apiKeyEnv).toBe("MY_TEST_KEY");
    expect(config.anthropic.model).toBe("some-model");
    // defaults still applied for unspecified sections
    expect(config.execution.containerEngine).toBe("docker");
  });

  it("rejects an invalid provider", () => {
    process.env.HIRSH_CONFIG = writeTempConfig("provider: openai\n");
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("resolves the API key from the named env var", () => {
    process.env.HIRSH_CONFIG = writeTempConfig(
      ["provider: anthropic", "anthropic:", "  apiKeyEnv: MY_TEST_KEY"].join("\n"),
    );
    const { config } = loadConfig();
    expect(resolveAnthropicApiKey(config)).toBeNull();
    process.env.MY_TEST_KEY = "sk-ant-xyz";
    expect(resolveAnthropicApiKey(config)).toBe("sk-ant-xyz");
  });
});
