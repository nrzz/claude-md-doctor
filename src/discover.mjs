// Find everything Claude Code puts in front of the model before the first prompt, and what it
// loads later:
//
//   always loaded   <configDir>/CLAUDE.md (user), CLAUDE.md files in the parent folders of the
//                   working folder up to the filesystem root, ./CLAUDE.md, ./.claude/CLAUDE.md,
//                   ./CLAUDE.local.md, and everything those pull in with @path imports
//   on demand       CLAUDE.md files in subfolders: Claude Code reads them when it reads files there
//   in context      the name and description of model-invocable skills and of subagents
//
// Reading only: nothing here writes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { estimateTokens } from "./tokens.mjs";
import { parseDoc } from "./markdown.mjs";
import { parseFrontmatter, isTrue } from "./frontmatter.mjs";
import { classifyImport, importCandidates, MAX_IMPORT_DEPTH } from "./imports.mjs";
import { displayPath, isFile, isInside, listDir, readFileText, realKey } from "./fsutil.mjs";
import { makeFinding } from "./findings.mjs";

// Folders never searched for CLAUDE.md files on demand: dependencies, build output, tool caches.
const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", "out", "target", ".next", ".nuxt", ".output", ".cache", ".turbo",
  "coverage", ".venv", "venv", "__pycache__", ".tox", ".idea", ".vscode", ".claude", ".claude-md-doctor",
]);
const SCAN_MAX_DEPTH = 8;
const SCAN_MAX_DIRS = 4000;

// Parent folders of the project, outermost first, up to `ceiling` (inclusive) or the filesystem root.
export function parentDirs(project, ceiling = null) {
  const out = [];
  let prev = project;
  let dir = path.dirname(project);
  while (dir !== prev) {
    if (ceiling && !isInside(ceiling, dir)) break;
    out.unshift(dir);
    prev = dir;
    dir = path.dirname(dir);
  }
  return out;
}

function rootSpecs({ project, configDir, user, ceiling }) {
  const specs = [];
  if (user) specs.push({ kind: "user", abs: path.join(configDir, "CLAUDE.md") });
  for (const p of parentDirs(project, ceiling)) specs.push({ kind: "parent", abs: path.join(p, "CLAUDE.md") });
  specs.push({ kind: "project", abs: path.join(project, "CLAUDE.md") });
  specs.push({ kind: "project-claude", abs: path.join(project, ".claude", "CLAUDE.md") });
  specs.push({ kind: "local", abs: path.join(project, "CLAUDE.local.md") });
  return specs;
}

// A memory file we may rewrite: one of the project's own, and really inside the project.
const OWN_KINDS = new Set(["project", "project-claude", "local"]);

function makeFile(abs, info, meta, ctx) {
  const doc = parseDoc(info.text);
  return {
    abs,
    key: realKey(abs),
    display: displayPath(abs, ctx),
    kind: meta.kind,
    depth: meta.depth,
    ref: meta.ref || null,
    importedBy: meta.importedBy || null,
    importLine: meta.importLine || null,
    text: info.text,
    doc,
    tokens: estimateTokens(info.text),
    lines: doc.lines.length,
    bytes: info.bytes,
    bom: !!info.bom,
    eol: info.eol || "\n",
    rewritable: OWN_KINDS.has(meta.kind) && isInside(ctx.project, realPath(abs)),
  };
}

function realPath(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

const importError = (ctx, parent, line, message, fix, detail = {}) =>
  ctx.errors.push(makeFinding("import-error", { file: parent.display, line, message, fix, detail }));

// Load one file and, depth first, everything it imports. `chain` holds the keys of the files on
// the path from the root, to catch cycles.
function loadFile(abs, info, meta, chain, ctx) {
  const file = makeFile(abs, info, meta, ctx);
  ctx.loaded.set(file.key, file);
  ctx.files.push(file);
  const node = { file, ref: meta.ref || null, note: null, tokens: file.tokens, children: [] };
  const here = [...chain, file.key];

  for (const cand of importCandidates(file.doc)) {
    const target = classifyImport(cand.ref, path.dirname(abs), ctx.home);
    if (target.status === "ignore") continue;
    if (target.status === "folder") {
      importError(ctx, file, cand.line, `@${cand.ref} is a folder, not a file`, "Import a file, or list the files you need.", { ref: cand.ref });
      continue;
    }
    if (target.status === "missing") {
      importError(ctx, file, cand.line, `@${cand.ref} does not exist`, "Fix the path or delete the import.", { ref: cand.ref });
      node.children.push({ file: null, ref: cand.ref, note: "missing", tokens: 0, children: [] });
      continue;
    }

    const key = realKey(target.abs);
    if (here.includes(key)) {
      const names = [...here.slice(here.indexOf(key)).map((k) => ctx.loaded.get(k)?.display || k), ctx.loaded.get(key)?.display || cand.ref];
      importError(ctx, file, cand.line, `import cycle: ${names.join(" -> ")}`, "Remove the import that closes the loop.", { ref: cand.ref, cycle: names });
      node.children.push({ file: ctx.loaded.get(key), ref: cand.ref, note: "cycle", tokens: 0, children: [] });
      continue;
    }
    if (ctx.loaded.has(key)) { // imported twice: Claude Code loads it once
      node.children.push({ file: ctx.loaded.get(key), ref: cand.ref, note: "already loaded", tokens: 0, children: [] });
      continue;
    }
    if (meta.depth >= MAX_IMPORT_DEPTH) {
      importError(ctx, file, cand.line, `@${cand.ref} is nested deeper than ${MAX_IMPORT_DEPTH} levels, so Claude Code does not load it`, "Flatten the chain: import it from a file closer to the top, or inline it.", { ref: cand.ref, depth: meta.depth + 1 });
      node.children.push({ file: null, ref: cand.ref, note: "too deep", tokens: 0, children: [] });
      continue;
    }

    const child = readFileText(target.abs);
    if (!child || child.binary || child.tooLarge) {
      const why = child?.binary ? "is not a text file" : child?.tooLarge ? "is larger than 16 MB" : "could not be read";
      importError(ctx, file, cand.line, `@${cand.ref} ${why}`, "Import a text file.", { ref: cand.ref });
      node.children.push({ file: null, ref: cand.ref, note: "unreadable", tokens: 0, children: [] });
      continue;
    }
    node.children.push(loadFile(target.abs, child, { kind: "import", depth: meta.depth + 1, ref: cand.ref, importedBy: file.display, importLine: cand.line }, here, ctx));
  }
  return node;
}

// CLAUDE.md files in subfolders, which Claude Code reads only when it reads files there.
function scanOnDemand(ctx) {
  const found = [];
  let dirs = 0;
  let truncated = false;
  const walk = (dir, depth) => {
    if (truncated) return;
    if (++dirs > SCAN_MAX_DIRS) { truncated = true; return; }
    for (const e of listDir(dir)) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const sub = path.join(dir, e.name);
      const file = path.join(sub, "CLAUDE.md");
      if (isFile(file) && !ctx.loaded.has(realKey(file))) {
        const info = readFileText(file);
        if (info && !info.binary && !info.tooLarge) {
          found.push({ abs: file, display: displayPath(file, ctx), tokens: estimateTokens(info.text), lines: parseDoc(info.text).lines.length });
        }
      }
      if (depth < SCAN_MAX_DEPTH) walk(sub, depth + 1);
    }
  };
  walk(ctx.project, 1);
  found.sort((a, b) => (a.display < b.display ? -1 : a.display > b.display ? 1 : 0));
  return { found, truncated };
}

// What the model sees of a skill or an agent: one list line with its name and description.
export const listingTokens = (name, description) => estimateTokens(`- ${name}: ${description}`.trim());

function scanSkills(root, scope, ctx) {
  const out = [];
  for (const e of listDir(root)) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const file = path.join(root, e.name, "SKILL.md");
    const info = readFileText(file);
    if (!info || info.binary || info.tooLarge) continue;
    const fm = parseFrontmatter(info.text);
    const name = fm.name || e.name;
    const description = fm.description || "";
    const modelInvocable = !isTrue(fm["disable-model-invocation"]);
    out.push({ name, scope, display: displayPath(file, ctx), description, modelInvocable, tokens: modelInvocable ? listingTokens(name, description) : 0 });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function scanAgents(root, scope, ctx) {
  const out = [];
  for (const e of listDir(root)) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
    const file = path.join(root, e.name);
    const info = readFileText(file);
    if (!info || info.binary || info.tooLarge) continue;
    const fm = parseFrontmatter(info.text);
    const name = fm.name || e.name.replace(/\.md$/i, "");
    const description = fm.description || "";
    out.push({ name, scope, display: displayPath(file, ctx), description, tokens: listingTokens(name, description) });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Discover what loads. Options: dir (the working folder), configDir (Claude's config folder),
 * home (for ~/ imports), user (include the user-level memory, skills and agents), ceiling (stop
 * looking for parent CLAUDE.md files at this folder; used by the tests).
 */
export function discover({ dir, configDir, home = os.homedir(), user = true, ceiling = null } = {}) {
  const project = path.resolve(dir || process.cwd());
  const cfg = path.resolve(configDir);
  const ctx = { project, home, configDir: cfg, loaded: new Map(), files: [], errors: [], tree: [], notes: [] };

  for (const spec of rootSpecs({ project, configDir: cfg, user, ceiling: ceiling ? path.resolve(ceiling) : null })) {
    const info = readFileText(spec.abs);
    if (!info) continue;
    if (info.binary || info.tooLarge) { ctx.notes.push(`${displayPath(spec.abs, ctx)} was skipped: not a readable text file`); continue; }
    const key = realKey(spec.abs);
    if (ctx.loaded.has(key)) continue; // the same file reached through a link or a parent folder
    ctx.tree.push(loadFile(spec.abs, info, { kind: spec.kind, depth: 0 }, [], ctx));
  }

  const onDemand = scanOnDemand(ctx);
  const skills = [
    ...(user ? scanSkills(path.join(cfg, "skills"), "user", ctx) : []),
    ...scanSkills(path.join(project, ".claude", "skills"), "project", ctx),
  ];
  const agents = [
    ...(user ? scanAgents(path.join(cfg, "agents"), "user", ctx) : []),
    ...scanAgents(path.join(project, ".claude", "agents"), "project", ctx),
  ];

  return {
    project,
    configDir: cfg,
    home,
    user,
    files: ctx.files,
    tree: ctx.tree,
    errors: ctx.errors,
    onDemand: onDemand.found,
    onDemandTruncated: onDemand.truncated,
    skills,
    agents,
    notes: ctx.notes,
  };
}
