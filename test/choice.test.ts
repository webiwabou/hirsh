import { describe, expect, it } from "vitest";
import { chooseWith, defaultOption, resolveChoice, type ChoiceOption } from "../src/conversation/choice.js";
import type { AgentIO } from "../src/conversation/io.js";

const options: ChoiceOption[] = [
  { value: "later", label: "I'm not sure — set it up later", recommended: true },
  { value: "conda", label: "A conda / bioconda package" },
  { value: "container", label: "A container image" },
];

describe("defaultOption", () => {
  it("prefers the recommended option, else the first", () => {
    expect(defaultOption(options)?.value).toBe("later");
    expect(defaultOption([{ value: "a", label: "A" }, { value: "b", label: "B" }])?.value).toBe("a");
    expect(defaultOption([])).toBeUndefined();
  });
});

describe("resolveChoice", () => {
  it("empty input picks the recommended default", () => {
    expect(resolveChoice("", options)).toBe("later");
    expect(resolveChoice("   ", options)).toBe("later");
  });

  it("resolves a number in range to that option's value", () => {
    expect(resolveChoice("2", options)).toBe("conda");
    expect(resolveChoice("3", options)).toBe("container");
  });

  it("matches a label or value case-insensitively", () => {
    expect(resolveChoice("conda", options)).toBe("conda");
    expect(resolveChoice("A Container Image", options)).toBe("container");
  });

  it("strips a leading @ path reference", () => {
    expect(resolveChoice("@/data/tool.py", options)).toBe("/data/tool.py");
  });

  it("returns free text as a custom answer (incl. an out-of-range number)", () => {
    expect(resolveChoice("bioconda::mmseqs2=15", options)).toBe("bioconda::mmseqs2=15");
    expect(resolveChoice("9", options)).toBe("9"); // out of range → custom
    expect(resolveChoice("2 things", options)).toBe("2 things"); // not a bare number
  });
});

describe("chooseWith", () => {
  it("delegates to io.select when the frontend supports it", async () => {
    const calls: unknown[] = [];
    const io = {
      say() {},
      info() {},
      async ask() {
        throw new Error("ask should not be called when select exists");
      },
      async select(_q: string, _o: ChoiceOption[], opts?: unknown) {
        calls.push(opts);
        return "conda";
      },
    } as unknown as AgentIO;
    const result = await chooseWith(io, "How is it provided?", options, { customHint: "type a package" });
    expect(result).toBe("conda");
    expect(calls[0]).toEqual({ allowCustom: true, customLabel: "type a package" });
  });

  it("falls back to a numbered ask prompt when select is absent", async () => {
    const io = {
      say() {},
      info() {},
      async ask() {
        return "2"; // pick option index 2 → "conda"
      },
    } as unknown as AgentIO;
    expect(await chooseWith(io, "q", options)).toBe("conda");
  });
});
