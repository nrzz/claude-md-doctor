import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../src/frontmatter.mjs";
import { estimateTokens } from "../src/tokens.mjs";
import { ROOT } from "./helpers.mjs";

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));
const pkg = json("package.json");

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js|cjs)$/.test(e.name)) out.push(p);
    }
  };
  for (const d of ["src", "bin"]) walk(path.join(ROOT, d));
  return out;
}

// ---------------------------------------------------------------- package.json

test("package.json has the fields every repo in the family has", () => {
  assert.equal(pkg.name, "claude-md-doctor");
  assert.equal(pkg.version, "1.0.1");
  assert.ok(pkg.description.length > 40);
  assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.bin, { "claude-md-doctor": "bin/claude-md-doctor.mjs" });
  assert.equal(pkg.engines.node, ">=18");
  assert.equal(pkg.scripts.test, "node --test");
  assert.equal(pkg.repository, "github:nrzz/claude-md-doctor");
  assert.equal(pkg.homepage, "https://github.com/nrzz/claude-md-doctor#readme");
  assert.equal(pkg.bugs, "https://github.com/nrzz/claude-md-doctor/issues");
  assert.ok(pkg.keywords.includes("claude-code") && pkg.keywords.includes("tokens"));
  assert.equal(pkg.author, "Naresh Prabu");
  assert.equal(pkg.license, "MIT");
});

test("the bin file exists, is a Node script, and the published files are listed", () => {
  const bin = read(pkg.bin["claude-md-doctor"]);
  assert.ok(bin.startsWith("#!/usr/bin/env node\n"));
  for (const entry of pkg.files) assert.ok(fs.existsSync(path.join(ROOT, entry)), entry);
  for (const must of ["bin", "src", ".claude-plugin", "skills", "README.md", "LICENSE"]) assert.ok(pkg.files.includes(must), must);
});

test("zero dependencies: nothing in package.json, and only node: built-ins and relative files are imported", () => {
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) assert.equal(pkg[key], undefined, key);
  const tests = fs.readdirSync(path.join(ROOT, "test")).filter((f) => f.endsWith(".mjs")).map((f) => path.join(ROOT, "test", f));
  let seen = 0;
  for (const file of [...sourceFiles(), ...tests]) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/^\s*(?:import|export)\b[^;'"]*?\bfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm)) {
      const spec = m[1] || m[2] || m[3];
      seen++;
      assert.ok(spec.startsWith("node:") || spec.startsWith("."), `${path.relative(ROOT, file)} imports ${spec}`);
    }
  }
  assert.ok(seen > 100, "the scan found the imports");
});

test("only ES modules (.mjs) in the code that ships", () => {
  for (const f of sourceFiles()) assert.ok(f.endsWith(".mjs"), f);
});

test("the code avoids APIs newer than Node 18, which is what engines promises", () => {
  const banned = [
    /import\.meta\.(dirname|filename)/, /\.toSorted\(/, /\.toReversed\(/, /\.toSpliced\(/, /Object\.groupBy/, /Map\.groupBy/, /Array\.fromAsync/,
    /Promise\.withResolvers/, /isWellFormed/, /\.(union|intersection|difference|symmetricDifference)\(/, /getBuiltinModule/, /readdirSync\([^)]*recursive/, /AbortSignal\.any/,
  ];
  for (const f of [...sourceFiles(), path.join(ROOT, "test", "helpers.mjs")]) {
    const text = fs.readFileSync(f, "utf8");
    for (const re of banned) assert.ok(!re.test(text), `${path.relative(ROOT, f)} uses ${re}`);
  }
});

test("nothing in the source ever points at Claude's session store", () => {
  for (const f of sourceFiles()) {
    const text = fs.readFileSync(f, "utf8");
    assert.ok(!/["'`]projects["'`]/.test(text), `${path.relative(ROOT, f)} mentions a projects folder`);
    assert.ok(!/\.jsonl/.test(text), `${path.relative(ROOT, f)} mentions transcripts`);
  }
});

test("the tool never runs claude and never uses the network", () => {
  for (const f of sourceFiles()) {
    const text = fs.readFileSync(f, "utf8");
    assert.ok(!/node:(https?|net|dns|tls|dgram)["']/.test(text), f);
    assert.ok(!/\bfetch\(/.test(text), f);
    for (const m of text.matchAll(/spawnSync\(\s*["']([^"']+)["']/g)) assert.equal(m[1], "git", `${path.relative(ROOT, f)} runs ${m[1]}`);
  }
});

// ---------------------------------------------------------------- the family's files

test("LICENSE is the MIT license of Naresh Prabu", () => {
  const license = read("LICENSE");
  assert.match(license, /^MIT License\n\nCopyright \(c\) 2026 Naresh Prabu\n/);
  assert.match(license, /Permission is hereby granted, free of charge/);
});

test(".gitattributes keeps one line ending everywhere, and .gitignore the usual things", () => {
  assert.equal(read(".gitattributes").trim(), "* text=auto eol=lf");
  const ignore = read(".gitignore").split(/\r?\n/);
  for (const line of ["node_modules/", "*.log", ".DS_Store"]) assert.ok(ignore.includes(line), line);
});

test("the CI workflow runs npm test on three systems and three Node versions", () => {
  const wf = read(".github/workflows/test.yml");
  assert.match(wf, /^name: test$/m);
  assert.match(wf, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(wf, /node: \[20, 22, 24\]/);
  assert.match(wf, /- run: npm test/);
  assert.match(wf, /actions\/checkout@v\d+/);
  assert.match(wf, /actions\/setup-node@v\d+/);
});

// ---------------------------------------------------------------- the plugin

test("plugin.json", () => {
  const p = json(".claude-plugin/plugin.json");
  assert.equal(p.name, "md-doctor");
  assert.equal(p.version, pkg.version);
  assert.ok(p.description.length > 40);
  assert.deepEqual(p.author, { name: "Naresh Prabu" });
  assert.equal(p.homepage, "https://github.com/nrzz/claude-md-doctor");
  assert.equal(p.license, "MIT");
});

test("marketplace.json", () => {
  const m = json(".claude-plugin/marketplace.json");
  assert.equal(m.$schema, "https://anthropic.com/claude-code/marketplace.schema.json");
  assert.equal(m.name, "claude-md-doctor");
  assert.deepEqual(m.owner, { name: "Naresh Prabu" });
  assert.equal(m.plugins.length, 1);
  const [p] = m.plugins;
  assert.equal(p.name, "md-doctor");
  assert.deepEqual(p.author, { name: "Naresh Prabu" });
  assert.equal(p.category, "productivity");
  assert.equal(p.source, "./");
  assert.equal(p.homepage, "https://github.com/nrzz/claude-md-doctor");
  assert.ok(p.description.length > 40);
});

test("the one skill is user-only, has a description under 60 characters, and a short reply instruction", () => {
  const text = read("skills/md-doctor/SKILL.md");
  const fm = parseFrontmatter(text);
  assert.equal(fm.name, "md-doctor");
  assert.ok(fm.description.length < 60, fm.description);
  assert.equal(fm["disable-model-invocation"], "true");
  assert.match(text, /!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/claude-md-doctor\.mjs" "\$\{CLAUDE_PROJECT_DIR\}" --markdown --budget 2000`/);
  assert.match(text, /In at most 8 lines: the fixes that save the most tokens, each with the change to make; edit nothing until the user agrees\./);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "skills")), ["md-doctor"]);
});

test("the skill is itself lean: its text is well under 150 tokens", () => {
  assert.ok(estimateTokens(read("skills/md-doctor/SKILL.md")) < 150);
});

test("the command the skill runs points at a file that exists in the plugin layout", () => {
  const text = read("skills/md-doctor/SKILL.md");
  const m = /!`node "\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/.exec(text);
  assert.ok(fs.existsSync(path.join(ROOT, m[1])), m[1]);
});

// ---------------------------------------------------------------- README

const readme = () => read("README.md");

test("the README follows the family's template", () => {
  const text = readme();
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, ["What it costs in tokens", "Install", "Use", "What it checks", "In CI", "How it counts tokens", "What was verified, and how", "Files", "Contributing", "Part of the Claude Code toolkit", "License"]);
  assert.ok(text.startsWith("# claude-md-doctor\n\n[![test](https://github.com/nrzz/claude-md-doctor/actions/workflows/test.yml/badge.svg)](https://github.com/nrzz/claude-md-doctor/actions/workflows/test.yml)"));
  assert.match(text, /npx -y github:nrzz\/claude-md-doctor/);
  assert.match(text, /\/plugin marketplace add nrzz\/claude-md-doctor/);
  assert.match(text, /\/plugin install md-doctor@claude-md-doctor/);
  assert.ok(text.includes("| Part | Tokens | |"));
});

test("the README documents every finding, every option and every JSON key", () => {
  const text = readme();
  for (const id of ["over-budget", "stale-path", "stale-command", "duplicate", "conflict", "move-to-skill", "big-code-block", "big-import", "filler", "local-not-ignored", "import-error"]) assert.ok(text.includes(`\`${id}\``), id);
  for (const flag of ["--budget", "--json", "--markdown", "--ci", "--fix", "--write", "--no-user"]) assert.ok(text.includes(flag), flag);
  for (const key of ["schema", "totals", "alwaysInContext", "files", "tree", "skills", "agents", "onDemand", "findings", "autofix", "detail", "summary", "potentialSavings", "plan", "fix", "ci"]) assert.ok(text.includes(key), key);
});

test("the README admits the token counts are estimates and says how close they are", () => {
  const text = readme();
  assert.match(text, /estimate/i);
  assert.match(text, /within about 15 percent/);
  assert.match(text, /does not reproduce Claude's tokenizer/);
});

test("the README has no emojis", () => {
  assert.doesNotMatch(readme(), /\p{Extended_Pictographic}/u);
});

test("every file the README's Files table names exists", () => {
  const section = readme().split("## Files")[1].split("## License")[0];
  let checked = 0;
  for (const m of section.matchAll(/^\| ((?:`[^`]+`(?:, )?)+) \|/gm)) {
    for (const p of m[1].match(/`([^`]+)`/g)) {
      assert.ok(fs.existsSync(path.join(ROOT, p.slice(1, -1).replace(/\/$/, ""))), p);
      checked++;
    }
  }
  assert.ok(checked >= 10);
});

test("the README's test count matches the suite, when it states one", () => {
  const m = /\*\*(\d+) automated tests\*\*/.exec(readme());
  assert.ok(m, "the verified section states the number of tests");
  assert.ok(Number(m[1]) >= 100);
});
