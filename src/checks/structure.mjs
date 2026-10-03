// Things that are better placed somewhere else:
//   move-to-skill   a ## section over 350 tokens that reads like a procedure -> a skill
//   big-code-block  a fenced block over 25 lines -> a file the memory points to
//   big-import      an @import that pulls more than 1,500 tokens into every session
import { lineSlice, sectionsOf } from "../markdown.mjs";
import { importCandidates } from "../imports.mjs";
import { linesTokens } from "../tokens.mjs";
import { slugify } from "../text.mjs";
import { makeFinding } from "../findings.mjs";
import { procedureScore, proposeSkill, SKILL_MIN_TOKENS } from "../skills.mjs";

export const BIG_BLOCK_LINES = 25;
export const BIG_IMPORT_TOKENS = 1500;
const POINTER_TOKENS = 12; // "See docs/x.md for the full text." and the like

// Memory files a person writes by hand, as opposed to files pulled in by an import.
const ROOT_KINDS = new Set(["user", "parent", "project", "project-claude", "local"]);

function checkSkills(ctx) {
  for (const file of ctx.d.files) {
    if (!ROOT_KINDS.has(file.kind)) continue;
    const imports = importCandidates(file.doc).map((c) => c.line);
    for (const section of sectionsOf(file.doc, 2)) {
      const tokens = linesTokens(lineSlice(file.doc, section.start, section.end));
      if (tokens <= SKILL_MIN_TOKENS) continue;
      const { score, reasons } = procedureScore(file.doc, section);
      if (score < 2) continue;
      // A section that imports files cannot move: imports do not work the same way in a skill.
      if (imports.some((ln) => ln >= section.start && ln <= section.end)) continue;

      const p = proposeSkill(file.doc, section);
      if (p.net <= 0) continue;
      const f = makeFinding("move-to-skill", {
        file: file.display, line: section.start, endLine: section.end, tokens, saves: p.net,
        message: `"${section.title}" is ${tokens.toLocaleString("en-US")} tokens and reads like a procedure (${reasons.join(", ")})`,
        fix: `Move it to .claude/skills/${p.slug}/SKILL.md so it loads only when used, and leave one line behind: "${p.pointer}" Saves about ${p.net.toLocaleString("en-US")} tokens per session.`,
        autofix: file.rewritable,
        detail: { title: section.title, slug: p.slug, description: p.description, reasons },
      });
      ctx.findings.push(f);
      if (file.rewritable) ctx.ops.push({ type: "section", file, start: section.start, end: section.end, section, reasons: ["move-to-skill"], finding: f });
    }
  }
}

const EXT = { bash: "sh", sh: "sh", shell: "sh", zsh: "sh", powershell: "ps1", ps1: "ps1", json: "json", yaml: "yml", yml: "yml", typescript: "ts", ts: "ts", javascript: "js", js: "js", python: "py", py: "py", sql: "sql", markdown: "md", md: "md", diff: "diff" };

function checkBigBlocks(ctx) {
  for (const file of ctx.d.files) {
    for (const fence of file.doc.fences) {
      if (fence.lines <= BIG_BLOCK_LINES) continue;
      const last = fence.close ?? file.doc.lines.length;
      const tokens = linesTokens(lineSlice(file.doc, fence.open, last));
      const heading = [...file.doc.headings].reverse().find((h) => h.n < fence.open);
      const slug = slugify(heading?.title || "snippet", 30) || "snippet";
      const ext = EXT[fence.lang] || "txt";
      const target = ext === "sh" || ext === "ps1" ? `scripts/${slug}.${ext}` : `docs/${slug}.${ext}`;
      ctx.findings.push(makeFinding("big-code-block", {
        file: file.display, line: fence.open, endLine: last, tokens, saves: Math.max(0, tokens - POINTER_TOKENS),
        message: `a ${fence.lines}-line code block costs ${tokens.toLocaleString("en-US")} tokens in every session`,
        fix: `Move it to a file (for example ${target}) and replace the block with one line that names the path. Claude reads the file when it needs it.`,
        detail: { lang: fence.lang || null, lines: fence.lines, suggested: target },
      }));
    }
  }
}

function subtreeTokens(node) {
  return node.tokens + node.children.reduce((n, c) => n + subtreeTokens(c), 0);
}

function checkBigImports(ctx) {
  const walk = (node) => {
    const f = node.file;
    if (f && !node.note && f.kind === "import") {
      const tokens = subtreeTokens(node);
      if (tokens > BIG_IMPORT_TOKENS) {
        ctx.findings.push(makeFinding("big-import", {
          file: f.importedBy, line: f.importLine, endLine: f.importLine, tokens, saves: tokens - POINTER_TOKENS,
          message: `@${node.ref} pulls ${tokens.toLocaleString("en-US")} tokens into every session`,
          fix: `Replace the import with a one-line pointer ("See ${node.ref} for the details") so Claude reads the file only when a task needs it, or import a shorter file.`,
          detail: { ref: node.ref, imported: f.display },
        }));
      }
    }
    for (const c of node.children) walk(c);
  };
  for (const root of ctx.d.tree) walk(root);
}

export function checkStructure(ctx) {
  checkSkills(ctx);
  checkBigBlocks(ctx);
  checkBigImports(ctx);
}
