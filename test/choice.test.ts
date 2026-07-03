import { describe, expect, it } from "vitest";
import { defaultOption, resolveChoice, type ChoiceOption } from "../src/conversation/choice.js";

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
