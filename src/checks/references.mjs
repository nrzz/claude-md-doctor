// stale-path and stale-command: scan every always-loaded file for paths and commands, check them
// against the project, and report the ones that are gone. The scan also records, per line, which
// references are stale and which are fine, so --fix only removes a line when everything concrete
// on it is stale.
import path from "node:path";
import { codeSpans, linkDests, maskCode, maskLinks, stripComments, textUnits, lineSlice } from "../markdown.mjs";
import { importCandidates } from "../imports.mjs";
import { linesTokens } from "../tokens.mjs";
import { makeFinding } from "../findings.mjs";
import { ProjectIndex } from "./projectindex.mjs";
import { judgePath } from "./paths.mjs";
import { commandRefs, proseCommandRefs } from "./commands.mjs";
import { ignoredPaths } from "./gitignore.mjs";

const SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh", "console", "terminal", "powershell", "ps1", "pwsh", "cmd", "bat", "batch", "shellscript", "sh-session", "fish"]);
const COMMAND_WORD = /^(\$|npm|pnpm|yarn|bun|npx|node|make|just|dotnet|python|pip|cargo|go|git|docker|cd|\.\/)\b/;
const EXAMPLE_LINE = /(^|\W)e\.g\.|\b(for example|for instance|examples?|such as|sample|placeholder|hypothetical|illustrative)\b/i;
const EXAMPLE_HEADING = /\b(examples?|samples?|templates?|placeholders?)\b/i;
// A line is only removed when it is short: a long one says more than "see this path" and needs a person.
const MAX_REMOVABLE_WORDS = 16;

const unique = (a) => [...new Set(a)];
const tick = (s) => `\`${s}\``;

// Is this fence a block of shell commands? By its language, or for an unlabeled one, by what it holds.
function isShellFence(doc, fence) {
  if (fence.lang) return SHELL_LANGS.has(fence.lang);
  const body = lineSlice(doc, fence.contentStart, fence.contentEnd).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  if (!body.length) return false;
  return body.filter((s) => COMMAND_WORD.test(s)).length / body.length >= 0.5;
}

// A Windows path with spaces ("C:\Program Files\x\y.exe") arrives as several tokens. Once a token
// opens a drive-letter path, the tokens that continue it are not separate paths.
export function dropSplitWindowsPaths(parts) {
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    out.push(parts[i]);
    if (!/^[A-Za-z]:[\\/]/.test(parts[i]) || /\.\w{1,8}$/.test(parts[i])) continue;
    let taken = 0;
    while (i + 1 < parts.length && taken < 4 && (/[\\/]/.test(parts[i + 1]) || /\\/.test(parts[i + 2] || ""))) {
      i++;
      taken++;
      if (/\.\w{1,8}[)\]"'.,;:]*$/.test(parts[i])) break;
    }
  }
  return out;
}

function lineRefs(map, n) {
  if (!map.has(n)) map.set(n, { stale: [], valid: [] });
  return map.get(n);
}

// Walk the file's lines and judge every path and command on them.
function scanFile(file, d, index) {
  const { doc } = file;
  const env = {
    bases: file.kind === "user" ? [] : unique([d.project, path.dirname(file.abs)]),
    project: d.project,
    home: d.home,
    allowHome: file.kind === "user" || file.kind === "local",
    fileDir: path.dirname(file.abs),
    index,
  };
  const refs = new Map(); // line -> { stale: [], valid: [] }
  const shell = new Map(); // fence -> cwd state
  let exampleLevel = 0;

  const judgeAll = (n, cands) => {
    const seen = new Set();
    for (const c of cands) {
      const r = judgePath(c.raw, c.tier, c.solo, env);
      if (!r || seen.has(r.token)) continue;
      seen.add(r.token);
      lineRefs(refs, n)[r.status === "stale" ? "stale" : "valid"].push({ type: "path", token: r.token, abs: r.abs });
    }
  };
  const addCommands = (n, list) => {
    for (const c of list) lineRefs(refs, n)[c.status === "stale" ? "stale" : "valid"].push({ type: "command", ...c });
  };

  for (const line of doc.lines) {
    if (line.kind === "heading") {
      const lvl = line.heading.level;
      if (exampleLevel && lvl <= exampleLevel) exampleLevel = 0;
      if (!exampleLevel && EXAMPLE_HEADING.test(line.heading.title)) exampleLevel = lvl;
    }
    if (exampleLevel) continue;

    if (line.kind === "text" || line.kind === "heading") {
      const text = stripComments(line.text);
      if (EXAMPLE_LINE.test(text)) continue;
      const cands = [];
      for (const sp of codeSpans(text)) {
        const parts = dropSplitWindowsPaths(sp.content.trim().split(/\s+/).filter(Boolean));
        for (const p of parts) cands.push({ raw: p, tier: "code", solo: parts.length === 1 });
        addCommands(line.n, commandRefs(sp.content, env, {}));
      }
      for (const l of linkDests(text)) cands.push({ raw: l.dest, tier: "link", solo: false });
      const plain = maskLinks(maskCode(text));
      for (const p of dropSplitWindowsPaths(plain.split(/\s+/).filter(Boolean))) cands.push({ raw: p, tier: "plain", solo: false });
      addCommands(line.n, proseCommandRefs(plain, env));
      judgeAll(line.n, cands);
    } else if (line.kind === "code" && line.fence) {
      if (!shell.has(line.fence)) shell.set(line.fence, { isShell: isShellFence(doc, line.fence), state: {} });
      const info = shell.get(line.fence);
      if (!info.isShell) continue;
      const text = line.text.trim().replace(/\s#\s.*$/, "");
      if (!text || text.startsWith("#")) continue;
      addCommands(line.n, commandRefs(text, env, info.state));
      judgeAll(line.n, dropSplitWindowsPaths(text.replace(/^(\$|>|%)\s+/, "").split(/\s+/).filter(Boolean)).map((raw) => ({ raw, tier: "code", solo: false })));
    }
  }
  return refs;
}

// For each line: the unit it belongs to, so a finding can say what the whole bullet costs.
function unitMap(doc) {
  const map = new Map();
  for (const u of textUnits(doc)) for (let n = u.start; n <= u.end; n++) map.set(n, u);
  return map;
}

/** stale-path and stale-command findings; registers removal ops for units that are only stale. */
export function checkReferences(ctx) {
  const { d } = ctx;
  const index = new ProjectIndex(d.project);

  for (const file of d.files) {
    const refs = scanFile(file, d, index);
    if (![...refs.values()].some((r) => r.stale.length)) continue;

    // A missing path that the project's .gitignore covers is a generated or local file, not a stale one.
    if (ctx.git) {
      const missing = [...refs.values()].flatMap((r) => r.stale.filter((s) => s.type === "path").map((s) => s.abs));
      const ignored = ignoredPaths(d.project, missing);
      if (ignored.size) {
        for (const r of refs.values()) { // still a concrete reference, so its line is not removable
          r.valid.push(...r.stale.filter((s) => s.type === "path" && ignored.has(s.abs)));
          r.stale = r.stale.filter((s) => !(s.type === "path" && ignored.has(s.abs)));
        }
      }
      if (![...refs.values()].some((r) => r.stale.length)) continue;
    }
    const units = unitMap(file.doc);
    const importLines = importCandidates(file.doc).map((c) => c.line);

    // Group the references by the bullet, paragraph or table row they sit in (a line of a code
    // block is its own group), so a wrapped bullet gives one finding.
    const groups = new Map();
    for (const [n, r] of [...refs.entries()].sort((a, b) => a[0] - b[0])) {
      const unit = units.get(n);
      const key = unit ? `u${unit.start}` : `l${n}`;
      if (!groups.has(key)) groups.set(key, { unit, start: unit ? unit.start : n, end: unit ? unit.end : n, fence: file.doc.lines[n - 1].kind === "code", stale: [], valid: [] });
      const g = groups.get(key);
      g.stale.push(...r.stale);
      g.valid.push(...r.valid);
    }

    for (const g of groups.values()) {
      if (!g.stale.length) continue;
      const { unit, start, end } = g;
      const cost = linesTokens(lineSlice(file.doc, start, end));

      // Removable: everything concrete in the unit is stale, and nothing in it is an import.
      const hasImport = importLines.some((ln) => ln >= start && ln <= end);
      const wordy = unit && unit.text.split(/\s+/).length > MAX_REMOVABLE_WORDS;
      const removable = !g.valid.length && !hasImport && !wordy && !!(g.fence || unit);
      const removeEnd = unit && unit.kind === "item" ? unit.subtreeEnd : end;
      const saves = removable ? linesTokens(lineSlice(file.doc, start, removeEnd)) : 0;

      const made = [];
      const commands = g.stale.filter((s) => s.type === "command");
      // "dotnet test tests/X.csproj" already says the path is missing; do not say it twice.
      const covered = new Set(commands.filter((c) => c.kind === "dotnet").map((c) => c.name));
      const text = lineSlice(file.doc, start, end).join("\n");
      const paths = g.stale
        .filter((s) => s.type === "path" && !covered.has(s.token.replace(/\\/g, "/").replace(/^\.\//, "")))
        .sort((a, b) => text.indexOf(a.token) - text.indexOf(b.token)); // in the order they appear
      if (paths.length) {
        const names = paths.map((s) => tick(s.token));
        const hints = paths.flatMap((s) => index.sameName(s.token)).filter((h, i, a) => a.indexOf(h) === i).slice(0, 3);
        made.push(makeFinding("stale-path", {
          file: file.display, line: start, endLine: end, tokens: cost, saves,
          message: paths.length === 1 ? `${names[0]} does not exist` : `${names.join(", ")} do not exist`,
          fix: `${removable ? "Remove the line" : "Remove or correct the path"}${hints.length ? `; a file or folder with that name exists at ${hints.map(tick).join(", ")}` : ""}.`,
          detail: { paths: paths.map((s) => s.token), moved: hints },
        }));
      }
      for (const c of commands) {
        made.push(makeFinding("stale-command", {
          file: file.display, line: start, endLine: end, tokens: cost, saves,
          message: c.message,
          fix: c.fix,
          detail: { command: c.text, kind: c.kind, name: c.name, suggestion: c.suggestion || null },
        }));
      }

      if (removable && file.rewritable) {
        ctx.ops.push({ type: "remove", file, start, end: removeEnd, reasons: made.map((f) => f.id) });
        for (const f of made) f.autofix = true;
      }
      ctx.findings.push(...made);
    }
  }
}
