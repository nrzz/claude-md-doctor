// @path imports inside memory files.
//
// Claude Code pulls another file into context for every `@path` in a memory file: relative to the
// importing file, `~/` for the home folder, or an absolute path. Imports inside inline code spans
// and fenced code blocks are not imports. Imports nest up to five levels, and a file imported
// twice is loaded once (see discover.mjs).
import os from "node:os";
import path from "node:path";
import { isFile, isDir, toPosix } from "./fsutil.mjs";
import { maskCode } from "./markdown.mjs";

export const MAX_IMPORT_DEPTH = 5;
const MAX_CANDIDATES = 500; // per file: more than this is not a memory file, it is an accident

// Extensions that make a bare `@name.ext` look like a file and not a person's handle.
const DOC_EXT = new Set([
  "md", "markdown", "mdx", "txt", "rst", "adoc", "json", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml", "csv",
  "env", "lock", "mjs", "cjs", "js", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "cs", "sh", "ps1", "sql", "html", "css",
]);

/**
 * Every `@something` on a prose line that could be an import: { ref, line }.
 * The `@` must start the line or follow whitespace or an opening bracket or quote, so e-mail
 * addresses and `user@host` are skipped. Code spans, fenced blocks and comments are not looked at.
 */
export function importCandidates(doc) {
  const out = [];
  for (const line of doc.lines) {
    if (line.kind !== "text" && line.kind !== "heading") continue;
    if (!line.text.includes("@")) continue;
    const prose = maskCode(line.text);
    const re = /(^|[\s(["'*])@((?:\\ |[^\s])+)/g;
    let m;
    while ((m = re.exec(prose))) {
      const ref = m[2].replace(/\\ /g, " ").replace(/[.,;:!?)\]}"'*]+$/, "");
      if (!ref || ref.startsWith("@") || ref.includes("://")) continue;
      out.push({ ref, line: line.n });
      if (out.length >= MAX_CANDIDATES) return out;
    }
  }
  return out;
}

/** Where an import points: an absolute path, or null when it cannot exist on this system. */
export function resolveImport(ref, fromDir, home = os.homedir()) {
  if (/^~[\\/]/.test(ref)) return path.join(home, toPosix(ref.slice(2)));
  if (/^[A-Za-z]:[\\/]/.test(ref) || ref.startsWith("\\\\")) return path.win32.isAbsolute(ref) && process.platform === "win32" ? path.resolve(ref) : null;
  if (ref.startsWith("/")) return path.resolve(ref);
  return path.resolve(fromDir, toPosix(ref));
}

/**
 * Whether a target that does not exist is worth an error. An `@word` with no path shape is a
 * mention (`@Override`, `@someone`), a scoped package (`@types/node`) or a TypeScript alias
 * (`@/lib/x`), not a broken import.
 */
export function missingIsError(ref) {
  if (/^(~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\)/.test(ref)) return true;
  const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(ref) || [])[1]?.toLowerCase();
  if (ref.startsWith("/")) return !!ext;
  if (/[\\/]/.test(ref)) return !!ext;
  return !!ext && DOC_EXT.has(ext);
}

/** What an import's target is: { abs, status: "file" | "folder" | "missing" | "ignore" }. */
export function classifyImport(ref, fromDir, home) {
  const abs = resolveImport(ref, fromDir, home);
  if (abs && isFile(abs)) return { abs, status: "file" };
  if (abs && isDir(abs)) return { abs, status: missingIsError(ref) || /[\\/]$/.test(ref) ? "folder" : "ignore" };
  return { abs, status: missingIsError(ref) ? "missing" : "ignore" };
}
