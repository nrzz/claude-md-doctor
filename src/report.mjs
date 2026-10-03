// The three ways to show a result: a text report for people (colored on a terminal), markdown
// for pull-request comments and the skill, and JSON for scripts.
import path from "node:path";
import { fmt } from "./tokens.mjs";
import { toPosix } from "./fsutil.mjs";
import { plural } from "./text.mjs";

const CODES = { bold: "1", dim: "2", red: "31", green: "32", yellow: "33", cyan: "36" };
const COLOR_OF = { error: "red", warn: "yellow", info: "cyan" };
const LABEL = { error: "ERROR", warn: "WARN", info: "NOTE" };
const KIND_TAG = { user: "user memory", parent: "parent folder", local: "personal, not for git", "project-claude": "" };
const NOTE_TEXT = {
  "already loaded": "already loaded above, counted once",
  cycle: "import cycle, not loaded again",
  missing: "missing",
  "too deep": "nested too deep, not loaded",
  unreadable: "not readable",
};

function painter(color) {
  const on = (name) => (s) => (color ? `\x1b[${CODES[name]}m${s}\x1b[0m` : String(s));
  return Object.fromEntries(Object.keys(CODES).map((k) => [k, on(k)]));
}

const num = (n, width = 7) => fmt(n).padStart(width);
const LIST_MAX = 8; // skills and agents named one by one in the text report

/** Greedy word wrap; continuation lines get `indent`. */
function wrap(text, width, indent) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) { lines.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i ? indent : "") + l);
}

function treeRows(model) {
  const rows = [];
  const walk = (node, depth) => {
    const f = node.file;
    const label = depth === 0 ? f.display : `@${node.ref}`;
    const tag = depth === 0 && KIND_TAG[f.kind] ? ` (${KIND_TAG[f.kind]})` : "";
    const note = node.note ? ` (${NOTE_TEXT[node.note] || node.note})` : "";
    rows.push({ tokens: node.note ? null : node.tokens, text: `${"  ".repeat(depth)}${label}${tag}${note}`, flagged: !!node.note && node.note !== "already loaded" });
    for (const c of node.children) {
      if (c.file || c.note) walk({ ...c, file: c.file || { display: c.ref, kind: "import" } }, depth + 1);
    }
  };
  for (const root of model.tree) walk(root, 0);
  return rows;
}

/** The plain-text report. Pass { color: true } for ANSI colors. */
export function renderText(model, { color = false, width = 100, fixed = false } = {}) {
  const c = painter(color);
  const out = [];
  const { totals, budget } = model;

  out.push(`${c.bold("claude-md-doctor")} ${model.version}${c.dim(`  token costs are estimates (see README)`)}`);
  out.push(c.dim(`project  ${toPosix(model.project)}`));
  out.push(c.dim(`config   ${toPosix(model.configDir)}${model.user ? "" : "  (user memory skipped: --no-user)"}`));
  out.push("");

  out.push(c.bold("Always loaded: memory files"));
  const rows = treeRows(model);
  if (!rows.length) out.push("  none found: no CLAUDE.md, .claude/CLAUDE.md or CLAUDE.local.md");
  else {
    out.push(c.dim("   tokens  file"));
    for (const r of rows) out.push(`  ${r.tokens === null ? "      -" : num(r.tokens)}  ${r.flagged ? c.red(r.text) : r.text}`);
    out.push(`  ${c.bold(num(totals.memory))}  ${c.bold("memory total")}`);
  }
  out.push("");

  const listed = model.skills.filter((s) => s.modelInvocable);
  const userOnly = model.skills.length - listed.length;
  out.push(c.bold("Always in context: skill and agent descriptions"));
  if (!model.skills.length && !model.agents.length) out.push("  none found in .claude/skills, .claude/agents or the user folders");
  else {
    // the biggest few of each, so it is clear which descriptions to shorten
    const biggest = (list, what) => {
      const sorted = [...list].sort((a, b) => b.tokens - a.tokens || (a.name < b.name ? -1 : 1));
      for (const x of sorted.slice(0, LIST_MAX)) out.push(c.dim(`  ${num(x.tokens)}    ${x.name}  (${x.scope} ${what})`));
      if (sorted.length > LIST_MAX) out.push(c.dim(`           ...and ${sorted.length - LIST_MAX} more`));
    };
    out.push(`  ${num(totals.skills)}  ${plural(listed.length, "skill")} the model can invoke${userOnly ? c.dim(`  (${plural(userOnly, "user-only skill")} cost nothing)`) : ""}`);
    biggest(listed, "skill");
    out.push(`  ${num(totals.agents)}  ${plural(model.agents.length, "agent")}`);
    biggest(model.agents, "agent");
  }
  out.push("");

  const over = totals.alwaysInContext - budget;
  const verdict = over > 0 ? c.red(`OVER by ${fmt(over)}`) : c.green(`within budget (${Math.round((totals.alwaysInContext / budget) * 100)}% used)`);
  out.push(`${c.bold("In context every session")}  ${c.bold(fmt(totals.alwaysInContext))} tokens   budget ${fmt(budget)}   ${verdict}`);
  out.push("");

  if (model.onDemand.length) {
    out.push(c.bold("Loaded on demand (read when Claude works in that folder; not counted above)"));
    for (const f of model.onDemand) out.push(`  ${num(f.tokens)}  ${f.display}`);
    if (model.onDemandTruncated) out.push(c.dim("  (the folder scan stopped early on a very large tree)"));
    out.push("");
  }
  for (const n of model.notes) out.push(c.dim(`note: ${n}`));
  if (model.notes.length) out.push("");

  const { findings, summary } = model;
  if (!findings.length) {
    out.push(c.green("No problems found."));
  } else {
    out.push(c.bold(`Findings: ${plural(summary.errors, "error")}, ${plural(summary.warnings, "warning")}, ${plural(summary.notes, "note")}`));
    out.push("");
    for (const f of findings) {
      const where = f.file ? `${f.file}${f.line ? `:${f.line}${f.endLine && f.endLine !== f.line ? `-${f.endLine}` : ""}` : ""}` : "";
      const saves = f.saves > 0 ? `  saves ~${fmt(f.saves)} tokens` : "";
      const auto = f.autofix ? "  [--fix]" : "";
      const extra = `${saves}${auto}`.trim();
      out.push(`${c[COLOR_OF[f.severity]](LABEL[f.severity].padEnd(5))} ${c.bold(f.id)}${" ".repeat(Math.max(0, 17 - f.id.length))} ${where}${extra ? `${where ? "  " : ""}${c.dim(extra)}` : ""}`.trimEnd());
      for (const line of wrap(f.message, width - 6, "")) out.push(`      ${line}`);
      for (const line of wrap(`fix: ${f.fix}`, width - 6, "     ")) out.push(c.dim(`      ${line}`));
      out.push("");
    }
  }

  if (summary.potentialSavings > 0) {
    const n = model.plan.files.filter((f) => f.changed).length;
    out.push(...wrap(`Automatic fixes would change ${plural(n, "file")} and take ${fmt(totals.alwaysInContext)} tokens down to about ${fmt(summary.leanTotal)} (saves ${fmt(summary.potentialSavings)}, ${model.plan.percent}%).${fixed ? "" : " `claude-md-doctor --fix` writes a proposal and leaves your files untouched."}`, width, ""));
  } else if (findings.length) {
    out.push("No finding can be fixed automatically; the fixes above are manual.");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** What --fix did, as text. */
export function renderFix(model, result, { color = false } = {}) {
  const c = painter(color);
  const rel = (p) => toPosix(path.relative(model.project, p));
  const { plan } = model;
  const out = [""];
  if (result.nothing) {
    out.push(c.green("Nothing to change: no memory file has a fix that can be applied automatically."));
    return out.join("\n") + "\n";
  }
  out.push(c.bold(result.mode === "write" ? "Applied to your files (every original backed up first)" : "Proposal written (your files are untouched)"));
  for (const f of plan.files.filter((x) => x.changed)) {
    const target = result.mode === "write" ? f.file.display : `${f.file.display}.lean`;
    out.push(`  ${target.padEnd(34)} ${fmt(f.before)} -> ${fmt(f.after)} tokens`);
  }
  for (const s of result.skills) out.push(`  ${rel(s)}  (new skill)`);
  for (const b of result.backups) out.push(c.dim(`  backup: ${rel(b)}`));
  out.push("");
  out.push(`In context every session: ${fmt(plan.before)} -> ${fmt(plan.after)} tokens (saves ${fmt(plan.saved)}, ${plan.percent}%)${plan.skillTokens ? c.dim(`, including ${fmt(plan.skillTokens)} for the new skill descriptions`) : ""}`);
  if (result.mode === "proposal") out.push(`Review the .lean files and proposed skills, then run \`claude-md-doctor --fix --write\` to apply them.`);
  return out.join("\n") + "\n";
}

// ---- markdown ----

const MD_MAX_FINDINGS = 25;
const md = (s) => String(s).replace(/\|/g, "\\|");

/** Markdown for a pull-request comment or the /md-doctor skill: compact, findings capped at 25. */
export function renderMarkdown(model, { maxFindings = MD_MAX_FINDINGS } = {}) {
  const { totals, budget, findings, summary } = model;
  const out = [];
  const over = totals.alwaysInContext - budget;
  out.push("## claude-md-doctor");
  out.push("");
  out.push(`**${fmt(totals.alwaysInContext)} tokens in context every session** (budget ${fmt(budget)}: ${over > 0 ? `**over by ${fmt(over)}**` : "within budget"}). Estimates, not Claude's own count.`);
  out.push("");
  out.push(`- Memory files: ${fmt(totals.memory)} tokens in ${plural(model.files.length, "file")}`);
  const listed = model.skills.filter((s) => s.modelInvocable).length;
  out.push(`- Skill and agent descriptions: ${fmt(totals.skills + totals.agents)} tokens (${plural(listed, "skill")}, ${plural(model.agents.length, "agent")})`);
  if (model.onDemand.length) out.push(`- Loaded on demand, not counted: ${plural(model.onDemand.length, "file")}, ${fmt(totals.onDemand)} tokens`);
  out.push("");

  const files = [...model.files].sort((a, b) => b.tokens - a.tokens);
  if (files.length) {
    out.push("| File | Tokens |");
    out.push("| --- | ---: |");
    for (const f of files.slice(0, 10)) out.push(`| \`${md(f.path)}\`${f.importedBy ? ` (imported by \`${md(f.importedBy)}\`)` : ""} | ${fmt(f.tokens)} |`);
    if (files.length > 10) out.push(`| ...and ${files.length - 10} more | |`);
    out.push("");
  }

  if (!findings.length) {
    out.push("No problems found.");
  } else {
    out.push(`### Findings: ${plural(summary.errors, "error")}, ${plural(summary.warnings, "warning")}, ${plural(summary.notes, "note")}`);
    out.push("");
    for (const f of findings.slice(0, maxFindings)) {
      const where = f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
      const saves = f.saves > 0 ? ` (saves ~${fmt(f.saves)})` : "";
      out.push(`- **${f.severity}** \`${f.id}\`${where}${saves}: ${f.message}. Fix: ${f.fix}`);
    }
    if (findings.length > maxFindings) out.push(`- ...and ${findings.length - maxFindings} more (run \`claude-md-doctor\` for the full list, or \`--json\`).`);
  }
  out.push("");
  if (summary.potentialSavings > 0) {
    out.push(`Automatic fixes: ${fmt(totals.alwaysInContext)} -> about ${fmt(summary.leanTotal)} tokens. \`claude-md-doctor --fix\` writes a proposal and leaves your files alone.`);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// ---- JSON ----

function jsonTree(node) {
  return {
    path: node.file ? node.file.display : null,
    ref: node.ref,
    tokens: node.tokens,
    note: node.note,
    children: node.children.map(jsonTree),
  };
}

/**
 * The stable JSON shape (schema 1). Fields are only ever added, never renamed or removed, within
 * schema 1. `fixResult` is what applyFix returned, or null when --fix was not used.
 */
export function toJson(model, { fixResult = null, ci = null } = {}) {
  const rel = (p) => toPosix(path.relative(model.project, p));
  return {
    schema: 1,
    tool: model.tool,
    version: model.version,
    project: toPosix(model.project),
    configDir: toPosix(model.configDir),
    budget: model.budget,
    totals: { ...model.totals, overBudget: model.summary.overBudget },
    files: model.files.map((f) => ({ ...f, abs: toPosix(f.abs) })),
    tree: model.tree.map(jsonTree),
    skills: model.skills.map((s) => ({ name: s.name, scope: s.scope, path: s.display, description: s.description, modelInvocable: s.modelInvocable, tokens: s.tokens })),
    agents: model.agents.map((a) => ({ name: a.name, scope: a.scope, path: a.display, description: a.description, tokens: a.tokens })),
    onDemand: model.onDemand.map((f) => ({ path: f.display, tokens: f.tokens, lines: f.lines })),
    findings: model.findings.map((f) => ({
      id: f.id, severity: f.severity, file: f.file, line: f.line, endLine: f.endLine,
      tokens: f.tokens, saves: f.saves, message: f.message, fix: f.fix, autofix: f.autofix, detail: f.detail,
    })),
    summary: { ...model.summary },
    plan: {
      before: model.plan.before,
      after: model.plan.after,
      saved: model.plan.saved,
      files: model.plan.files.filter((f) => f.changed).map((f) => ({ path: f.file.display, before: f.before, after: f.after, removedLines: f.removedLines })),
      skills: model.plan.skills.map((s) => ({ slug: s.slug, from: s.from, line: s.line, description: s.description, netTokens: s.net })),
    },
    fix: fixResult && {
      mode: fixResult.mode,
      nothing: fixResult.nothing,
      files: fixResult.files.map(rel),
      backups: fixResult.backups.map(rel),
      skills: fixResult.skills.map(rel),
    },
    ci,
  };
}
