/**
 * Live nf-core/modules registry.
 *
 * Tracks https://github.com/nf-core/modules in real time: it resolves the
 * current `master` commit, lists every module, and lazily fetches+parses each
 * module's meta.yml. Results are cached on disk under ~/.bioagent/cache keyed by
 * the resolved commit SHA, so a given pipeline composition is reproducible (the
 * SHA is later pinned into the generated modules.json).
 *
 * Set GITHUB_TOKEN to raise the unauthenticated rate limit if needed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  type ModuleInputChannel,
  type ModuleOutputChannel,
  type ModuleRef,
  type NfCoreModule,
} from "./types.js";

const REPO = "nf-core/modules";
const RAW = "https://raw.githubusercontent.com";
const API = "https://api.github.com";

export class RegistryFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryFetchError";
  }
}

function cacheRoot(): string {
  return resolve(homedir(), ".bioagent", "cache", "nf-core-modules");
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) h.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function ghJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers: ghHeaders() });
  } catch (err) {
    throw new RegistryFetchError(
      `Could not reach GitHub (${url}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status === 403) {
    throw new RegistryFetchError(
      "GitHub API rate limit hit. Set GITHUB_TOKEN to a personal token to raise it, then retry.",
    );
  }
  if (!res.ok) {
    throw new RegistryFetchError(`GitHub returned ${res.status} for ${url}.`);
  }
  return res.json();
}

async function rawText(sha: string, repoPath: string): Promise<string> {
  const url = `${RAW}/${REPO}/${sha}/${repoPath}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new RegistryFetchError(
      `Could not fetch ${repoPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw new RegistryFetchError(`GitHub returned ${res.status} for ${repoPath}.`);
  return res.text();
}

export class ModuleRegistry {
  private sha: string | null = null;
  private modules: ModuleRef[] | null = null;
  private readonly metaCache = new Map<string, NfCoreModule>();

  /** Resolves and caches the current master commit SHA. */
  async resolveSha(): Promise<string> {
    if (this.sha) return this.sha;
    const data = (await ghJson(`${API}/repos/${REPO}/branches/master`)) as {
      commit?: { sha?: string };
    };
    const sha = data.commit?.sha;
    if (!sha) throw new RegistryFetchError("Could not resolve the nf-core/modules master commit.");
    this.sha = sha;
    return sha;
  }

  get pinnedSha(): string | null {
    return this.sha;
  }

  private shaCacheDir(sha: string): string {
    const dir = join(cacheRoot(), sha);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Lists all modules (name + path), cached on disk per SHA. */
  async listModules(): Promise<ModuleRef[]> {
    if (this.modules) return this.modules;
    const sha = await this.resolveSha();
    const cacheFile = join(this.shaCacheDir(sha), "modules.json");
    if (existsSync(cacheFile)) {
      this.modules = JSON.parse(readFileSync(cacheFile, "utf8")) as ModuleRef[];
      return this.modules;
    }
    const tree = (await ghJson(`${API}/repos/${REPO}/git/trees/${sha}?recursive=1`)) as {
      tree?: Array<{ path?: string; type?: string }>;
      truncated?: boolean;
    };
    const mods: ModuleRef[] = [];
    for (const entry of tree.tree ?? []) {
      if (entry.type !== "blob" || !entry.path) continue;
      const m = /^modules\/nf-core\/(.+)\/main\.nf$/.exec(entry.path);
      if (m) mods.push({ name: m[1], path: `modules/nf-core/${m[1]}` });
    }
    mods.sort((a, b) => a.name.localeCompare(b.name));
    writeFileSync(cacheFile, JSON.stringify(mods), "utf8");
    this.modules = mods;
    return mods;
  }

  /**
   * Ranks modules by relevance to the given free-text terms. Simple token
   * scoring over the module name — cheap and offline once the list is cached.
   */
  async search(terms: string[], limit = 25): Promise<ModuleRef[]> {
    const mods = await this.listModules();
    const toks = terms
      .flatMap((t) => t.toLowerCase().split(/[^a-z0-9]+/))
      .filter((t) => t.length >= 3);
    if (toks.length === 0) return [];
    const scored = mods
      .map((mod) => {
        const hay = mod.name.toLowerCase();
        let score = 0;
        for (const tok of toks) {
          if (hay === tok) score += 5;
          else if (hay.split(/[\/]/).includes(tok)) score += 4;
          else if (hay.includes(tok)) score += 2;
        }
        return { mod, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map((s) => s.mod);
  }

  /** Fetches a raw file from a module directory at the pinned SHA. */
  async fetchModuleFile(name: string, filename: string): Promise<string> {
    const sha = await this.resolveSha();
    return rawText(sha, `modules/nf-core/${name}/${filename}`);
  }

  /** Fetches and parses a module's meta.yml, cached in memory and on disk. */
  async getMeta(name: string): Promise<NfCoreModule> {
    if (this.metaCache.has(name)) return this.metaCache.get(name)!;
    const sha = await this.resolveSha();
    const cacheFile = join(this.shaCacheDir(sha), `${name.replace(/\//g, "__")}.meta.json`);
    if (existsSync(cacheFile)) {
      const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as NfCoreModule;
      this.metaCache.set(name, cached);
      return cached;
    }
    const text = await this.fetchModuleFile(name, "meta.yml");
    const mod = parseModuleMeta(name, text);
    writeFileSync(cacheFile, JSON.stringify(mod), "utf8");
    this.metaCache.set(name, mod);
    return mod;
  }
}

// --- meta.yml parsing (exported for testing without network) ---

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Extracts {name, type, optional} from an element map like `{ reads: {type: file} }`. */
function elementFromMap(item: unknown) {
  if (!isRecord(item)) return undefined;
  const key = Object.keys(item)[0];
  if (!key) return undefined;
  const spec = item[key];
  const s = isRecord(spec) ? spec : {};
  return {
    name: key,
    type: typeof s.type === "string" ? s.type : "unknown",
    optional: s.optional === true,
    description: typeof s.description === "string" ? s.description.trim() : undefined,
  };
}

/** A channel is either a list of element-maps or a single element-map. */
function normalizeChannel(channel: unknown): ModuleInputChannel {
  const elements = [];
  if (Array.isArray(channel)) {
    for (const item of channel) {
      const el = elementFromMap(item);
      if (el) elements.push(el);
    }
  } else {
    const el = elementFromMap(channel);
    if (el) elements.push(el);
  }
  return { elements };
}

export function parseModuleMeta(name: string, yamlText: string): NfCoreModule {
  const doc = parseYaml(yamlText);
  const d = isRecord(doc) ? doc : {};

  const keywords = Array.isArray(d.keywords)
    ? d.keywords.filter((k): k is string => typeof k === "string")
    : [];

  const tools = Array.isArray(d.tools)
    ? d.tools
        .map((t) => {
          if (!isRecord(t)) return undefined;
          const key = Object.keys(t)[0];
          const spec = isRecord(t[key]) ? (t[key] as Record<string, unknown>) : {};
          return {
            name: key,
            description: typeof spec.description === "string" ? spec.description.trim() : undefined,
            homepage: typeof spec.homepage === "string" ? spec.homepage : undefined,
            doi: typeof spec.doi === "string" ? spec.doi : undefined,
            licence: Array.isArray(spec.licence) ? String(spec.licence[0]) : undefined,
          };
        })
        .filter((t): t is NonNullable<typeof t> => Boolean(t))
    : [];

  const inputs: ModuleInputChannel[] = Array.isArray(d.input)
    ? d.input.map(normalizeChannel)
    : [];

  const outputs: ModuleOutputChannel[] = [];
  if (isRecord(d.output)) {
    for (const [chName, chVal] of Object.entries(d.output)) {
      if (chName.startsWith("versions")) continue;
      // Output channels are a list wrapping a list of elements: flatten one level.
      let elems: unknown = chVal;
      if (Array.isArray(chVal) && chVal.length === 1) elems = chVal[0];
      const { elements } = normalizeChannel(elems);
      outputs.push({ name: chName, elements });
    }
  }

  return {
    name,
    path: `modules/nf-core/${name}`,
    description: typeof d.description === "string" ? d.description.trim() : "",
    keywords,
    tools,
    inputs,
    outputs,
  };
}
