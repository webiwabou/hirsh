/**
 * Deriving parameters from context (Phase 6 — end-to-end autonomy).
 *
 * A bioinformatician doesn't ask "which genome?" when told the organism is human —
 * they reach for GRCh38. This maps an organism description to its iGenomes
 * reference key so Hirsh can fill the reference itself (in autonomous mode) or
 * propose it as the default (interactively), instead of asking. Pure and
 * unit-tested; conservative — returns null when it isn't confident.
 */

/** Ordered candidate iGenomes keys per organism matcher (best first). */
const ORGANISM_GENOMES: Array<{ match: RegExp; keys: string[] }> = [
  { match: /\b(human|homo[\s_-]?sapiens|h\.?\s?sapiens)\b/i, keys: ["GRCh38", "GRCh37", "hg38", "hg19"] },
  { match: /\b(mouse|mus[\s_-]?musculus|m\.?\s?musculus|murine)\b/i, keys: ["GRCm39", "GRCm38", "mm10"] },
  { match: /\b(rat|rattus[\s_-]?norvegicus)\b/i, keys: ["mRatBN7.2", "Rnor_6.0", "rn6"] },
  { match: /\b(zebrafish|danio[\s_-]?rerio)\b/i, keys: ["GRCz11", "GRCz10", "danRer10"] },
  { match: /\b(fruit[\s_-]?fly|drosophila|d\.?\s?melanogaster)\b/i, keys: ["BDGP6", "dm6"] },
  {
    match: /\b(worm|nematode|c\.?\s?elegans|caenorhabditis[\s_-]?elegans)\b/i,
    keys: ["WBcel235", "ce11"],
  },
  {
    match: /\b(yeast|budding[\s_-]?yeast|s\.?\s?cerevisiae|saccharomyces[\s_-]?cerevisiae)\b/i,
    keys: ["R64-1-1", "sacCer3"],
  },
  {
    match: /\b(arabidopsis|a\.?\s?thaliana|thale[\s_-]?cress|arabidopsis[\s_-]?thaliana)\b/i,
    keys: ["TAIR10"],
  },
  { match: /\b(chicken|gallus[\s_-]?gallus)\b/i, keys: ["GRCg6a", "galGal6"] },
  { match: /\b(cow|bovine|bos[\s_-]?taurus)\b/i, keys: ["ARS-UCD1.2", "bosTau8"] },
  { match: /\b(pig|sus[\s_-]?scrofa)\b/i, keys: ["Sscrofa11.1", "susScr11"] },
  { match: /\b(dog|canine|canis[\s_-]?familiaris|canis[\s_-]?lupus)\b/i, keys: ["CanFam3.1", "canFam3"] },
  { match: /\b(e\.?\s?coli|escherichia[\s_-]?coli)\b/i, keys: ["EB1"] },
];

export interface DerivedGenome {
  key: string;
  organism: string;
}

/**
 * Derives an iGenomes reference key from an organism description. When `allowed`
 * is given (the pipeline's `genome` choices), only a key in that set is returned,
 * so the derivation always yields a value the pipeline accepts. Returns null when
 * the organism is unknown/absent or no candidate is allowed. Pure.
 */
export function deriveGenomeKey(
  organism: string | undefined | null,
  allowed?: string[],
): DerivedGenome | null {
  const text = (organism ?? "").trim();
  if (text === "") return null;
  const allowSet = allowed && allowed.length > 0 ? new Set(allowed) : null;
  for (const { match, keys } of ORGANISM_GENOMES) {
    if (!match.test(text)) continue;
    const key = allowSet ? keys.find((k) => allowSet.has(k)) : keys[0];
    if (key) return { key, organism: text };
    // Matched the organism but none of its keys are allowed → can't satisfy.
    return null;
  }
  return null;
}
