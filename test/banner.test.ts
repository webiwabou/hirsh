import { describe, expect, it } from "vitest";
import { box, renderLogo, renderWelcome } from "../src/cli/banner.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("renderLogo", () => {
  it("is a compact single line with the wordmark", () => {
    const logo = renderLogo();
    expect(logo).not.toContain("\n");
    expect(strip(logo)).toContain("hirsh");
    expect(strip(logo)).toContain("●");
  });
});

describe("box", () => {
  it("frames lines to a constant visible width with rounded corners", () => {
    const out = box(["short", "a longer line here"]).split("\n");
    const widths = out.map((l) => strip(l).length);
    expect(new Set(widths).size).toBe(1); // every row same visible width
    expect(strip(out[0]).startsWith("╭")).toBe(true);
    expect(strip(out[out.length - 1]).startsWith("╰")).toBe(true);
  });
});

describe("renderWelcome", () => {
  it("shows the logo, meta and command tips", () => {
    const text = strip(
      renderWelcome({
        providerLabel: "anthropic (claude-fable-5)",
        configSource: "~/.bioagent/config.yaml",
        pipelines: ["rnaseq", "sarek"],
        envLine: "ready",
        cwd: "/tmp",
      }),
    );
    expect(text).toContain("hirsh");
    expect(text).toContain("bioinformatics co-scientist");
    expect(text).toContain("anthropic (claude-fable-5)");
    expect(text).toContain("rnaseq, sarek");
    expect(text).toContain("/help");
    expect(text).toContain("/exit");
    // The label and value don't run together.
    expect(text).toContain("pipelines rnaseq");
  });
});
