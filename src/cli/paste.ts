/**
 * Bracketed-paste handling for the terminal.
 *
 * Terminals can wrap pasted text in `ESC[200~ … ESC[201~` markers ("bracketed
 * paste"). Without handling them, a pasted multi-line block is submitted line by
 * line by readline — so a pasted FASTA sequence gets truncated and auto-sent. This
 * strips the markers and collapses newlines *within* a paste to spaces, so a paste
 * lands as a single editable line the user can review and submit with Enter.
 *
 * The scanning is pure (chunk + state in, filtered text + carry/state out) so it
 * is unit-tested; a small Transform applies it to the live TTY.
 */
import { Transform, type TransformCallback } from "node:stream";
import type { ReadStream } from "node:tty";

/** DECSET/DECRST to enable / disable bracketed paste in the terminal. */
export const ENABLE_BRACKETED_PASTE = "\x1b[?2004h";
export const DISABLE_BRACKETED_PASTE = "\x1b[?2004l";

const START = "\x1b[200~";
const END = "\x1b[201~";

// Proper prefixes of a marker that could be split across a chunk boundary. A
// lone ESC is intentionally NOT held back (it would swallow a bare Escape key).
const PARTIALS = ["\x1b[201", "\x1b[200", "\x1b[20", "\x1b[2", "\x1b["];

/** Length of the longest suffix of `text` that is a partial paste marker. */
function partialTail(text: string): number {
  for (const p of PARTIALS) if (text.endsWith(p)) return p.length;
  return 0;
}

/**
 * Strips bracketed-paste markers and turns newlines inside a paste into spaces.
 * Streaming-safe: returns any trailing partial marker as `carry` (prepend it to
 * the next chunk) and the running `inPaste` state. Pure.
 */
export function filterBracketedPaste(
  chunk: string,
  inPaste: boolean,
): { output: string; carry: string; inPaste: boolean } {
  const tail = partialTail(chunk);
  const carry = tail ? chunk.slice(chunk.length - tail) : "";
  const text = tail ? chunk.slice(0, chunk.length - tail) : chunk;

  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith(START, i)) {
      inPaste = true;
      i += START.length;
    } else if (text.startsWith(END, i)) {
      inPaste = false;
      i += END.length;
    } else {
      const ch = text[i];
      out += inPaste && (ch === "\n" || ch === "\r") ? " " : ch;
      i++;
    }
  }
  return { output: out, carry, inPaste };
}

/**
 * A TTY-preserving Transform that applies bracketed-paste filtering between the
 * real stdin and readline/inquirer. Proxies the TTY surface (isTTY, setRawMode,
 * columns/rows, resize) so line editing, arrow keys and completion keep working.
 */
export class PasteFilterStream extends Transform {
  readonly isTTY = true;
  private carry = "";
  private inPaste = false;

  constructor(private readonly tty: ReadStream) {
    super();
    tty.pipe(this);
  }

  setRawMode(mode: boolean): this {
    this.tty.setRawMode(mode);
    return this;
  }

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    const r = filterBracketedPaste(this.carry + chunk.toString("utf8"), this.inPaste);
    this.carry = r.carry;
    this.inPaste = r.inPaste;
    if (r.output) this.push(r.output);
    cb();
  }

  detach(): void {
    this.tty.unpipe(this);
  }
}
