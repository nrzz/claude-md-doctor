// The command line: parse the flags, run the analysis, print the report, return the exit code.
import os from "node:os";
import path from "node:path";
import { analyze, ciFails, defaultConfigDir, DEFAULT_BUDGET, VERSION } from "./analyze.mjs";
import { applyFix } from "./fix.mjs";
import { renderFix, renderMarkdown, renderText, toJson } from "./report.mjs";
import { isDir } from "./fsutil.mjs";

const HELP = `claude-md-doctor ${VERSION}: what your CLAUDE.md files cost in every Claude Code session, and how to slim them.

Usage: claude-md-doctor [dir] [options]

  dir            project folder to check (default: the current folder)
  --budget <n>   tokens allowed in context every session (default ${DEFAULT_BUDGET})
  --json         machine-readable report (the schema is in the README)
  --markdown     the report as markdown, for pull-request comments
  --ci           exit 1 when there is an error finding or the budget is exceeded
  --fix          write CLAUDE.md.lean and proposed skills; your files stay untouched
  --write        with --fix: apply them in place, backing every original up first
  --no-user      leave out the user-level CLAUDE.md, skills and agents
  -h, --help     show this text
  -v, --version  show the version

Environment: CLAUDE_CONFIG_DIR (Claude's config folder), NO_COLOR (no colors).
It only reads files, unless --fix is given; it never runs Claude or uses the network.
`;

class UsageError extends Error {}

/** Parse argv into { dir, budget, json, markdown, ci, fix, write, noUser, help, version }. */
export function parseArgs(argv) {
  const o = { dir: null, budget: DEFAULT_BUDGET, json: false, markdown: false, ci: false, fix: false, write: false, noUser: false, help: false, version: false };
  const budget = (v) => {
    if (!/^\d+$/.test(String(v ?? "")) || Number(v) < 1) throw new UsageError("--budget needs a whole number of tokens, such as --budget 1500");
    return Number(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--budget") o.budget = budget(argv[++i]);
    else if (a.startsWith("--budget=")) o.budget = budget(a.slice("--budget=".length));
    else if (a === "--json") o.json = true;
    else if (a === "--markdown") o.markdown = true;
    else if (a === "--ci") o.ci = true;
    else if (a === "--fix") o.fix = true;
    else if (a === "--write") o.write = true;
    else if (a === "--no-user") o.noUser = true;
    else if (a === "-h" || a === "--help") o.help = true;
    else if (a === "-v" || a === "--version") o.version = true;
    else if (a.startsWith("-") && a !== "-") throw new UsageError(`unknown option ${a}`);
    else if (o.dir !== null) throw new UsageError(`only one folder can be checked at a time (got "${o.dir}" and "${a}")`);
    else o.dir = a;
  }
  if (o.json && o.markdown) throw new UsageError("--json and --markdown cannot be combined");
  if (o.write && !o.fix) throw new UsageError("--write only works together with --fix");
  return o;
}

/**
 * Run the tool. `io` lets tests capture output: { stdout, stderr, env, cwd, home }.
 * Returns the exit code: 0, 1 (--ci failed) or 2 (bad usage or an error).
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;
  const home = io.home || os.homedir();
  const color = !!stdout.isTTY && !env.NO_COLOR;

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    stderr.write(`claude-md-doctor: ${e.message}\nTry: claude-md-doctor --help\n`);
    return 2;
  }
  if (opts.help) { stdout.write(HELP); return 0; }
  if (opts.version) { stdout.write(`${VERSION}\n`); return 0; }

  const dir = path.resolve(io.cwd || process.cwd(), opts.dir || ".");
  if (!isDir(dir)) {
    stderr.write(`claude-md-doctor: ${dir} is not a folder\n`);
    return 2;
  }

  try {
    const model = analyze({
      dir,
      configDir: defaultConfigDir(env, home),
      home,
      user: !opts.noUser,
      budget: opts.budget,
      ceiling: env.CLAUDE_MD_DOCTOR_CEILING || null,
    });
    const fails = ciFails(model);
    const fixResult = opts.fix ? applyFix(model, { write: opts.write }) : null;

    if (opts.json) {
      stdout.write(`${JSON.stringify(toJson(model, { fixResult, ci: { enabled: opts.ci, pass: !fails } }), null, 2)}\n`);
    } else {
      stdout.write(opts.markdown ? renderMarkdown(model) : renderText(model, { color, fixed: !!fixResult }));
      if (fixResult) stdout.write(renderFix(model, fixResult, { color }));
      if (opts.ci) {
        const errors = model.summary.errors - (model.summary.overBudget ? 1 : 0); // the budget finding is counted by itself
        const why = [errors > 0 ? `${errors} error finding${errors === 1 ? "" : "s"}` : "", model.summary.overBudget ? "over budget" : ""].filter(Boolean).join(", ");
        stdout.write(`\nCI: ${fails ? `failed (${why})` : "passed"}\n`);
      }
    }
    return opts.ci && fails ? 1 : 0;
  } catch (e) {
    stderr.write(`claude-md-doctor: ${e.message}\n`);
    return 2;
  }
}
