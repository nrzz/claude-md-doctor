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
const TASKFILES = [
  "Taskfile.yml", "Taskfile.yaml", "taskfile.yml", "taskfile.yaml",
  "Taskfile.dist.yml", "Taskfile.dist.yaml", "taskfile.dist.yml", "taskfile.dist.yaml",
];

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
    const out = { manifests: [], pyprojects: [], makefiles: [], justfiles: [], taskfiles: [], names: new Map(), truncated: false };
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
        if (TASKFILES.some(has)) out.taskfiles.push(dir);
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

function stripYamlComment(raw) {
  let q = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (q) {
      if (c === "\\" && q === '"') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
    } else if (c === "#") {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function findMappingColon(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ":") {
      if (i === text.length - 1 || text[i + 1] === " " || text[i + 1] === "\t") {
        return i;
      }
    }
  }
  return -1;
}

/** { tasks: Set, opaque } where opaque means includes hide some tasks. */
export function parseTaskfile(text) {
  const tasks = new Set();
  let opaque = false;
  let inTasks = false;
  let taskIndent = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = stripYamlComment(raw).trimEnd();
    if (!line.trim()) continue;

    const indent = line.match(/^\s*/)[0].length;
    if (indent === 0) {
      inTasks = /^tasks\s*:/.test(line);
      taskIndent = null;
      if (/^includes?\s*:/.test(line)) {
        opaque = true;
      }
      continue;
    }

    if (inTasks) {
      if (taskIndent === null) {
        taskIndent = indent;
      }
      if (indent === taskIndent) {
        const trimmed = line.slice(indent);
        if (trimmed.startsWith("-")) continue;
        let key = null;
        if (trimmed.startsWith('"')) {
          let end = -1;
          for (let i = 1; i < trimmed.length; i++) {
            if (trimmed[i] === "\\" && trimmed[i + 1] === '"') { i++; continue; }
            if (trimmed[i] === '"') { end = i; break; }
          }
          if (end !== -1 && trimmed.slice(end + 1).trimStart().startsWith(":")) {
            key = trimmed.slice(1, end);
          }
        } else if (trimmed.startsWith("'")) {
          const end = trimmed.indexOf("'", 1);
          if (end !== -1 && trimmed.slice(end + 1).trimStart().startsWith(":")) {
            key = trimmed.slice(1, end);
          }
        } else {
          const colonIdx = findMappingColon(trimmed);
          if (colonIdx > 0) {
            key = trimmed.slice(0, colonIdx).trim();
          }
        }
        if (key) {
          tasks.add(key);
        }
      }
    }
  }

  return { tasks, opaque };
}

/** The Makefile, justfile or Taskfile in `dir`, parsed, or null. */
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
export const readTaskfile = (dir) => readBuildFile(dir, TASKFILES, parseTaskfile);

// ---- pyproject.toml tasks (pdm, hatch, poe) ----

// pip's name rule (PEP 503): case, `-`, `_` and `.` do not matter.
export const normalizePackage = (name) => String(name).toLowerCase().replace(/[-_.]+/g, "-");

/** One line cut for the statement reader: the comment is dropped and the brackets are counted outside strings. */
function scanTomlLine(raw, state) {
  let out = "";
  let delta = 0;
  let i = 0;
  if (state.multiline) { // inside a """ string: skip to its end
    const end = raw.indexOf(state.multiline);
    if (end === -1) return { text: "", delta: 0 };
    raw = raw.slice(end + 3);
    state.multiline = null;
  }
  for (; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"' || c === "'") {
      const triple = c.repeat(3);
      if (raw.startsWith(triple, i)) {
        const end = raw.indexOf(triple, i + 3);
        if (end === -1) { state.multiline = triple; out += '""'; break; }
        out += '""';
        i = end + 2;
        continue;
      }
      out += c;
      for (i++; i < raw.length; i++) {
        out += raw[i];
        if (raw[i] === "\\" && c === '"') out += raw[++i] ?? "";
        else if (raw[i] === c) break;
      }
      continue;
    }
    if (c === "#") break;
    if (c === "[" || c === "{") delta++;
    else if (c === "]" || c === "}") delta--;
    out += c;
  }
  return { text: out.trim(), delta };
}

/** Index of the first `ch` outside quotes, or -1. */
function indexOutsideQuotes(text, ch) {
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === ch) return i;
  }
  return -1;
}

/** `a."b.c".d` -> ["a", "b.c", "d"] */
function splitDotted(text) {
  const parts = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === q) q = null; else cur += c; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === ".") { parts.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  parts.push(cur.trim());
  return parts.filter((p) => p !== "");
}

/** The quoted strings of an array or inline table value. */
function stringsIn(value) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let m;
  while ((m = re.exec(value))) out.push(m[1] ?? m[2]);
  return out;
}

/** The top-level keys of an inline table `{ a = 1, b.c = "x" }`, or null when the value is not one. */
function inlineKeys(value) {
  const v = value.trim();
  if (!v.startsWith("{")) return null;
  const inner = v.slice(1, v.lastIndexOf("}") === -1 ? undefined : v.lastIndexOf("}"));
  const keys = [];
  let depth = 0;
  let q = null;
  let start = 0;
  const take = (end) => {
    const part = inner.slice(start, end);
    const eq = indexOutsideQuotes(part, "=");
    if (eq > 0) { const segs = splitDotted(part.slice(0, eq)); if (segs[0]) keys.push(segs[0]); }
  };
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) { take(i); start = i + 1; }
  }
  take(inner.length);
  return keys;
}

/**
 * What the pyproject.toml defines, read line by line (a value may run over several lines):
 * { pdmScripts: Set, hatchEnvs: Map<env, Set<script>>, hatchScripts: Set, hatchTemplates: Map<env, string[]>,
 *   hatchMatrix: boolean, poeTasks: Set, deps: Set<normalized package name>,
 *   opaque: { pdm, hatch, poe } (a part that is present but cannot be read: say nothing about it) }
 * Scripts and tasks are read from tables (`[tool.pdm.scripts]`, `[tool.hatch.envs.x.scripts]`, `[tool.poe.tasks]`), from
 * inline tables (`scripts = { lint = "..." }`) and from dotted keys (`scripts.lint = "..."`).
 */
export function parsePyproject(text) {
  const pdmScripts = new Set();
  const hatchEnvs = new Map();
  const hatchScripts = new Set();
  const hatchTemplates = new Map();
  const poeTasks = new Set();
  const deps = new Set();
  const opaque = { pdm: false, hatch: false, poe: false };
  let hatchMatrix = false;

  const addDeps = (value) => { for (const s of stringsIn(value)) { const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(s); if (m) deps.add(normalizePackage(m[1])); } };
  const defineEnv = (env) => { if (!hatchEnvs.has(env)) hatchEnvs.set(env, new Set()); return hatchEnvs.get(env); };
  const names = (set, p, at, value) => { // a table or key at p[at - 1] holds the names: p[at] if there is one, else the inline table's keys
    if (p.length > at) set.add(p[at]);
    else for (const k of inlineKeys(value || "") || []) set.add(k);
  };

  // p: the key as a path of names; value: the text after `=` (null for a table header)
  const handle = (p, value) => {
    if (p[0] === "project" && (p[1] === "dependencies" || p[1] === "optional-dependencies")) { if (value) addDeps(value); return; }
    if (p[0] === "dependency-groups") { if (value) addDeps(value); return; }
    if (p[0] !== "tool") return;
    const v = value || "";
    if (p.length === 1 && v.trim().startsWith("{")) { opaque.pdm = opaque.hatch = opaque.poe = true; return; }
    if (p[1] === "pdm") {
      if (p.length === 2 && v.trim().startsWith("{")) opaque.pdm = true;
      else if (p[2] === "scripts") names(pdmScripts, p, 3, v);
      else if (p[2] === "dev-dependencies" && value) addDeps(value);
    } else if (p[1] === "poe") {
      if (p.length === 2 && v.trim().startsWith("{")) opaque.poe = true;
      else if (p[2] === "tasks") names(poeTasks, p, 3, v);
      else if (p[2] === "include" || p[2] === "includes") opaque.poe = true; // tasks kept in other files
    } else if (p[1] === "hatch") {
      if (p[2] !== "envs") return;
      if (p.length === 3) { if (v.trim().startsWith("{")) opaque.hatch = true; return; }
      const env = p[3];
      const own = defineEnv(env);
      if (p[4] === "scripts") {
        const before = new Set(own);
        names(own, p, 5, v);
        for (const s of own) if (!before.has(s)) hatchScripts.add(s);
      } else if (p[4] === "template" && value) hatchTemplates.set(env, stringsIn(value));
      else if ((p[4] === "dependencies" || p[4] === "extra-dependencies") && value) addDeps(value);
      else if (p[4] === "matrix") hatchMatrix = true;
    }
  };

  let header = [];
  let pending = null; // a key whose value runs over several lines
  let depth = 0;
  const state = { multiline: null };
  const finish = () => {
    const eq = indexOutsideQuotes(pending, "=");
    if (eq > 0) handle(header.concat(splitDotted(pending.slice(0, eq))), pending.slice(eq + 1).trim());
    pending = null;
    depth = 0;
  };
  for (const raw of text.split(/\r?\n/)) {
    const { text: line, delta } = scanTomlLine(raw, state);
    if (!line) continue;
    if (pending === null) {
      const h = /^\[\[?\s*(.+?)\s*\]\]?$/.exec(line);
      if (h && !line.includes("=")) { header = splitDotted(h[1]); handle(header, null); continue; }
      pending = line;
      depth = delta;
    } else {
      pending += ` ${line}`;
      depth += delta;
    }
    if (depth <= 0) finish();
  }
  if (pending !== null) finish();

  return { pdmScripts, hatchEnvs, hatchScripts, hatchTemplates, hatchMatrix, poeTasks, deps, opaque };
}

export function readPyproject(dir) {
  const file = path.join(dir, "pyproject.toml");
  if (!isFile(file)) return null;
  const info = readFileText(file);
  if (info && !info.binary && !info.tooLarge) {
    const py = parsePyproject(info.text);
    if (isFile(path.join(dir, "hatch.toml"))) py.opaque.hatch = true; // environments may be defined there
    return py;
  }
  return null;
}

/** Is `name` an executable in the project's virtual environment (`.venv/bin` or `.venv/Scripts`)? */
export function hasVenvBin(dir, name) {
  if (/[\\/]/.test(name)) return false;
  return ["bin", "Scripts"].some((sub) => [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`].some((n) => isFile(path.join(dir, ".venv", sub, n))));
}

/** Does `node_modules/.bin/<name>` exist in `dir` (a locally installed tool)? */
export function hasLocalBin(dir, name) {
  const bin = path.join(dir, "node_modules", ".bin");
  return [name, `${name}.cmd`].some((n) => {
    try { fs.statSync(path.join(bin, n)); return true; } catch { return false; }
  });
}
