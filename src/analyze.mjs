// Put it together: discover what loads, run every check, work out what --fix would do, and
// return one plain object the reports (text, markdown, JSON) are built from.
import os from "node:os";
import path from "node:path";
import { discover } from "./discover.mjs";
import { sortFindings, makeFinding } from "./findings.mjs";
import { planFix } from "./fix.mjs";
import { fmt } from "./tokens.mjs";
import { checkReferences } from "./checks/references.mjs";
import { checkDuplicates } from "./checks/duplicates.mjs";
import { checkConflicts } from "./checks/conflicts.mjs";
import { checkStructure } from "./checks/structure.mjs";
import { checkFiller } from "./checks/filler.mjs";
import { checkLocalIgnored } from "./checks/gitignore.mjs";
import { readFileSync } from "node:fs";

export const DEFAULT_BUDGET = 2000;

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** Claude Code's config folder: $CLAUDE_CONFIG_DIR, else ~/.claude. */
export function defaultConfigDir(env = process.env, home = os.homedir()) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, ".claude");
}

const sum = (list, key) => list.reduce((n, x) => n + x[key], 0);

function budgetFinding(model) {
  const { totals, budget, plan } = model;
  const over = totals.alwaysInContext - budget;
  const parts = [
    ...model.files.map((f) => ({ name: f.path, tokens: f.tokens })),
    ...(totals.skills ? [{ name: `${model.skills.filter((s) => s.modelInvocable).length} skill descriptions`, tokens: totals.skills }] : []),
    ...(totals.agents ? [{ name: `${model.agents.length} agent descriptions`, tokens: totals.agents }] : []),
  ].sort((a, b) => b.tokens - a.tokens).slice(0, 3);
  const biggest = parts.map((p) => `${p.name} ${fmt(p.tokens)}`).join("; ");
  const fixes = plan.saved > 0 ? `The fixes below can take out about ${fmt(plan.saved)} tokens, down to ${fmt(plan.after)}.` : "No automatic fix shrinks it; cut or move content by hand.";
  return makeFinding("over-budget", {
    tokens: totals.alwaysInContext,
    saves: 0,
    message: `${fmt(totals.alwaysInContext)} tokens are in context every session, ${fmt(over)} over the budget of ${fmt(budget)}`,
    fix: `Biggest: ${biggest}. ${fixes} Move procedures into skills, drop what Claude can read from the code, or raise --budget.`,
    detail: { budget, total: totals.alwaysInContext, over },
  });
}

/**
 * Analyze a project folder. Options: dir, configDir, home, user (include the user's memory,
 * skills and agents), budget, ceiling (highest folder searched for parent CLAUDE.md files),
 * git (run the git-ignore check).
 */
export function analyze({ dir = process.cwd(), configDir, home = os.homedir(), user = true, budget = DEFAULT_BUDGET, ceiling = null, git = true } = {}) {
  const d = discover({ dir, configDir: configDir || defaultConfigDir(process.env, home), home, user, ceiling });
  const ctx = { d, ops: [], findings: [...d.errors], git };
  checkReferences(ctx);
  checkDuplicates(ctx);
  checkConflicts(ctx);
  checkStructure(ctx);
  checkFiller(ctx);
  if (git) checkLocalIgnored(ctx);

  const totals = {
    memory: sum(d.files, "tokens"),
    skills: sum(d.skills, "tokens"),
    agents: sum(d.agents, "tokens"),
    onDemand: sum(d.onDemand, "tokens"),
  };
  totals.alwaysInContext = totals.memory + totals.skills + totals.agents;

  const plan = planFix(ctx, totals.alwaysInContext);
  const model = {
    tool: "claude-md-doctor",
    version: VERSION,
    project: d.project,
    configDir: d.configDir,
    home: d.home,
    user: d.user,
    budget,
    files: d.files.map((f) => ({
      path: f.display, abs: f.abs, kind: f.kind, tokens: f.tokens, lines: f.lines, depth: f.depth,
      importedBy: f.importedBy, importLine: f.importLine, ref: f.ref, rewritable: f.rewritable,
    })),
    tree: d.tree,
    skills: d.skills,
    agents: d.agents,
    onDemand: d.onDemand,
    onDemandTruncated: d.onDemandTruncated,
    notes: d.notes,
    totals,
    plan,
    ops: ctx.ops,
  };

  if (totals.alwaysInContext > budget) ctx.findings.push(budgetFinding(model));
  model.findings = sortFindings(ctx.findings);
  model.summary = {
    errors: model.findings.filter((f) => f.severity === "error").length,
    warnings: model.findings.filter((f) => f.severity === "warn").length,
    notes: model.findings.filter((f) => f.severity === "info").length,
    overBudget: totals.alwaysInContext > budget,
    potentialSavings: plan.saved,
    leanTotal: plan.after,
  };
  return model;
}

/** True when --ci should fail: an error-severity finding, or the budget exceeded. */
export const ciFails = (model) => model.summary.errors > 0 || model.summary.overBudget;
