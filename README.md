# claude-md-doctor

[![test](https://github.com/nrzz/claude-md-doctor/actions/workflows/test.yml/badge.svg)](https://github.com/nrzz/claude-md-doctor/actions/workflows/test.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) ![node >= 18](https://img.shields.io/badge/node-%3E%3D18-339933.svg) ![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen.svg) [![part of the Claude Code toolkit](https://img.shields.io/badge/Claude%20Code-toolkit-d97757.svg)](https://github.com/nrzz/claude-code-toolkit)

claude-md-doctor measures what your `CLAUDE.md` files cost in every Claude Code session, finds the lines that are stale, duplicated or better placed in a skill, and can write a leaner version. It is a plain Node program that runs outside Claude, so checking your memory files costs no tokens.

## What it costs in tokens

| Part | Tokens | |
| --- | --- | --- |
| The tool: a terminal run, `--json`, `--markdown`, `--fix`, `--ci` | 0 | It reads files. It never calls Claude and never uses the network |
| The skill in Claude's skill list | 0 | `/md-doctor:md-doctor` is user-only (`disable-model-invocation: true`), which keeps it out of the list Claude Code gives the model. Its description is 37 characters |
| `/md-doctor:md-doctor` | the report, then one short reply | By this tool's own estimate, about 250 to 400 tokens for a project with a handful of findings. The report is capped at 25 findings, so it stays bounded, but with many long findings it can reach about 2,000 to 3,000 tokens. The reply is at most 8 lines. The free route is the same report in a terminal |
| Running it in CI | 0 | |

What it measures is the other side of this table: your memory files, their imports and your skill and agent descriptions are in context at the start of every session, so every token cut from them is saved on every session.

## Install

**As a Claude Code plugin.** In Claude Code:

```text
/plugin marketplace add nrzz/claude-md-doctor
/plugin install md-doctor@claude-md-doctor
```

Then type `/md-doctor:md-doctor`. It runs the report for the current project and answers in at most 8 lines: the fixes that save the most tokens, each with the change to make. It edits nothing until you agree.

**From a terminal**, with Node 18 or newer:

```bash
npx -y github:nrzz/claude-md-doctor
```

Run it in a project folder, or pass the folder: `npx -y github:nrzz/claude-md-doctor ~/work/shop`. There is nothing to install and no dependency.

## Use

```text
claude-md-doctor [dir] [--budget <tokens>] [--json] [--markdown] [--ci] [--fix] [--write] [--no-user]
```

| Option | What it does |
| --- | --- |
| `dir` | The project folder, which is also the working folder Claude would start in. Default: the current folder |
| `--budget <tokens>` | What may be in context every session. Default 2,000. Over it is an `over-budget` error |
| `--json` | One JSON document on stdout, schema below |
| `--markdown` | The report as markdown for a pull-request comment: compact, findings capped at 25 |
| `--ci` | Exit 1 when there is an error finding or the budget is exceeded, else 0 |
| `--fix` | Write a proposal: `CLAUDE.md.lean` next to each memory file and proposed skills under `.claude-md-doctor/proposed-skills/`. Your files stay untouched. Prints the before and after totals |
| `--write` | With `--fix`: apply the proposal in place. Every original is backed up first |
| `--no-user` | Leave out the user-level `CLAUDE.md`, skills and agents, so the result does not depend on whose machine runs it |

Exit codes: 0 for a normal run, 1 only for `--ci` when it fails, 2 for a usage error such as an unknown option or a folder that does not exist. The report is colored on a terminal and plain when piped or when `NO_COLOR` is set. `CLAUDE_CONFIG_DIR` moves the user folder, as it does for Claude Code.

A real run, with the paths shortened:

```text
$ claude-md-doctor --budget 1500
claude-md-doctor 1.0.2  token costs are estimates (see README)
project  ~/work/shop
config   ~/.claude

Always loaded: memory files
   tokens  file
      579  CLAUDE.md
       13    @docs/style.md
        6  CLAUDE.local.md (personal, not for git)
      598  memory total

Always in context: skill and agent descriptions
       13  1 skill the model can invoke  (1 user-only skill cost nothing)
       13    deploy  (project skill)
       12  1 agent
       12    reviewer  (project agent)

In context every session  623 tokens   budget 1,500   within budget (42% used)

Loaded on demand (read when Claude works in that folder; not counted above)
       12  packages/web/CLAUDE.md

Findings: 0 errors, 5 warnings, 1 note

WARN  move-to-skill     CLAUDE.md:11-28  saves ~444 tokens  [--fix]
      "Release process" is 484 tokens and reads like a procedure (the heading names a procedure, 16
      numbered steps, step words (first, then, finally))
      fix: Move it to .claude/skills/release-process/SKILL.md so it loads only when used, and leave
           one line behind: "Release process: use the `release-process` skill." Saves about 444 tokens
           per session.

WARN  stale-path        CLAUDE.md:6  saves ~15 tokens  [--fix]
      `src/auth/legacy.ts` does not exist
      fix: Remove the line.

WARN  stale-command     CLAUDE.md:7
      `npm run lint`: package.json has no "lint" script (it has: build, test)
      fix: Add a "lint" script to package.json, or remove the line.

NOTE  filler            CLAUDE.md:3  saves ~9 tokens  [--fix]
      "You are a helpful assistant." does not change what Claude does
      fix: Delete the line.

Automatic fixes would change 1 file and take 623 tokens down to about 155 (saves 468, 75%).
`claude-md-doctor --fix` writes a proposal and leaves your files untouched.
```

(Two more findings, `local-not-ignored` and a `conflict`, were cut from this sample.) `[--fix]` marks a finding that `--fix` writes into its proposal. `saves` is what the fix would take out of every session.

### What it reads, and what counts

These are the assumptions about Claude Code that the tool is built on. If Claude Code changes how it loads memory, these are the lines to revisit.

- **Always loaded** (counted in the budget): the user memory `<config folder>/CLAUDE.md`, where the config folder is `$CLAUDE_CONFIG_DIR` or `~/.claude`; the project's `CLAUDE.md` and `.claude/CLAUDE.md`; `CLAUDE.local.md`; and the `CLAUDE.md` files in the parent folders of the project, up to the filesystem root.
- **Imports.** An `@path` in a memory file pulls that file in, relative to the importing file, as `~/path`, or as an absolute path. An `@path` inside a code span or a fenced code block is not an import. Imports nest up to 5 levels, and a file imported twice loads once.
- **On demand** (listed, not counted): `CLAUDE.md` files in subfolders, which Claude Code reads when it reads files there. The tool lists them with their size and does not check them.
- **Always in context** (counted): the name and description of every skill the model can invoke, in `<project>/.claude/skills` and the user's `skills` folder; skills with `disable-model-invocation: true` cost nothing. Likewise the name and description of every subagent in `.claude/agents` and the user's `agents` folder.
- **Not counted**: slash commands, MCP servers, skills that come from plugins, settings, and the conversation itself.

The budget applies to the whole "in context every session" total, which is memory files plus imports plus skill and agent descriptions. The report shows each part.

### Fix it: `--fix` and `--write`

`--fix` changes nothing in your project except two kinds of new file: `<memory file>.lean` next to each memory file the project owns, and `.claude-md-doctor/proposed-skills/<name>/SKILL.md`. Look at them, copy what you like, delete the rest. Running it again writes the same files.

`--fix --write` applies the same changes. Before a memory file is rewritten it is copied to `<name>.bak-md-doctor-<timestamp>` (for example `CLAUDE.md.bak-md-doctor-20261004-153012`), the lean text is written in place, and each new skill goes into `.claude/skills/<name>/SKILL.md`. A skill folder that already exists is never overwritten: the new skill gets the next free name (`release-process-2`). Running `--fix --write` a second time changes nothing and creates no backup.

What goes into the lean version:

| Change | When |
| --- | --- |
| A line is removed | Every path and command on it is stale, nothing else concrete is on it, and it is a bullet, table row or paragraph of at most 16 words (a stale line inside a shell block goes too). A bullet's nested bullets go with it |
| A repeat is removed | It is an exact repeat, after normalizing, of an earlier line. The first copy stays |
| A filler line is dropped | See `filler` below, including repeats of "be concise" |
| A section becomes one line | A `##` section reads like a procedure and is over 350 tokens. It leaves a line such as `Release process: use the release-process skill.` and its text moves to the skill, with sub-headings one level up |
| An empty code block or heading is removed | A fenced block or a section that nothing was left in after the changes above |

What `--fix` never does: rewrite the user-level memory, a memory file in a parent folder, an imported file, or a memory file that is a link to somewhere outside the project; remove a near repeat, because it can differ in the one word that matters; touch a conflict, a big code block or a big import, which need a decision. Those stay in the report. Line endings and a byte-order mark are kept.

### The JSON report

`--json` prints one document. Within `"schema": 1`, fields are only ever added.

```text
{
  "schema": 1,
  "tool": "claude-md-doctor",
  "version": "1.0.2",
  "project": "C:/work/shop",             forward slashes on every system
  "configDir": "C:/Users/me/.claude",
  "budget": 2000,
  "totals": { "memory", "skills", "agents", "onDemand", "alwaysInContext", "overBudget" },
  "files": [ { "path", "abs", "kind", "tokens", "lines", "depth", "importedBy", "importLine", "ref", "rewritable" } ],
  "tree": [ { "path", "ref", "tokens", "note", "children": [ ... ] } ],
  "skills": [ { "name", "scope", "path", "description", "modelInvocable", "tokens" } ],
  "agents": [ { "name", "scope", "path", "description", "tokens" } ],
  "onDemand": [ { "path", "tokens", "lines" } ],
  "findings": [ { "id", "severity", "file", "line", "endLine", "tokens", "saves", "message", "fix", "autofix", "detail" } ],
  "summary": { "errors", "warnings", "notes", "overBudget", "potentialSavings", "leanTotal" },
  "plan": { "before", "after", "saved", "files": [ ... ], "skills": [ ... ] },
  "fix": null,                           or { "mode", "nothing", "files", "backups", "skills" } after --fix
  "ci": { "enabled", "pass" }
}
```

- `totals.alwaysInContext` is `memory + skills + agents`; `onDemand` is not part of it.
- `files[].kind` is `user`, `parent`, `project`, `project-claude`, `local` or `import`. `path` is relative to the project (`~/...` under the home folder, absolute elsewhere), with forward slashes. `rewritable` is true for the three files `--fix` may rewrite.
- `tree[].note` is `null`, `already loaded` (a repeat import, counted once), `cycle`, `missing`, `too deep` or `unreadable`.
- `findings` are sorted: errors, then warnings, then notes, the budget finding first, then the biggest `saves`. `line` and `endLine` are 1-based and `null` for a project-wide finding. `tokens` is what the flagged lines cost in every session, `saves` what the fix takes out (0 for a correction or a decision), and `autofix` says whether `--fix` writes it. `detail` holds check-specific data such as the missing path or the slug of a proposed skill.
- `plan` is what `--fix` would do, whether or not it ran. `fix` is `null` unless `--fix` was given.

### Privacy

md-doctor runs only on your machine. It has no network code, no telemetry and no account, and it sends nothing anywhere. It reads the memory files listed above and the files they import, the skill and agent descriptions in your `skills` and `agents` folders, the project files that name commands (such as `package.json` scripts and the Makefile), and whether the paths your memory files mention exist; it asks git whether `CLAUDE.local.md` is ignored or tracked. It writes nothing unless you ask: `--fix` writes the `.lean` and proposed-skill files described above, and `--fix --write` applies them, after a backup. Questions go to [the issues](https://github.com/nrzz/claude-md-doctor/issues).

## What it checks

Each finding has an id, a severity, the lines, the tokens it costs or saves, and a fix. Severities: `error` for `over-budget` and `import-error`; `warn` for `stale-path`, `stale-command`, `duplicate`, `conflict`, `move-to-skill`, `big-code-block`, `big-import` and `local-not-ignored`; `info` for `filler`. The checks are heuristics, so each one leans towards staying quiet.

### `over-budget`

The in-context total is above the budget (default 2,000 tokens, set with `--budget`). It leads the report and names the biggest contributors.

```text
ERROR over-budget
      2,332 tokens are in context every session, 332 over the budget of 2,000
      fix: Biggest: README.md 1,679; CLAUDE.md 639; docs/a.md 5. The fixes below can take out about 59 tokens, down to 2,273. ...
```

### `stale-path`

A path in backticks, in plain text or as a link target that does not exist, checked from the project folder and from the file's own folder. In backticks, a token counts when it has a file extension, starts with `./` or `../`, ends with `/`, is the whole code span, or starts with a folder that exists. In plain text it needs an extension, a leading `./` or `../`, or a trailing `/`, so "and/or" and "client/server" are prose. Windows paths (`src\foo.ts`) are understood, and `file.ts:42` is checked as `file.ts`. Paths inside shell code blocks are checked too.

```text
- Auth lives in `src/auth/legacy.ts`.
WARN  stale-path  CLAUDE.md:6  saves ~15 tokens  [--fix]
      `src/auth/legacy.ts` does not exist
      fix: Remove the line.
```

When a file or folder with the same name exists somewhere else in the project, the fix names it ("a file or folder with that name exists at `src/auth/legacy.ts`"), in case it only moved.

Left alone: URLs and domains, globs (`*`, `?`, `[ ]`), placeholders (`<file>`, `${HOME}`, `path/to/x`, `your-project/`), lines marked as an example (`e.g.`, "for example", "such as") and `## Examples` sections, bare file names such as `package.json`, build output (`dist/`, `node_modules/`, `coverage/` and the like), absolute paths outside the project, paths that leave the project, `~/` paths in shared files, and any missing path that the project's `.gitignore` covers.

### `stale-command`

A command that names something that is not there:

- `npm run x`, `npm test`, `pnpm x`, `pnpm run x`, `yarn x`, `bun run x` where script `x` is in no `package.json` of the project;
- `make x` where the Makefile has no target `x` (or there is no Makefile);
- `just x` where the justfile has no recipe `x`;
- `dotnet test <path>` (and `build`, `publish`, `restore`, `pack`, `clean`, `run --project`) where the path does not exist.

```text
- Run `npm run lint` before you commit, then `npm test`.
WARN  stale-command  CLAUDE.md:7
      `npm run lint`: package.json has no "lint" script (it has: build, test)
      fix: Add a "lint" script to package.json, or remove the line.
```

Commands in backticks and in shell code blocks are checked; in plain prose only the explicit `npm run x` forms are, so "use yarn workspaces" is safe. It stays silent when something else could explain the command: workspace and prefix flags (`--workspace`, `--filter`, `-C`), a `cd` into a folder it cannot see, a script that exists in another package of the repository, tools installed as binaries (`yarn tsc`), a Makefile that includes other files, placeholders such as `<script>`. A near miss is suggested ("Use `npm run test` if that is what was meant, or remove the line.").

### `duplicate`

The same instruction twice, within a file or across files (the user memory, parent folders, the project memory, `CLAUDE.local.md`, imports). List items and paragraphs are normalized (case, punctuation and markdown removed) and count as repeats when they are identical, or share at least 85 percent of their words (Jaccard similarity on word sets) and both have at least five words. Lines that differ in polarity (`always` against `never`, `not`) or in a number are not repeats.

```text
WARN  duplicate  CLAUDE.md:8  saves ~23 tokens  [--fix]
      repeats CLAUDE.md:7: "Always run the formatter before you commit any changes to the main..."
      fix: Delete this copy and keep line 7.
```

`--fix` removes exact repeats only. A near repeat is reported with the words that differ, because "main" and "trunk" may be two branches. A repeat of a line in your user memory is reported but never removed, since the project copy may be the only one your teammates have.

### `conflict`

Instructions that likely contradict each other, reported as warnings to review and never fixed automatically:

- "always X" or "must X" against "never X", "do not X" or "avoid X" about the same thing; "commit X" against "do not commit X";
- two different package managers named as the one to use (`use pnpm`, `npm install`);
- tabs against spaces, or two different space widths.

```text
WARN  conflict  CLAUDE.md:9
      "Never use semicolons in this repository." contradicts "Always use semicolons in this
      repository." at CLAUDE.md:8
      fix: Decide which rule holds and delete the other, or scope one of them ("in tests, ...").
```

A rule with a different scope ("never run the tests in production" against "always run the tests before committing") is not a conflict, and neither is "use pnpm, not npm" or installing a tool globally with `npm install -g`.

### `move-to-skill`

A `##` section of more than 350 tokens that reads like a procedure: its heading names one (release, deploy, set up, how to, runbook, migrate and similar), or it has at least two of these: numbered steps, step words ("first", "then", "finally"), a run of shell commands. A skill loads only when it is used, so the section stops costing tokens in every session.

```text
WARN  move-to-skill  CLAUDE.md:11-28  saves ~444 tokens  [--fix]
      "Release process" is 484 tokens and reads like a procedure (...)
      fix: Move it to .claude/skills/release-process/SKILL.md so it loads only when used, and leave
           one line behind: "Release process: use the `release-process` skill." ...
```

The saving is the section minus the one-line pointer minus the new skill's description (a skill's name and description are in context, the body is not). The proposed skill has a name, a description generated from the heading (under 100 characters) and the section's text. A section that imports a file is not moved, and a long list of numbered rules is not a procedure.

### `big-code-block`

A fenced code block of more than 25 lines. Move it to a file and leave a one-line reference; Claude reads the file when it needs it. The fix suggests a path from the nearest heading and the block's language (`scripts/deploy-script.sh`, `docs/config.json`).

```text
WARN  big-code-block  CLAUDE.md:32-59  saves ~149 tokens
      a 26-line code block costs 161 tokens in every session
```

### `big-import`

An `@import` that pulls in more than 1,500 tokens (the file and everything it imports in turn), such as `@README.md`. A one-line import hides a large cost.

```text
WARN  big-import  CLAUDE.md:11  saves ~1,667 tokens
      @README.md pulls 1,679 tokens into every session
      fix: Replace the import with a one-line pointer ("See README.md for the details") so Claude reads the file only when a task needs it, or import a shorter file.
```

### `filler`

Generic lines that do not change what Claude does: "You are a helpful assistant", "write clean code", "follow best practices", "be careful", "think step by step", "double-check your work", "do your best". A line counts only when the phrase makes up most of it: at least half of a line of up to 8 words, at least 60 percent of a line of 9 to 25 words, and never a longer line. So "Be careful with database migrations" and "follow best practices for React hooks: list every dependency" are kept. "Be concise" and its relatives are real instructions the first time; the repeats are filler.

```text
NOTE  filler  CLAUDE.md:3  saves ~9 tokens  [--fix]
      "You are a helpful assistant." does not change what Claude does
      fix: Delete the line.
```

### `local-not-ignored`

`CLAUDE.local.md` is personal. In a git repository it should be git-ignored, or it is one `git add .` from being committed. The check asks git (`git check-ignore`, with a 3 second limit) and says nothing when git is missing, slow, or the folder is not a repository. If the file is already committed, the fix is `git rm --cached` as well.

```text
WARN  local-not-ignored  CLAUDE.local.md
      CLAUDE.local.md is personal but is not git-ignored, so it can be committed by accident
      fix: Add "CLAUDE.local.md" to .gitignore (or to .git/info/exclude if only you have the file).
```

### `import-error`

An import that does not work: a target that does not exist, a folder or a binary file, a cycle, or nesting deeper than 5 levels (which Claude Code does not load). An `@word` that does not look like a file is a mention, not a broken import: `@someone`, `@types/node`, `@/lib/x`, an e-mail address, and anything in a code span or code block are ignored.

```text
ERROR import-error  CLAUDE.md:11
      @docs/missing.md does not exist
      fix: Fix the path or delete the import.
ERROR import-error  docs/b.md:1
      import cycle: docs/a.md -> docs/b.md -> docs/a.md
      fix: Remove the import that closes the loop.
```

## In CI

Fail a build when the memory files outgrow the budget or an import breaks, and put the report in the job summary. `--no-user` keeps the result the same on every machine.

```yaml
name: claude-md
on: [pull_request]
jobs:
  memory:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx -y github:nrzz/claude-md-doctor . --no-user --markdown --budget 2000 >> "$GITHUB_STEP_SUMMARY"
      - run: npx -y github:nrzz/claude-md-doctor . --no-user --ci --budget 2000
```

`--ci` exits 1 when there is an error finding (`over-budget` or `import-error`) or the budget is exceeded; warnings and notes never fail the build. For a stricter gate use `--json`, for example to fail on any `stale-path`:

```bash
npx -y github:nrzz/claude-md-doctor . --no-user --json | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")); process.exit(r.findings.some(f=>f.id==="stale-path")?1:0)'
```

## How it counts tokens

Every number is an estimate. Anthropic does not publish a tokenizer for current Claude models, and this tool does not reproduce Claude's tokenizer. One function, `estimateTokens()`, produces every figure in the report (per file, per finding, totals, before and after), so they always add up.

It splits a text into words, numbers, symbols and whitespace and counts them the way byte-pair tokenizers usually behave:

- A word of up to 8 letters is 1 token; a longer one costs `ceil(letters / 4)`. An ALL-CAPS word of 5 or more letters costs `ceil(letters / 3)`. `camelCase` and `PascalCase` words are split into their parts (`getUserById` is 4).
- A number costs `ceil(digits / 3)`. A symbol is 1 token, a run of the same symbol costs `ceil(length / 4)`, and a few pairs (`=>`, `!=`, `://`) count as one.
- A single space in front of a word is free, an indent run costs `ceil(length / 8)`, a run of newlines costs `ceil(count / 2)`.
- Paths, URLs and identifiers are counted segment by segment: `src/foo/bar.ts` is 7 tokens where characters / 4 says 4.
- CJK characters cost 1 each, other non-Latin words `ceil(letters / 2)`, an emoji 2.

It is calibrated against the common rule of thumb, characters divided by 4, and on ordinary English markdown it lands within about 15 percent of it. It counts more than characters / 4 for code, paths and URLs, which that rule undercounts, and less for text that is mostly whitespace. Measured against characters / 4 on all 13 markdown files of three sibling repositories (READMEs, skills, templates), the estimate ranged from 0.94 to 1.30 times, 1.08 overall, and 10 of the 13 were within 15 percent; the three outside were short files of about 100 tokens. On two paragraphs of plain English it was 0.88 times.

What that does not tell you: how close it is to what Claude actually counts. Real counts can differ by more than 15 percent, more for code-heavy or non-English text. Use the numbers to compare files and to see which fix saves most, and use the budget as a guard rail, not as an exact limit. The estimator is deterministic and gives the same result on every system for ASCII text; the Unicode tables behind `\p{...}` come with your Node version, so a rarely used character can count differently between versions.

## What was verified, and how

Checked on 2026-10-04 on Windows 11 with Node 24.19, git 2.55 and Claude Code 2.1.286:

- **488 automated tests** (`npm test`, Node's own runner, no dependencies; one is skipped on Windows because it needs a `|` in a file name).
- **The checks, with true positives and false-positive guards.** Every finding has fixture projects in throwaway folders that must trigger it and ones that must not: URLs, globs, placeholders, dates, `and/or`, build output, gitignored paths, absolute paths, example-marked lines and a Windows path with spaces are not stale paths; an `@` in a code span, a code block, a comment, an e-mail address or `@types/node` is not an import; `use pnpm, not npm` and `npm install -g` are not package-manager conflicts; "follow best practices for React hooks" is not filler.
- **Imports.** Relative, `~/` (with a temporary home folder), absolute and Windows-style imports, nesting at exactly 5 levels and a sixth, cycles, a file imported twice counted once, a folder and a binary file as targets.
- **Discovery.** Parent folders up to a ceiling, outermost first; the user memory from a temporary `CLAUDE_CONFIG_DIR`; `--no-user`; on-demand files listed and not counted; a linked `CLAUDE.md` read once.
- **`--fix` is safe.** Originals are byte for byte unchanged after `--fix`; `--write` makes one backup per file named with the timestamp and never reuses a name; an existing skill folder is never overwritten; user memory, parent files, imports and links out of the project are never rewritten; CRLF and a byte-order mark survive. 200 random memory files check that a lean file is a fixed point (fixing it again changes nothing), that no valid line is lost (it stays in the lean file or in a skill) and that no file gets bigger; 30 more are written to disk and compared with the plan. During development, a longer one-off run of 4,000 random sets of one to three memory files (its script is not part of this repository) found the cases where a copy standing in for a moved original was missed; they are fixed, and the 200 above keep checking them.
- **Robustness.** 300 random inputs made of markdown fragments, unclosed fences, odd Unicode and Windows paths never make the analysis, the fix plan or any report throw. Inputs that could be quadratic (20,000 open brackets, 20,000 spaces inside a rule, 6,000 distinct lines) finish in seconds or less; a memory file of 20,000 lines (about 540,000 tokens) takes a few seconds.
- **The plugin.** `claude plugin validate .claude-plugin/plugin.json` and `claude plugin validate .` both pass, also with `--strict`, using a throwaway config folder, with Claude Code 2.1.286 and 2.1.289. On 2026-10-04 the plugin installed from GitHub with `/plugin marketplace add nrzz/claude-md-doctor` and `/plugin install md-doctor@claude-md-doctor`. The skill is user-only, its description is under 60 characters and its whole text is under 150 tokens.
- **Run by hand** against `claude-code-handover`, `claude-code-team-sync` and `claude-code-glow` with an empty config folder: none of the three has a memory file, so each report says "none found" and exits 0. So the tool was also run on temporary copies of each, with a memory file written for the check. In the glow copy it found the `@README.md` import (2,972 tokens, the only reason the total passed the budget), a missing `src/audit.mjs`, an `npm run lint` that glow has no script for, and a filler line, and it left the paths and scripts that do exist alone. In the handover copy, its own `templates/CLAUDE.local.md` put in place, it reported the template's `@HANDOVER.md` import as missing (the template expects that file at the project root) and the file as not git-ignored. In the team-sync copy it found the one missing `docs/guide.md`.

Not verified: how a live Claude Code session loads memory files. The assumptions above come from Claude Code's documented behavior and were not checked against a running session, and neither was the claim that a user-only skill stays out of the model's skill list. Nor was the skill run inside Claude Code; it was installed through the marketplace, but not invoked. The token estimate was never compared with Claude's own count. The whole suite passes on Node 18.20 as well. CI runs the tests on Linux, macOS and Windows with Node 20, 22 and 24 and on Linux with Node 18, all green; its first run caught a Linux-only bug (build-output folders were judged from the drive root, so missing paths under /tmp were ignored), fixed since.

## Files

| Path | What it is |
| --- | --- |
| `bin/claude-md-doctor.mjs` | The command |
| `src/cli.mjs`, `src/analyze.mjs` | Option parsing and exit codes; puts discovery, the checks and the fix plan together |
| `src/discover.mjs`, `src/imports.mjs` | Finds the memory files, imports, on-demand files, skills and agents; import resolution |
| `src/checks/` | One module per family of checks: references (stale paths and commands), duplicates, conflicts, structure (skills, code blocks, imports), filler, git |
| `src/tokens.mjs` | The token estimator |
| `src/markdown.mjs`, `src/text.mjs`, `src/frontmatter.mjs`, `src/fsutil.mjs`, `src/findings.mjs` | Markdown scanning, text helpers, front matter, file helpers, the finding shape and its severities |
| `src/fix.mjs`, `src/skills.mjs` | The lean version, the proposed skills, backups and writing |
| `src/report.mjs` | The text, markdown and JSON reports |
| `skills/md-doctor/` | `/md-doctor:md-doctor`, the user-only skill |
| `.claude-plugin/` | The plugin manifest and the marketplace |
| `test/` | `npm test` |

Related: [claude-code-handover](https://github.com/nrzz/claude-code-handover) keeps your sessions short with a handover file, [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync) shares sessions and context with your coworkers, and [claude-code-glow](https://github.com/nrzz/claude-code-glow) themes Claude Code and shows tips that save tokens.

## Contributing

Issues and pull requests are welcome: start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [good first issues](https://github.com/nrzz/claude-md-doctor/issues?q=is%3Aopen+label%3A%22good+first+issue%22). Questions go to [Discussions](https://github.com/nrzz/claude-md-doctor/discussions); security reports go through [SECURITY.md](SECURITY.md).

## Part of the Claude Code toolkit

Small, dependency-free tools that make Claude Code cheaper, safer and easier to share, all in the [Claude Code toolkit](https://github.com/nrzz/claude-code-toolkit):

- [claude-code-handover](https://github.com/nrzz/claude-code-handover): short sessions with a handover file every new session loads by itself
- [claude-code-team-sync](https://github.com/nrzz/claude-code-team-sync): share sessions, notes and team context with coworkers
- [claude-code-glow](https://github.com/nrzz/claude-code-glow): themes for the whole interface, a status line and a live HUD
- [claude-code-guardrails](https://github.com/nrzz/claude-code-guardrails): safety presets that stop risky commands and edits
- [claude-code-notify](https://github.com/nrzz/claude-code-notify): a ping when Claude needs you or finishes
- [claude-code-starter-kits](https://github.com/nrzz/claude-code-starter-kits): a lean, safe .claude/ for your stack in one command
- [claude-cost-guard](https://github.com/nrzz/claude-cost-guard): daily and weekly token budgets with zero-token warnings
- [claude-session-replay](https://github.com/nrzz/claude-session-replay): search past sessions and export one as an HTML replay

Set up any of them, or all of them, from one page: `npx -y github:nrzz/claude-code-toolkit` opens it with the recommended tools switched on.

## License

MIT
