// Shared test helpers. Nothing here, and nothing in the tests, touches the real Claude config:
// the moment this file loads, every way the tool can find a config or home folder is pointed at
// a throwaway folder, and every project the tests build lives under the OS temp folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const made = [];
const cleanup = () => {
  for (const dir of made) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the OS cleans the temp folder eventually */ }
  }
};
process.on("exit", cleanup);

/** A fresh temp folder (real path, short name). */
export function tmp(prefix = "cmd-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
}

// The safety net: this process's own idea of "home" and "the Claude config" is a temp folder.
const SAFE = tmp("cmd-safe-");
fs.mkdirSync(path.join(SAFE, ".claude"));
fs.writeFileSync(path.join(SAFE, "gitconfig"), "");
Object.assign(process.env, {
  HOME: SAFE,
  USERPROFILE: SAFE,
  CLAUDE_CONFIG_DIR: path.join(SAFE, ".claude"),
  GIT_CONFIG_GLOBAL: path.join(SAFE, "gitconfig"), // no machine-wide ignore rules, hooks or identity
  GIT_CONFIG_NOSYSTEM: "1",
  NO_COLOR: "1",
});
delete process.env.CLAUDE_PROJECT_DIR;
delete process.env.CLAUDE_MD_DOCTOR_CEILING;

// Imported after the net is in place.
const { analyze } = await import("../src/analyze.mjs");

export const BIN = fileURLToPath(new URL("../bin/claude-md-doctor.mjs", import.meta.url));
export const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * A sandbox: base/proj (the project), base/cfg (Claude's config folder), base/home, with `base`
 * as the highest folder searched for parent CLAUDE.md files, so nothing outside is ever read.
 * `files` are written into the project; use s.cfgFile / s.homeFile / s.baseFile for the others.
 */
export function sandbox(files = {}) {
  const base = tmp();
  const s = {
    base,
    dir: path.join(base, "proj"),
    cfg: path.join(base, "cfg"),
    home: path.join(base, "home"),
  };
  for (const d of [s.dir, s.cfg, s.home]) fs.mkdirSync(d, { recursive: true });
  const put = (root) => (rel, text = "") => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  s.file = put(s.dir);
  s.cfgFile = put(s.cfg);
  s.homeFile = put(s.home);
  s.baseFile = put(s.base);
  s.read = (rel) => fs.readFileSync(path.join(s.dir, rel), "utf8");
  s.has = (rel) => fs.existsSync(path.join(s.dir, rel));
  s.analyze = (opts = {}) => analyze({ dir: s.dir, configDir: s.cfg, home: s.home, ceiling: s.base, git: false, ...opts });
  s.cli = (args, env = {}, opts = {}) => runCli(args, { cwd: s.dir, env: { ...s.env(), ...env }, ...opts });
  s.env = () => ({ HOME: s.home, USERPROFILE: s.home, CLAUDE_CONFIG_DIR: s.cfg, CLAUDE_MD_DOCTOR_CEILING: s.base });
  for (const [rel, text] of Object.entries(files)) s.file(rel, text);
  return s;
}

/** Run the CLI as a separate process. */
export function runCli(args, { cwd, env = {}, input } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd, input, encoding: "utf8", windowsHide: true, timeout: 60000,
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

/** Findings of one kind. */
export const of = (model, id) => model.findings.filter((f) => f.id === id);
/** Sorted list of the distinct finding ids. */
export const idsOf = (model) => [...new Set(model.findings.map((f) => f.id))].sort();
/** The lines of a finding list as "id:line", handy for exact comparisons. */
export const where = (list) => list.map((f) => `${f.id}:${f.line}`);

/** A text of `n` lines, each a distinct sentence of about `words` words, for making files of a known weight. */
export function filler(n, words = 12, tag = "item") {
  return Array.from({ length: n }, (_, i) => `- ${tag} ${i} ${Array.from({ length: words }, (_, j) => `w${(i * 7 + j * 13) % 97}x`).join(" ")}`).join("\n");
}

/** git, isolated from the machine's config, for the tests that need a repository. */
export function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd, encoding: "utf8", windowsHide: true, env: { ...process.env },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stdout}${r.stderr}`);
  return r.stdout;
}

export const hasGit = (() => {
  try { return spawnSync("git", ["--version"], { windowsHide: true }).status === 0; } catch { return false; }
})();
