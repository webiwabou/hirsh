/** Types for the live nf-core/modules registry. */

export interface ModuleRef {
  /** Module name relative to modules/nf-core, e.g. "samtools/sort". */
  name: string;
  /** Full repo path, e.g. "modules/nf-core/samtools/sort". */
  path: string;
}

export interface ModuleIOElement {
  /** Element name (channel component), e.g. "meta", "reads", "bam". */
  name: string;
  /** meta.yml type: "map" | "file" | "string" | "directory" | ... */
  type: string;
  optional?: boolean;
  description?: string;
}

/** An input channel is an ordered list of elements (first is usually `meta`). */
export interface ModuleInputChannel {
  elements: ModuleIOElement[];
}

/** A named output channel (emit name), e.g. `bam`, `html`. */
export interface ModuleOutputChannel {
  name: string;
  elements: ModuleIOElement[];
}

export interface ModuleTool {
  name: string;
  description?: string;
  homepage?: string;
  doi?: string;
  licence?: string;
}

/** A parsed nf-core module (from its meta.yml). */
export interface NfCoreModule {
  name: string;
  path: string;
  description: string;
  keywords: string[];
  tools: ModuleTool[];
  inputs: ModuleInputChannel[];
  outputs: ModuleOutputChannel[];
}

/** The Nextflow process name a module exposes, e.g. "samtools/sort" → SAMTOOLS_SORT. */
export function processName(moduleName: string): string {
  return moduleName.replace(/[\/-]/g, "_").toUpperCase();
}

/** First non-meta file element of the first input channel (the "primary" input). */
export function primaryInput(mod: NfCoreModule): ModuleIOElement | undefined {
  for (const ch of mod.inputs) {
    const el = ch.elements.find((e) => e.type === "file");
    if (el) return el;
  }
  return undefined;
}

/** First output channel carrying a file (the "primary" output), skipping versions. */
export function primaryOutput(mod: NfCoreModule): ModuleOutputChannel | undefined {
  return mod.outputs.find(
    (o) => !o.name.startsWith("versions") && o.elements.some((e) => e.type === "file"),
  );
}
