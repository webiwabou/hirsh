import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  canonicalSequenceName,
  classifySequenceText,
  detectBinaryMagic,
  inferPairs,
  linkCanonicalSequences,
  scanFastqs,
  scanSequenceDir,
} from "../src/execution/samplesheet.js";

const FASTQ = "@read1\nACGTACGT\n+\n!!!!!!!!\n@read2\nTTTTGGGG\n+\nIIIIIIII\n";
const FASTA = ">seq1\nACGTACGTACGT\n>seq2\nTTTTGGGG\n";

describe("classifySequenceText", () => {
  it("recognizes FASTQ, FASTA, and rejects SAM/plain text", () => {
    expect(classifySequenceText(FASTQ)).toBe("fastq");
    expect(classifySequenceText(FASTA)).toBe("fasta");
    // SAM starts with "@" but has no "+" separator line → not FASTQ.
    expect(classifySequenceText("@HD\tVN:1.6\n@SQ\tSN:chr1\tLN:100\nr1\t0\tchr1\t1")).toBeNull();
    expect(classifySequenceText("just some notes\nnothing here")).toBeNull();
    expect(classifySequenceText("")).toBeNull();
  });
});

describe("detectBinaryMagic", () => {
  it("flags BAM/CRAM/HDF5/POD5/SRA and passes text through", () => {
    expect(detectBinaryMagic(new Uint8Array([0x42, 0x41, 0x4d, 0x01]))).toBe("BAM");
    expect(detectBinaryMagic(new Uint8Array([0x43, 0x52, 0x41, 0x4d]))).toBe("CRAM");
    expect(detectBinaryMagic(new Uint8Array([0x89, 0x48, 0x44, 0x46]))).toBe("HDF5 (fast5)");
    expect(detectBinaryMagic(new Uint8Array([0x8b, 0x50, 0x4f, 0x44, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("POD5");
    // "NCBI.sra"
    expect(detectBinaryMagic(new Uint8Array([0x4e, 0x43, 0x42, 0x49, 0x2e, 0x73, 0x72, 0x61]))).toBe("SRA");
    expect(detectBinaryMagic(new Uint8Array([0x40, 0x72, 0x65]))).toBeNull(); // "@re"
  });
});

describe("canonicalSequenceName", () => {
  it("preserves the base (R1/R2) and picks the extension from format + gzip", () => {
    expect(canonicalSequenceName("s1_R1.txt", "fastq", false)).toBe("s1_R1.fastq");
    expect(canonicalSequenceName("s1_R1.txt.gz", "fastq", true)).toBe("s1_R1.fastq.gz");
    expect(canonicalSequenceName("prot", "fasta", false)).toBe("prot.fasta");
  });
});

describe("scanSequenceDir + linkCanonicalSequences (content-based ingestion)", () => {
  let dir: string;
  let linkDir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "hirsh-ingest-"));
    linkDir = join(dir, "inputs");
    // Plain-text FASTQ named .txt, and a gzipped FASTQ named .seq.gz.
    writeFileSync(join(dir, "s1_R1.txt"), FASTQ);
    writeFileSync(join(dir, "s1_R2.seq.gz"), gzipSync(Buffer.from(FASTQ)));
    // A notes file (text, not sequence) and a BAM-magic binary file.
    writeFileSync(join(dir, "README.txt"), "these are my samples\n");
    writeFileSync(join(dir, "aln.dat"), Buffer.from([0x42, 0x41, 0x4d, 0x01, 0, 1, 2, 3]));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("recognizes FASTQ by content regardless of extension, reports unsupported", async () => {
    const scan = await scanSequenceDir(dir);
    expect(scan.sequences.map((s) => basename(s.file)).sort()).toEqual(["s1_R1.txt", "s1_R2.seq.gz"]);
    const r1 = scan.sequences.find((s) => s.file.endsWith("s1_R1.txt"))!;
    const r2 = scan.sequences.find((s) => s.file.endsWith("s1_R2.seq.gz"))!;
    expect(r1.gzipped).toBe(false);
    expect(r2.gzipped).toBe(true);
    expect(scan.unsupported.map((u) => u.reason)).toContain("BAM");
    // README.txt is plain text but not a sequence → neither recognized nor flagged.
    expect(scan.sequences.some((s) => s.file.endsWith("README.txt"))).toBe(false);
  });

  it("symlinks to canonical names that then pair as R1/R2", async () => {
    const scan = await scanSequenceDir(dir);
    const res = linkCanonicalSequences(scan.sequences, linkDir);
    expect(res.linked.length).toBe(2);
    // The link targets follow the sequence data.
    const names = res.linked.map((l) => basename(l.to)).sort();
    expect(names).toEqual(["s1_R1.fastq", "s1_R2.fastq.gz"]);
    readlinkSync(res.linked[0].to); // exists as a symlink

    const pairs = inferPairs(scanFastqs(linkDir));
    expect(pairs).toHaveLength(1);
    expect(basename(pairs[0].fastq_1)).toBe("s1_R1.fastq");
    expect(basename(pairs[0].fastq_2 ?? "")).toBe("s1_R2.fastq.gz");
  });
});

describe("content-based ingestion — protein FASTA", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "hirsh-fasta-"));
    writeFileSync(join(dir, "prot.seq"), FASTA); // FASTA content, non-standard extension
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("recognizes FASTA by content and links it to a canonical .fasta name", async () => {
    const scan = await scanSequenceDir(dir);
    expect(scan.sequences.map((s) => s.format)).toEqual(["fasta"]);
    const res = linkCanonicalSequences(scan.sequences, join(dir, "inputs"));
    expect(res.linked.map((l) => basename(l.to))).toEqual(["prot.fasta"]);
  });
});
