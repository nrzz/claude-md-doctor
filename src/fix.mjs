// --fix: build the lean version of each memory file the project owns, and the skills that take
// over the procedure sections. planFix() only computes; applyFix() writes, either as a proposal
// next to the originals (CLAUDE.md.lean, .claude-md-doctor/proposed-skills/) or, with --write, in
// place after backing every original up.
import fs from "node:fs";
import path from "node:path";
import { estimateTokens } from "./tokens.mjs";
import { proposeSkill } from "./skills.mjs";
import { exists, listDir, timestamp, uniquePath, writeFileText } from "./fsutil.mjs";
import { slugify } from "./text.mjs";
import { listingTokens } from "./discover.mjs";

// Is `line` of `file` inside the range of an op that is not itself a repeat-removal?
const covered = (ops, file, line) => ops.some((o) => !o.dupOf && o.file === file && o.start <= line && line <= o.end);

/**
 * The repeat-removals to keep. A repeat is removed because its original stays. When the original
 * itself leaves the memory (it is in a section that moves to a skill, or on a line that goes), the
 * first remaining copy becomes the new original and only the copies after it are removed.
 */
function repeatOps(ops, order) {
  const firm = ops.filter((o) => !o.dupOf);
  // Repeats that are already gone with a section or a line that is removed need no work of their own.
  const repeats = ops
    .filter((o) => o.dupOf && !covered(firm, o.file, o.start))
    .sort((a, b) => order(a.file) - order(b.file) || a.start - b.start);
  const keep = [];
  const standIn = new Map(); // original -> the copy that now stands in for it
  for (const op of repeats) {
    if (!covered(firm, op.dupOf.file, op.dupOf.line)) { if (op.fixable) keep.push(op); continue; }
    const key = `${op.dupOf.file.abs}:${op.dupOf.line}`;
    if (!standIn.has(key)) { standIn.set(key, op); continue; } // this copy stays and stands in for the original
    if (op.fixable) keep.push(op);
  }
  return keep;
}

/**
 * The lean text of one file given the lines to drop and the sections to replace.
 *   removed       Set of 1-based line numbers to drop
 *   replacements  Map of line number -> lines that stand in for a dropped section
 */
function compose(file, removed, replacements) {
  const out = [];
  let after = false; // the previous original line was dropped
  for (const line of file.doc.lines) {
    const n = line.n;
    if (replacements.has(n)) { out.push(...replacements.get(n)); after = true; continue; }
    if (removed.has(n)) { after = true; continue; }
    if (after && line.text.trim() === "" && (!out.length || out[out.length - 1].trim() === "")) continue; // do not leave a double gap
    after = false;
    out.push(line.text);
  }
  if (after) while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out.length ? out.join("\n") + (file.text.endsWith("\n") ? "\n" : "") : "";
}

// A code block with nothing left in it goes too; so does a heading whose section ended up empty.
function tidy(file, removed, replacements) {
  const { doc } = file;
  const text = (n) => doc.lines[n - 1].text;
  for (const f of doc.fences) {
    const body = [];
    for (let n = f.contentStart; n <= f.contentEnd; n++) if (text(n).trim() !== "") body.push(n);
    if (body.length && body.every((n) => removed.has(n))) {
      for (let n = f.open; n <= (f.close ?? f.contentEnd); n++) removed.add(n);
    }
  }
  const total = doc.lines.length;
  const dropped = new Set();
  for (let i = doc.headings.length - 1; i >= 0; i--) {
    const h = doc.headings[i];
    if (removed.has(h.n) || replacements.has(h.n)) continue;
    const next = doc.headings[i + 1]?.n ?? total + 1;
    let gone = 0;
    let kept = 0;
    for (let n = h.n + 1; n < next; n++) {
      if (text(n).trim() === "") continue;
      if (removed.has(n)) gone++; else kept++;
    }
    if (kept || !gone) continue;
    let childrenGone = true;
    for (let j = i + 1; j < doc.headings.length && doc.headings[j].level > h.level; j++) {
      if (!dropped.has(j)) { childrenGone = false; break; }
    }
    if (childrenGone) { removed.add(h.n); dropped.add(i); }
  }
}

/** Work out the lean files and the proposed skills. Writes nothing. */
export function planFix(ctx, alwaysBefore) {
  const { d, ops } = ctx;
  const taken = new Set(listDir(path.join(d.project, ".claude", "skills")).map((e) => e.name));
  const keep = [...ops.filter((o) => !o.dupOf), ...repeatOps(ops, (f) => d.files.indexOf(f))];

  const files = [];
  const skills = [];
  for (const file of d.files) {
    const mine = keep.filter((o) => o.file === file);
    if (!mine.length) continue;
    const removed = new Set();
    const replacements = new Map();
    const edits = [];

    for (const op of mine.filter((o) => o.type === "section").sort((a, b) => a.start - b.start)) {
      const base = slugify(op.section.title) || "procedure";
      let slug = base;
      for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
      taken.add(slug);
      const p = proposeSkill(file.doc, op.section, slug);
      let end = op.end; // leave the blank lines after the section where they are
      while (end > op.start && file.doc.lines[end - 1].text.trim() === "") end--;
      replacements.set(op.start, [p.pointer]);
      for (let n = op.start + 1; n <= end; n++) removed.add(n);
      edits.push({ type: "section", start: op.start, end, reasons: ["move-to-skill"], skill: slug });
      skills.push({ ...p, from: file.display, line: op.start });
    }
    const sections = edits.map((e) => [e.start, e.end]);
    for (const op of mine.filter((o) => o.type === "remove")) {
      if (sections.some(([s, e]) => op.start >= s && op.end <= e)) continue; // inside a section that moves out
      for (let n = op.start; n <= op.end; n++) removed.add(n);
      edits.push({ type: "remove", start: op.start, end: op.end, reasons: op.reasons });
    }
    tidy(file, removed, replacements);

    const lean = compose(file, removed, replacements);
    files.push({ file, lean, before: file.tokens, after: estimateTokens(lean), changed: lean !== file.text, edits: edits.sort((a, b) => a.start - b.start), removedLines: removed.size });
  }

  const memorySaved = files.reduce((n, f) => n + (f.before - f.after), 0);
  const added = skills.reduce((n, s) => n + listingTokens(s.slug, s.description), 0);
  const after = alwaysBefore - memorySaved + added;
  return {
    files,
    skills,
    before: alwaysBefore,
    after,
    saved: alwaysBefore - after,
    percent: alwaysBefore ? Math.round(((alwaysBefore - after) / alwaysBefore) * 100) : 0,
    skillTokens: added,
  };
}

/**
 * Write the plan. Without `write`: CLAUDE.md.lean beside each original and the skills under
 * .claude-md-doctor/proposed-skills/. With `write`: back each original up as
 * <name>.bak-md-doctor-<timestamp>, write the lean file in place, and put the skills in
 * .claude/skills/ (never into a folder that already exists).
 */
export function applyFix(model, { write = false, now = new Date() } = {}) {
  const { plan, project } = model;
  const result = { mode: write ? "write" : "proposal", files: [], backups: [], skills: [], nothing: false };
  const changed = plan.files.filter((f) => f.changed);
  if (!changed.length) { result.nothing = true; return result; }

  const skillDir = (s) => (write ? path.join(project, ".claude", "skills", s.slug) : path.join(project, ".claude-md-doctor", "proposed-skills", s.slug));
  if (write) {
    for (const s of plan.skills) {
      if (exists(skillDir(s))) throw new Error(`${path.join(".claude", "skills", s.slug)} already exists; nothing was changed`);
    }
  }

  // Skills first: if one of them cannot be written, the memory file still holds the section.
  for (const s of plan.skills) {
    const file = path.join(skillDir(s), "SKILL.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, s.skillText);
    result.skills.push(file);
  }
  const stamp = timestamp(now);
  for (const f of changed) {
    const abs = f.file.abs;
    const style = { bom: f.file.bom, eol: f.file.eol };
    if (write) {
      const backup = uniquePath(`${abs}.bak-md-doctor-${stamp}`);
      fs.copyFileSync(abs, backup);
      result.backups.push(backup);
      writeFileText(abs, f.lean, style);
      result.files.push(abs);
    } else {
      writeFileText(`${abs}.lean`, f.lean, style);
      result.files.push(`${abs}.lean`);
    }
  }
  return result;
}
