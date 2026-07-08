import { describe, expect, it } from "vitest";
import {
  collectConditionalRequired,
  collectRequiredParams,
  conditionallyRequired,
  isSimpleFastqSheet,
  parseInputSchema,
  synthesizeSchemaParams,
  toColumnSpecs,
  validateParamValue,
  type InputColumn,
} from "../src/pipelines/nfcoreSchema.js";

// Mirrors the real nf-core nextflow_schema.json shape: params live inside grouped
// `definitions` with a per-group `required` array, referenced via `allOf`.
const SCHEMA = {
  allOf: [{ $ref: "#/definitions/input_output" }, { $ref: "#/definitions/reference" }],
  definitions: {
    input_output: {
      required: ["input", "outdir"],
      properties: {
        input: { type: "string", format: "file-path", description: "Samplesheet." },
        outdir: { type: "string", format: "directory-path", description: "Output dir." },
        email: { type: "string", description: "Notification email." },
      },
    },
    reference: {
      required: ["aligner"],
      properties: {
        genome: { type: "string", description: "iGenomes key." },
        fasta: {
          type: "string",
          format: "file-path",
          pattern: "^\\S+\\.fn?a(sta)?(\\.gz)?$",
          description: "Genome FASTA.",
        },
        gtf: { type: "string", format: "file-path", description: "Annotation GTF." },
        aligner: {
          type: "string",
          default: "bwa",
          enum: ["bwa", "bowtie2", "chromap", "star"],
          description: "Aligner.",
        },
        peakcaller: {
          type: "string",
          default: "macs2",
          enum: ["macs2", "genrich"],
          description: "Optional peak caller (has a default).",
        },
        save_reference: { type: "boolean", description: "Save the built index." },
        multiqc_title: { type: "string", hidden: true, description: "hidden knob" },
      },
    },
  },
};

describe("collectRequiredParams", () => {
  it("gathers required names from grouped definitions", () => {
    expect([...collectRequiredParams(SCHEMA)].sort()).toEqual(["aligner", "input", "outdir"]);
  });
});

describe("synthesizeSchemaParams", () => {
  const params = synthesizeSchemaParams(SCHEMA);
  const byName = Object.fromEntries(params.map((p) => [p.name, p]));

  it("excludes input/outdir (handled by the runner) and hidden params", () => {
    expect(byName.input).toBeUndefined();
    expect(byName.outdir).toBeUndefined();
    expect(byName.multiqc_title).toBeUndefined();
  });

  it("keeps references, the genome key and required enums; drops optional knobs", () => {
    expect(byName.fasta?.reference).toBe(true);
    expect(byName.gtf?.reference).toBe(true);
    expect(byName.genome?.reference).toBe(true);
    expect(byName.aligner?.kind).toBe("enum"); // required enum → kept, with choices
    expect(byName.aligner?.required).toBe(true);
    expect(byName.aligner?.choices).toEqual(["bwa", "bowtie2", "chromap", "star"]);
    expect(byName.peakcaller).toBeUndefined(); // optional enum with a default → dropped
    expect(byName.email).toBeUndefined(); // plain optional string
    expect(byName.save_reference).toBeUndefined(); // optional boolean flag
  });

  it("classifies kinds by format/enum", () => {
    expect(byName.fasta?.kind).toBe("file");
    expect(byName.genome?.kind).toBe("string");
  });

  it("captures a param-level pattern", () => {
    expect(byName.fasta?.pattern).toBe("^\\S+\\.fn?a(sta)?(\\.gz)?$");
    expect(byName.gtf?.pattern).toBeUndefined();
  });
});

describe("validateParamValue", () => {
  const fasta = { name: "fasta", kind: "file" as const, pattern: "^\\S+\\.fn?a(sta)?(\\.gz)?$" };

  it("accepts a value matching the pattern", () => {
    expect(validateParamValue(fasta, "/ref/genome.fasta").ok).toBe(true);
    expect(validateParamValue(fasta, "/ref/genome.fa.gz").ok).toBe(true);
  });

  it("rejects a value that doesn't match, with a plain-language message", () => {
    const r = validateParamValue(fasta, "/ref/genome.txt");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/doesn't match the expected format for fasta/);
  });

  it("does not constrain params without a pattern or non-string kinds", () => {
    expect(validateParamValue({ name: "x", kind: "file" }, "anything").ok).toBe(true);
    expect(validateParamValue({ name: "n", kind: "number", pattern: "^\\d+$" }, "abc").ok).toBe(true);
  });

  it("treats an unparseable pattern as no constraint", () => {
    expect(validateParamValue({ name: "x", kind: "string", pattern: "([" }, "whatever").ok).toBe(true);
  });
});

describe("collectConditionalRequired / conditionallyRequired", () => {
  const SCHEMA_DEP = {
    definitions: {
      grp: {
        dependentRequired: { aligner: ["fasta"] },
        properties: { aligner: { type: "string" }, fasta: { type: "string" } },
      },
      grp2: {
        // draft-07 object form of `dependencies`
        dependencies: { save_reference: ["outdir_index"] },
      },
    },
  };

  it("reads dependentRequired and the object form of dependencies", () => {
    const cond = collectConditionalRequired(SCHEMA_DEP);
    expect(cond.get("aligner")).toEqual(["fasta"]);
    expect(cond.get("save_reference")).toEqual(["outdir_index"]);
  });

  it("returns nothing for schemas without conditional keywords", () => {
    expect(collectConditionalRequired({ definitions: { g: { properties: {} } } }).size).toBe(0);
  });

  it("computes the extra params required by what's provided", () => {
    const cond = collectConditionalRequired(SCHEMA_DEP);
    expect([...conditionallyRequired(cond, ["aligner"])]).toEqual(["fasta"]);
    // fasta already provided → no extra.
    expect([...conditionallyRequired(cond, ["aligner", "fasta"])]).toEqual([]);
    // trigger absent → no extra.
    expect([...conditionallyRequired(cond, ["genome"])]).toEqual([]);
  });
});

describe("parseInputSchema", () => {
  const INPUT = {
    type: "array",
    items: {
      type: "object",
      required: ["sample", "fastq_1", "replicate"],
      properties: {
        sample: { type: "string" },
        fastq_1: { type: "string", format: "file-path" },
        fastq_2: { type: "string", format: "file-path" },
        replicate: { type: "integer" },
      },
    },
  };

  it("extracts columns with required + file flags", () => {
    const cols = parseInputSchema(INPUT);
    expect(cols).toEqual([
      { name: "sample", required: true, isFile: false },
      { name: "fastq_1", required: true, isFile: true },
      { name: "fastq_2", required: false, isFile: true },
      { name: "replicate", required: true, isFile: false },
    ]);
  });

  it("bridges to the validator's column spec", () => {
    expect(toColumnSpecs(parseInputSchema(INPUT))).toContainEqual({ name: "replicate", required: true });
  });

  it("tolerates a malformed schema", () => {
    expect(parseInputSchema(null)).toEqual([]);
    expect(parseInputSchema({})).toEqual([]);
  });
});

describe("isSimpleFastqSheet", () => {
  it("is true when only sample + FASTQ columns are required", () => {
    const cols: InputColumn[] = [
      { name: "sample", required: true, isFile: false },
      { name: "fastq_1", required: true, isFile: true },
      { name: "fastq_2", required: false, isFile: true },
    ];
    expect(isSimpleFastqSheet(cols)).toBe(true);
  });

  it("is false when an extra per-sample column is required (guessing biology)", () => {
    const cols: InputColumn[] = [
      { name: "sample", required: true, isFile: false },
      { name: "fastq_1", required: true, isFile: true },
      { name: "strandedness", required: true, isFile: false },
    ];
    expect(isSimpleFastqSheet(cols)).toBe(false);
  });

  it("is false with no required columns", () => {
    expect(isSimpleFastqSheet([{ name: "sample", required: false, isFile: false }])).toBe(false);
  });
});
