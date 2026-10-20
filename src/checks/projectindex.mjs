// What the project folder holds that the reference checks need: package.json scripts, Makefile
// targets, justfile recipes, and a file-name index for "did the file move?" hints. Everything is
// read lazily and cached, and the scan is bounded so a huge tree cannot make the tool slow.
import fs from "node:fs";
import path from "node:path";
import { isFile, listDir, readFileText, toPosix } from "../fsutil.mjs";

const SKIP = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", "out", "target", ".next", ".nuxt", ".output", ".cache", ".turbo",
  "coverage", ".venv", "venv", "__pycache__", ".tox", ".idea", ".vscode", ".claude-md-doctor",
]);
const MAX_ENTRIES = 30000;
const MAX_DEPTH = 6;
const MANIFEST_DEPTH = 4;

const MAKEFILES = ["Makefile", "makefile", "GNUmakefile"];
const JUSTFILES = ["justfile", "Justfile", ".justfile"];

export class ProjectIndex {
  constructor(project) {
    this.project = project;
    this._scan = null;
    this._pkg = new Map();
    this._pyproject = new Map();
  }

  // One bounded walk: manifests, Makefiles and justfiles up to four folders deep, every file and
  // folder name up to six deep.
  scan() {
    if (this._scan) return this._scan;
    const out = { manifests: [], pyprojects: [], makefiles: [], justfiles: [], names: new Map(), truncated: false };
    let entries = 0;
    const walk = (dir, depth) => {
      if (out.truncated) return;
      const list = listDir(dir);
      if (depth <= MANIFEST_DEPTH) {
        const has = (n) => list.some((e) => e.name === n && !e.isDirectory());
        if (has("package.json")) out.manifests.push(dir);
        if (has("pyproject.toml")) out.pyprojects.push(dir);
        if (MAKEFILES.some(has)) out.makefiles.push(dir);
        if (JUSTFILES.some(has)) out.justfiles.push(dir);
      }
      for (const e of list) {
        if (++entries > MAX_ENTRIES) { out.truncated = true; return; }
        const abs = path.join(dir, e.name);
        const key = e.name.toLowerCase();
        const rel = toPosix(path.relative(this.project, abs));
        if (!out.names.has(key)) out.names.set(key, []);
        out.names.get(key).push(e.isDirectory() ? `${rel}/` : rel);
        if (e.isDirectory() && !SKIP.has(e.name) && depth < MAX_DEPTH) walk(abs, depth + 1);
      }
    };
    walk(this.project, 0);
    this._scan = out;
    return out;
  }

  /** { scripts: Set, deps: Set } of the package.json in `dir`, or null when there is none. */
  pkg(dir) {
    if (this._pkg.has(dir)) return this._pkg.get(dir);
    let out = null;
    const info = readFileText(path.join(dir, "package.json"));
    if (info && !info.binary && !info.tooLarge) {
      try {
        const json = JSON.parse(info.text);
        if (json && typeof json === "object") {
          out = {
            scripts: new Set(Object.keys(json.scripts && typeof json.scripts === "object" ? json.scripts : {})),
            deps: new Set([...Object.keys(json.dependencies || {}), ...Object.keys(json.devDependencies || {}), ...Object.keys(json.optionalDependencies || {})]),
          };
        }
      } catch { /* a package.json that is not valid JSON has no scripts we can read */ }
    }
    this._pkg.set(dir, out);
    return out;
  }

  /** Every script name defined by any package.json in the project (the root and nearby packages). */
  allScripts() {
    const names = new Set();
    for (const dir of [this.project, ...this.scan().manifests]) for (const s of this.pkg(dir)?.scripts || []) names.add(s);
    return names;
  }

  hasAnyManifest() {
    return !!this.pkg(this.project) || this.scan().manifests.length > 0;
  }

  /** Parsed pyproject.toml in `dir`, or null when there is none. */
  pyproject(dir) {
    if (this._pyproject.has(dir)) return this._pyproject.get(dir);
    const out = readPyproject(dir);
    this._pyproject.set(dir, out);
    return out;
  }

  hasAnyPyproject() {
    return !!this.pyproject(this.project) || this.scan().pyprojects.length > 0;
  }

  /** Files or folders with the same name as `token`'s last segment, as project-relative paths. */
  sameName(token, limit = 3) {
    const base = token.replace(/\/+$/, "").split("/").pop().toLowerCase();
    if (!base) return [];
    return (this.scan().names.get(base) || []).slice(0, limit);
  }
}

// ---- Makefile targets and justfile recipes ----

/** { targets: Set, opaque } where opaque means included files or pattern rules hide some targets. */
export function parseMakefile(text) {
  const targets = new Set();
  let opaque = false;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("\t")) continue; // a recipe line
    const line = raw.replace(/(^|\s)#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    if (/^\s*(-|s)?include\b/.test(line)) { opaque = true; continue; }
    if (/^\s*(export\s+|override\s+)?[A-Za-z_][\w.-]*\s*[:?+!]{0,2}=/.test(line)) continue; // a variable
    const m = /^([^\s:=#][^:=]*?)\s*::?(?!=)/.exec(line);
    if (!m) continue;
    for (const name of m[1].split(/\s+/)) {
      if (name.includes("%")) { opaque = true; continue; }
      if (name === ".PHONY") {
        for (const phony of line.slice(line.indexOf(":") + 1).split(/\s+/).filter(Boolean)) targets.add(phony);
        continue;
      }
      if (name.startsWith(".") && name === name.toUpperCase()) continue; // special targets like .DEFAULT
      targets.add(name);
    }
  }
  return { targets, opaque };
}

/** { recipes: Set, opaque } where opaque means imports or modules hide some recipes. */
export function parseJustfile(text) {
  const recipes = new Set();
  let opaque = false;
  for (const raw of text.split("\n")) {
    if (/^\s/.test(raw) || !raw.trim()) continue; // a recipe body line
    const line = raw.replace(/(^|\s)#.*$/, "").trimEnd();
    if (!line) continue;
    if (/^(import|mod)\b/.test(line)) { opaque = true; continue; }
    const alias = /^alias\s+([A-Za-z_][\w-]*)\s*:=/.exec(line);
    if (alias) { recipes.add(alias[1]); continue; }
    if (/^(set|export|unexport)\b/.test(line) || line.startsWith("[")) continue;
    // A recipe is a name, optional parameters, then a colon that is not the := of an assignment.
    const head = /^@?([A-Za-z_][\w-]*)(.*)$/.exec(line);
    if (head && !/^\s*:?=/.test(head[2]) && /:(?!=)/.test(head[2])) recipes.add(head[1]);
  }
  return { recipes, opaque };
}

/** The Makefile or justfile in `dir`, parsed, or null. */
export function readBuildFile(dir, names, parse) {
  for (const n of names) {
    const file = path.join(dir, n);
    if (!isFile(file)) continue;
    const info = readFileText(file);
    if (info && !info.binary && !info.tooLarge) return parse(info.text);
  }
  return null;
}

export const readMakefile = (dir) => readBuildFile(dir, MAKEFILES, parseMakefile);
export const readJustfile = (dir) => readBuildFile(dir, JUSTFILES, parseJustfile);

// ---- pyproject.toml tasks (pdm, hatch, poe) ----

/**
 * { pdmScripts: Set, hatchEnvs: Map<string, Set>, hatchScripts: Set, poeTasks: Set }
 */
export function parsePyproject(text) {
  const pdmScripts = new Set();
  const hatchEnvs = new Map();
  const hatchScripts = new Set();
  const poeTasks = new Set();

  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;

    const secMatch = /^\[+([A-Za-z0-9_.-]+)\]+$/.exec(line);
    if (secMatch) {
      section = secMatch[1];
      if (section.startsWith("tool.pdm.scripts.")) {
        const sub = section.slice("tool.pdm.scripts.".length).split(".")[0];
        if (sub) pdmScripts.add(sub);
      } else if (section.startsWith("tool.poe.tasks.")) {
        const sub = section.slice("tool.poe.tasks.".length).split(".")[0];
        if (sub) poeTasks.add(sub);
      } else {
        const hm = /^tool\.hatch\.envs\.([A-Za-z0-9_.-]+)\.scripts(?:\.([A-Za-z0-9_.-]+))?$/.exec(section);
        if (hm) {
          const env = hm[1];
          if (!hatchEnvs.has(env)) hatchEnvs.set(env, new Set());
          if (hm[2]) {
            hatchEnvs.get(env).add(hm[2]);
            hatchScripts.add(hm[2]);
          }
        }
      }
      continue;
    }

    const kvMatch = /^(?:([A-Za-z0-9_.-]+)|"([^"]+)"|'([^']+)')\s*=/.exec(line);
    if (kvMatch) {
      const key = kvMatch[1] || kvMatch[2] || kvMatch[3];
      if (section === "tool.pdm.scripts") {
        pdmScripts.add(key);
      } else if (section === "tool.poe.tasks") {
        poeTasks.add(key);
      } else {
        const hm = /^tool\.hatch\.envs\.([A-Za-z0-9_.-]+)\.scripts$/.exec(section);
        if (hm) {
          const env = hm[1];
          if (!hatchEnvs.has(env)) hatchEnvs.set(env, new Set());
          hatchEnvs.get(env).add(key);
          hatchScripts.add(key);
        }
      }
    }
  }

  return { pdmScripts, hatchEnvs, hatchScripts, poeTasks };
}

export function readPyproject(dir) {
  const file = path.join(dir, "pyproject.toml");
  if (!isFile(file)) return null;
  const info = readFileText(file);
  if (info && !info.binary && !info.tooLarge) return parsePyproject(info.text);
  return null;
}

/** Does `node_modules/.bin/<name>` exist in `dir` (a locally installed tool)? */
export function hasLocalBin(dir, name) {
  const bin = path.join(dir, "node_modules", ".bin");
  return [name, `${name}.cmd`].some((n) => {
    try { fs.statSync(path.join(bin, n)); return true; } catch { return false; }
  });
}
