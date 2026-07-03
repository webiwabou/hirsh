import { describe, expect, it } from "vitest";
import { filterBracketedPaste } from "../src/cli/paste.js";

const START = "\x1b[200~";
const END = "\x1b[201~";

/** Feeds chunks through the streaming filter, accumulating output. */
function run(chunks: string[]): string {
  let out = "";
  let carry = "";
  let inPaste = false;
  for (const c of chunks) {
    const r = filterBracketedPaste(carry + c, inPaste);
    out += r.output;
    carry = r.carry;
    inPaste = r.inPaste;
  }
  return out + carry;
}

describe("filterBracketedPaste", () => {
  it("passes normal typing through unchanged", () => {
    expect(run(["hello world"])).toBe("hello world");
    expect(run(["a", "b", "c"])).toBe("abc");
  });

  it("strips paste markers and collapses newlines within a paste to spaces", () => {
    const pasted = `${START}>seq1\nMSLTK\nAAA${END}`;
    expect(run([pasted])).toBe(">seq1 MSLTK AAA");
  });

  it("keeps newlines outside a paste (they submit lines as usual)", () => {
    // A real Enter keypress arrives outside paste markers.
    const r = filterBracketedPaste("abc\n", false);
    expect(r.output).toBe("abc\n");
  });

  it("handles a paste split across chunk boundaries", () => {
    // The start marker is split, and a newline lands in a later chunk.
    const chunks = ["\x1b[2", "00~line1\n", "line2", END];
    expect(run(chunks)).toBe("line1 line2");
  });

  it("does not hold back a bare ESC (so Escape still works)", () => {
    const r = filterBracketedPaste("\x1b", false);
    expect(r.output).toBe("\x1b");
    expect(r.carry).toBe("");
  });

  it("carries a partial marker prefix for the next chunk", () => {
    const r = filterBracketedPaste("text\x1b[20", false);
    expect(r.output).toBe("text");
    expect(r.carry).toBe("\x1b[20");
  });
});
