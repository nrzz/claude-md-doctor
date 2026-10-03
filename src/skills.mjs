// Turning a procedure section of CLAUDE.md into a skill: the heuristics that decide a section
// reads like a procedure, and the pieces of the proposal (name, description, body, pointer line).
import { lineSlice } from "./markdown.mjs";
import { linesTokens } from "./tokens.mjs";
import { clip, slugify } from "./text.mjs";
import { listingTokens } from "./discover.mjs";

export const SKILL_MIN_TOKENS = 350;

// Headings that name something done occasionally, not a rule that applies all the time.
const PROCEDURE_HEADING = /\b(how to|steps?|procedures?|runbook|playbook|checklist|release|releasing|deploy(?:ment|ing)?|publish(?:ing)?|roll ?out|roll ?back|set ?up|install(?:ation|ing)?|onboarding|migrat(?:e|ion|ing)|upgrad(?:e|ing)|provision(?:ing)?|troubleshoot(?:ing)?|incident|hotfix|backup|restore|bootstrap)\b/i;
const STEP_WORDS = /\b(first|then|next|finally|after that|once (?:it'?s )?done)\b/gi;
const COMMAND_LINE = /^\s*(\$\s|npm |pnpm |yarn |bun |npx |node |make |just |dotnet |python |pip |cargo |go |git |docker |kubectl |gh |\.\/)/;
const SHELL = new Set(["bash", "sh", "shell", "zsh", "console", "powershell", "ps1", "pwsh", "cmd", "bat"]);

/** How much a section reads like a procedure: { score, reasons }. Two points or more is a procedure. */
export function procedureScore(doc, section) {
  const body = doc.lines.slice(section.start, section.end); // lines after the heading
  let score = 0;
  const reasons = [];
  if (PROCEDURE_HEADING.test(section.title)) { score += 2; reasons.push("the heading names a procedure"); }
  const numbered = body.filter((l) => l.kind === "text" && l.bullet?.ordered).length;
  if (numbered >= 3) { score += 1; reasons.push(`${numbered} numbered steps`); }
  const prose = body.filter((l) => l.kind === "text").map((l) => l.text).join(" ");
  if ((prose.match(STEP_WORDS) || []).length >= 2) { score += 1; reasons.push("step words (first, then, finally)"); }
  const shellFences = doc.fences.filter((f) => f.open > section.start && f.open <= section.end && SHELL.has(f.lang)).length;
  const commandLines = body.filter((l) => l.kind === "code" && COMMAND_LINE.test(l.text)).length;
  if (shellFences >= 2 || commandLines >= 4) { score += 1; reasons.push("a sequence of shell commands"); }
  return { score, reasons };
}

/** What the model would see of the new skill: its one-line listing. */
export function skillDescription(title) {
  return clip(`${clip(title, 40)}: the project's step-by-step procedure. Use when this task comes up.`, 99);
}

/**
 * The proposal for one section: the skill's name and description, its file, the one-line pointer
 * that replaces the section, and the net tokens saved per session.
 */
export function proposeSkill(doc, section, slug = slugify(section.title) || "procedure") {
  const title = section.title.replace(/[`*_]/g, "").replace(/[:.\s]+$/, "").trim() || "Procedure";
  const description = skillDescription(title);
  const pointer = `${title}: use the \`${slug}\` skill.`;

  // The body is the section as written, with its sub-headings moved up one level.
  const bodyLines = [];
  for (let n = section.start + 1; n <= section.end; n++) {
    const line = doc.lines[n - 1];
    bodyLines.push(line.kind === "heading" ? line.text.replace(/^(\s*)#/, "$1") : line.text);
  }
  while (bodyLines.length && bodyLines[0].trim() === "") bodyLines.shift();
  while (bodyLines.length && bodyLines[bodyLines.length - 1].trim() === "") bodyLines.pop();

  const skillText = `---\nname: ${slug}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${title}\n\n${bodyLines.join("\n")}\n`;
  const sectionTokens = linesTokens(lineSlice(doc, section.start, section.end));
  const pointerTokens = linesTokens([pointer]);
  const descTokens = listingTokens(slug, description);
  return { title, slug, description, pointer, skillText, sectionTokens, pointerTokens, descTokens, net: sectionTokens - pointerTokens - descTokens };
}
