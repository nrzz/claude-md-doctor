// local-not-ignored: CLAUDE.local.md is meant to be personal. In a git repository it should be
// git-ignored, or it is one `git add .` away from being committed.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isFile } from "../fsutil.mjs";
import { makeFinding } from "../findings.mjs";

const NAME = "CLAUDE.local.md";

function git(cwd, args, timeout = 3000) {
  const r = spawnSync("git", args, {
    cwd, timeout, windowsHide: true, stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return r.error ? null : r.status; // null: git is missing or took too long
}

/**
 * Which of these absolute paths would git ignore? Paths a project's own .gitignore covers are
 * generated or local files (build output, .env, data folders): not having them in a fresh clone
 * is normal, so a reference to one is not stale. Returns a Set of the ignored paths; empty when
 * the folder is not a repository or git is missing or slow.
 */
export function ignoredPaths(project, absPaths, timeout = 3000) {
  const ignored = new Set();
  const asked = new Map(); // path as given to git -> absolute path
  for (const abs of absPaths) {
    const rel = path.relative(project, abs).split(path.sep).join("/");
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) asked.set(rel, abs);
  }
  if (!asked.size) return ignored;
  const r = spawnSync("git", ["check-ignore", "-z", "--stdin"], {
    cwd: project, timeout, windowsHide: true, encoding: "utf8", input: [...asked.keys()].join("\0") + "\0",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  if (r.error || r.status !== 0) return ignored;
  for (const rel of r.stdout.split("\0")) if (asked.has(rel)) ignored.add(asked.get(rel));
  return ignored;
}

/** "ignored", "not-ignored" or "unknown" (not a repository, git missing, or too slow). */
export function ignoreStatus(project) {
  const status = git(project, ["check-ignore", "-q", "--", NAME]);
  if (status === 0) return "ignored";
  if (status === 1) return "not-ignored";
  return "unknown";
}

export function checkLocalIgnored(ctx) {
  const { project } = ctx.d;
  if (!isFile(path.join(project, NAME))) return;
  if (ignoreStatus(project) !== "not-ignored") return;
  const tracked = git(project, ["ls-files", "--error-unmatch", "--", NAME]) === 0;
  ctx.findings.push(makeFinding("local-not-ignored", {
    file: NAME,
    message: tracked
      ? `${NAME} is committed to git, so it is shared with everyone who clones the repository`
      : `${NAME} is personal but is not git-ignored, so it can be committed by accident`,
    fix: tracked
      ? `Run \`git rm --cached ${NAME}\` and add "${NAME}" to .gitignore.`
      : `Add "${NAME}" to .gitignore (or to .git/info/exclude if only you have the file).`,
    detail: { tracked },
  }));
}
