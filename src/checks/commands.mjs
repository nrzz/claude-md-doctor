// Commands in memory files that name something that is not there:
//   npm run x, npm test, pnpm x, pnpm run x, yarn x, yarn run x, bun run x   a package.json script
//   make x                                                                   a Makefile target
//   just x                                                                   a justfile recipe
//   dotnet test <path>  (also build, publish, restore, pack, clean, run --project)   a missing path
//
// The checks lean towards silence. A command is judged only when its script, target or path can
// be read from the project, and it is skipped when something else could explain it: workspace
// flags, a `cd` into a folder we cannot see, tools that are installed binaries, included
// Makefiles, placeholders such as <script>.
import path from "node:path";
import { exists, isDir, isFile } from "../fsutil.mjs";
import { closest } from "../text.mjs";
import { hasLocalBin, readJustfile, readMakefile } from "./projectindex.mjs";

const unique = (a) => [...new Set(a)];
const unquote = (s) => s.replace(/^["'`]+|["'`]+$/g, "");

// Subcommands that are the package manager's own, not scripts.
const YARN_BUILTINS = new Set(("add audit autoclean bin cache check config constraints create dedupe dlx exec explain generate-lock-entry global help import info init install " +
  "licenses link list login logout node npm outdated owner pack patch patch-commit plugin policies publish rebuild remove run search set self-update tag team unlink unplug " +
  "up upgrade upgrade-interactive version versions why workspace workspaces").split(" "));
const PNPM_BUILTINS = new Set(("add audit bin config create deploy dedupe dlx doctor env exec fetch import init install install-test i it link ln list ls licenses outdated pack " +
  "patch patch-commit patch-remove prune publish rebuild rb remove rm root run self-update server setup store unlink update up upgrade why approve-builds catalog").split(" "));
// Scripts that npm, pnpm and yarn run by name even though they are spelled like commands.
const SCRIPT_ALIASES = { t: "test", tst: "test", test: "test", start: "start", stop: "stop", restart: "restart" };

// Tools people run through yarn, pnpm or bun that are installed binaries, not scripts.
const COMMON_BINS = new Set(("tsc eslint prettier jest vitest mocha tsx ts-node next nuxt vite webpack rollup turbo nx playwright cypress prisma drizzle-kit biome oxlint tsup esbuild " +
  "changeset lerna husky lint-staged storybook astro remix expo nodemon concurrently rimraf cross-env npm-run-all serve wrangler vercel netlify supabase sst cdk eslint_d stylelint " +
  "tailwindcss postcss svelte-kit vue-tsc ng nest knip depcheck madge size-limit").split(" "));

const WORKSPACE_FLAGS = /^(-w|--workspace(=.*)?|--workspaces|-ws|--prefix(=.*)?|-C|--dir(=.*)?|--filter(=.*)?|-F|-r|--recursive|--cwd(=.*)?|--parallel|--if-present)$/;
const PLACEHOLDER_NAME = /^(x|foo|bar|xxx|name|script|command|cmd|task|target|your-script|my-script)$/i;
const NOT_A_NAME = /[<>$*{}[\]%]|\.\.\.|^-/;

const FILE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|sh|ps1|go|rs|json|md)$/i;

const stale = (message, fix, extra = {}) => ({ status: "stale", message, fix, ...extra });
const valid = () => ({ status: "valid" });

function listNames(names, max = 6) {
  const all = [...names].sort();
  return all.length > max ? `${all.slice(0, max).join(", ")}, ...` : all.join(", ");
}

// ---- package managers ----

// { pm, script } for a command that runs a package.json script, or null.
function scriptOf(tokens) {
  const pm = tokens[0];
  const rest = tokens.slice(1);
  if (rest.some((t) => WORKSPACE_FLAGS.test(t))) return null; // the script lives in another package
  const firstArg = rest.findIndex((t) => !t.startsWith("-"));
  if (firstArg === -1) return null;
  const sub = rest[firstArg];
  const after = rest.slice(firstArg + 1).find((t) => !t.startsWith("-"));
  const runs = sub === "run" || sub === "run-script";
  if (pm === "npm") {
    if (runs || sub === "rum" || sub === "urn") return after ? { pm, script: after } : null;
    return SCRIPT_ALIASES[sub] ? { pm, script: SCRIPT_ALIASES[sub] } : null;
  }
  if (pm === "bun") return runs && after ? { pm, script: after } : null;
  if (runs) return after ? { pm, script: after } : null;
  if (SCRIPT_ALIASES[sub]) return { pm, script: SCRIPT_ALIASES[sub] };
  const builtins = pm === "yarn" ? YARN_BUILTINS : PNPM_BUILTINS;
  return builtins.has(sub) ? null : { pm, script: sub };
}

function judgeScript({ pm, script }, shown, env, state) {
  if (PLACEHOLDER_NAME.test(script) || NOT_A_NAME.test(script)) return null;
  if (pm === "bun" && (script.includes("/") || script.includes("\\") || FILE_EXT.test(script))) return null; // bun run file.ts
  const dirs = state.cwdAbs ? [state.cwdAbs] : unique([env.project, env.fileDir]);
  const manifests = dirs.map((dir) => ({ dir, pkg: env.index.pkg(dir) })).filter((m) => m.pkg);

  if (!manifests.length && !env.index.hasAnyManifest()) return null; // no package.json at all: nothing to compare with
  if (dirs.some((d) => isFile(path.join(d, "package.json")) && !env.index.pkg(d))) return null; // one we cannot read
  const here = new Set(manifests.flatMap((m) => [...m.pkg.scripts]));
  if (here.has(script) || env.index.allScripts().has(script)) return valid(); // monorepos: another package may define it
  if (pm === "npm" && script === "start" && dirs.some((d) => exists(path.join(d, "server.js")))) return valid();
  if (pm !== "npm") { // yarn, pnpm and bun fall back to installed tools
    if (COMMON_BINS.has(script) || dirs.some((d) => hasLocalBin(d, script)) || manifests.some((m) => m.pkg.deps.has(script))) return null;
  }
  const all = env.index.allScripts();
  const near = closest(script, [...here, ...all]);
  const have = here.size ? `it has: ${listNames(here)}` : "it has no scripts";
  return stale(
    `\`${shown}\`: package.json has no "${script}" script (${have})`,
    near ? `Use \`${pm} run ${near}\` if that is what was meant, or remove the line.` : `Add a "${script}" script to package.json, or remove the line.`,
    { kind: "script", name: script, suggestion: near },
  );
}

// ---- make and just ----

function makeCommand(tokens, shown, env, state) {
  const args = tokens.slice(1);
  if (args.some((a) => /^(-C|-f|--directory(=.*)?|--file(=.*)?|--makefile(=.*)?)$/.test(a) || /^-[Cf]./.test(a))) return null;
  const targets = args.filter((a) => !a.startsWith("-") && !a.includes("=") && !NOT_A_NAME.test(a) && !PLACEHOLDER_NAME.test(a));
  if (!targets.length) return null;
  const dirs = state.cwdAbs ? [state.cwdAbs] : unique([env.project, env.fileDir]);
  let found = null;
  for (const dir of dirs) {
    const mk = readMakefile(dir);
    if (mk) { found = { dir, mk }; break; }
  }
  if (!found) {
    if (env.index.scan().makefiles.length) return null; // a Makefile exists elsewhere in the project
    return stale(`\`${shown}\`: there is no Makefile`, "Remove the line, or add the Makefile it relies on.", { kind: "make", name: targets[0] });
  }
  for (const t of targets) {
    if (found.mk.targets.has(t)) continue;
    if (found.mk.opaque) return null; // an included file or a pattern rule may define it
    if (exists(path.join(found.dir, t)) || [".c", ".cc", ".cpp"].some((x) => exists(path.join(found.dir, t + x)))) continue; // implicit rule
    const near = closest(t, found.mk.targets);
    return stale(
      `\`${shown}\`: the Makefile has no "${t}" target`,
      near ? `Use \`make ${near}\` if that is what was meant, or remove the line.` : "Add the target to the Makefile, or remove the line.",
      { kind: "make", name: t, suggestion: near },
    );
  }
  return valid();
}

function justfileFor(dirs) {
  for (const start of dirs) { // just looks in the folder and every folder above it
    for (let dir = start; ; dir = path.dirname(dir)) {
      const jf = readJustfile(dir);
      if (jf) return jf;
      if (path.dirname(dir) === dir) break;
    }
  }
  return null;
}

function justCommand(tokens, shown, env, state) {
  const args = tokens.slice(1);
  if (args.some((a) => a.startsWith("-"))) return null;
  const recipe = args.find((a) => !a.includes("=") && !NOT_A_NAME.test(a) && !PLACEHOLDER_NAME.test(a));
  if (!recipe || recipe.includes("::") || recipe.includes("/")) return null;
  const dirs = state.cwdAbs ? [state.cwdAbs] : unique([env.project, env.fileDir]);
  const jf = justfileFor(dirs);
  if (!jf) {
    if (env.index.scan().justfiles.length) return null;
    return stale(`\`${shown}\`: there is no justfile`, "Remove the line, or add the justfile it relies on.", { kind: "just", name: recipe });
  }
  if (jf.recipes.has(recipe)) return valid();
  if (jf.opaque) return null;
  const near = closest(recipe, jf.recipes);
  return stale(
    `\`${shown}\`: the justfile has no "${recipe}" recipe`,
    near ? `Use \`just ${near}\` if that is what was meant, or remove the line.` : "Add the recipe to the justfile, or remove the line.",
    { kind: "just", name: recipe, suggestion: near },
  );
}

// ---- dotnet ----

const DOTNET_VERBS = new Set(["test", "build", "publish", "restore", "pack", "clean", "run"]);

function dotnetCommand(tokens, shown, env, state) {
  const verb = tokens[1];
  if (!DOTNET_VERBS.has(verb)) return null;
  const rest = tokens.slice(2);
  let target = null;
  if (verb === "run") {
    const i = rest.findIndex((t) => t === "--project" || t === "-p");
    if (i >= 0) target = rest[i + 1];
    else target = (rest.find((t) => t.startsWith("--project=")) || "").slice("--project=".length) || null;
  } else if (rest[0] && !rest[0].startsWith("-")) {
    target = rest[0];
  }
  if (!target) return null;
  target = unquote(target);
  if (NOT_A_NAME.test(target) || PLACEHOLDER_NAME.test(target)) return null;
  const rel = target.replace(/\\/g, "/");
  const bases = state.cwdAbs ? [state.cwdAbs] : unique([env.project, env.fileDir]);
  if (bases.some((b) => exists(path.resolve(b, rel)))) return valid();
  return stale(`\`${shown}\`: ${rel} does not exist`, `Point it at the real project or solution file, or remove the line.`, { kind: "dotnet", name: rel });
}

// ---- entry points ----

/**
 * The commands in one piece of text (a code span or a line of a shell block). `state.cwdAbs`
 * follows `cd` across the lines of one block. Returns refs: { text, status: "valid" | "stale", message, fix }.
 */
export function commandRefs(text, env, state = {}) {
  const out = [];
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("#")) return out;
  const chunks = trimmed.replace(/\s#\s.*$/, "").split(/\s*(?:&&|\|\||;|\|)\s*/).map((s) => s.trim()).filter(Boolean);
  for (const chunk of chunks) {
    // a prompt, then any mix of VAR=value and sudo, time, env in front of the command itself
    let c = chunk.replace(/^(?:\$|>|%|PS[^>\s]*>)\s+/, "");
    for (let before = ""; before !== c;) {
      before = c;
      c = c.replace(/^(?:sudo|time|exec|command|env|nohup)\s+/, "").replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
    }
    const tokens = c.split(/\s+/).map(unquote).filter(Boolean);
    if (!tokens.length) continue;

    if (tokens[0] === "cd") {
      const target = tokens[1];
      if (!target || /^[-~$%]/.test(target) || /[<>*?]/.test(target)) { state.cwdAbs = null; state.cwdUnknown = true; continue; }
      const abs = path.resolve(state.cwdAbs || env.project, target.replace(/\\/g, "/"));
      if (isDir(abs)) { state.cwdAbs = abs; state.cwdUnknown = false; } else { state.cwdAbs = null; state.cwdUnknown = true; }
      continue;
    }
    if (state.cwdUnknown) continue; // we do not know which folder this runs in

    const shown = tokens.slice(0, 4).join(" ").replace(/\s+--?$/, "");
    let result = null;
    if (["npm", "pnpm", "yarn", "bun"].includes(tokens[0])) {
      const s = scriptOf(tokens);
      if (s) result = judgeScript(s, shown, env, state);
    } else if (tokens[0] === "make") {
      result = makeCommand(tokens, shown, env, state);
    } else if (tokens[0] === "just") {
      result = justCommand(tokens, shown, env, state);
    } else if (tokens[0] === "dotnet") {
      result = dotnetCommand(tokens, shown, env, state);
    }
    if (result) out.push({ text: shown, ...result });
  }
  return out;
}

/** `npm run x` style commands in plain prose (outside backticks): only the explicit "run" forms. */
export function proseCommandRefs(text, env) {
  const out = [];
  const re = /\b(npm|pnpm|yarn|bun)\s+run(?:-script)?\s+([^\s`"')\],;]+)([^.\n]{0,40})/g;
  let m;
  while ((m = re.exec(text))) {
    if (/\s(-w|--workspaces?|--prefix|--filter|-C|--if-present)\b/.test(m[3])) continue;
    out.push(...commandRefs(`${m[1]} run ${m[2]}`, env));
  }
  return out;
}
