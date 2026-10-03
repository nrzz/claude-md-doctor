// Path references: which tokens on a line are paths, and whether they exist.
//
// A token counts as a path only when it is clearly meant as one, so ordinary prose is left alone:
//   in backticks   any token with a "/" or "\" that has a file extension, starts with ./ or ../,
//                  ends with "/", is the whole code span, or starts with a folder that exists
//   in plain text  a token with a "/" or "\" AND a file extension, a leading ./ or ../, or a
//                  trailing "/" (so "and/or" and "client/server" are prose, "docs/a.md" is a path)
//   in a link      the destination of a markdown link, unless it is a URL or an anchor
// URLs, globs (* ? [ ]), placeholders (<file>, ${VAR}, path/to/x, your-project/), home-relative
// paths in shared files, and paths that leave the project are never reported.
import path from "node:path";
import { exists, isInside } from "../fsutil.mjs";

// Folders that tools generate; a missing one is not a stale reference.
export const GENERATED = new Set([
  "node_modules", "dist", "build", "out", "coverage", "target", ".next", ".nuxt", ".output", ".cache", ".turbo", ".venv", "venv",
  "__pycache__", "tmp", "temp", "logs", "log", ".tox", ".gradle", ".parcel-cache", ".svelte-kit", ".angular",
]);

const BAD_CHARS = /[<>{}$*?|=%^&+!@`"'[\],;]/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|org|net|io|dev|app|ai|co|so|sh|me|xyz|gg|edu|gov|info|us|uk|de|fr|jp|in|ca|au)$/i;
const FILE_NAME = /^[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const DOTFILE = /^\.[A-Za-z0-9_-]+$/;

// "e.g", "i.e", "a.m": a letter, a dot, a letter is an abbreviation, not a file name.
const ABBREVIATION = /^[A-Za-z]\.[A-Za-z]$/;

function looksLikeFile(seg) {
  if (!seg) return false;
  if (ABBREVIATION.test(seg)) return false;
  return FILE_NAME.test(seg) || DOTFILE.test(seg);
}

/** A raw token as { clean, shown } (normalized for lookups, and as written), or null when it is not a path to test. */
export function cleanToken(raw, { link = false } = {}) {
  let t = String(raw).trim();
  if (link) t = t.replace(/[?#].*$/, "");
  t = t.replace(/^[(["'*]+/, "").replace(/[)\]"'*,;:!?]+$/, "");
  t = t.replace(/\.+$/, (m) => (/^\.+$/.test(t) ? m : ""));
  t = t.replace(/(?::\d+){1,2}$/, "").replace(/#.*$/, "");
  if (!t || t.length > 260) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(www\.|mailto:)/i.test(t)) return null;
  if (/^[a-z][a-z0-9+.-]*:(?![\\/])/i.test(t) && !/^[A-Za-z]:[\\/]/.test(t)) return null;
  if (/^[A-Za-z]:/.test(t) ? /[:]/.test(t.slice(2)) : t.includes(":")) return null;
  if (BAD_CHARS.test(t)) return null;
  const shown = t; // as written, with the slashes the author used
  t = t.replace(/\\/g, "/");
  if (t.startsWith("//")) return null;
  t = t.replace(/\/{2,}/g, "/");
  return { clean: t, shown };
}

function isPlaceholder(t) {
  const segs = t.split("/").filter(Boolean);
  if (!segs.length) return true;
  if (/(^|\/)path\/to(\/|$)/.test(t)) return true;
  if (segs.some((s) => /^your[-_]/i.test(s) || /^x{3,}$/i.test(s) || s.includes("..."))) return true;
  if (segs.some((s) => ABBREVIATION.test(s))) return true; // e.g./i.e.
  if (segs.every((s) => /^[\d.]+$/.test(s))) return true; // 1/2, 1.2/3.4, dates
  return false;
}

/**
 * Decide whether a token is a path reference and whether it is stale.
 * env: { bases (folders relative paths are tried against), project, home, allowHome, link }
 * Returns { token, status: "valid" | "stale", abs } or null when the token is not a path to judge.
 */
export function judgePath(raw, tier, solo, env) {
  const link = tier === "link";
  const cleaned = cleanToken(raw, { link });
  if (!cleaned) return null;
  const { clean, shown } = cleaned;

  // home-relative: only the user's own files can say where their home is
  if (clean.startsWith("~")) {
    if (!env.allowHome || !clean.startsWith("~/")) return null;
    const abs = path.join(env.home, clean.slice(2));
    return { token: shown, status: exists(abs) ? "valid" : "stale", abs };
  }

  // a bare name with no folder part (package.json): in backticks it is only worth noting when it
  // exists; as the target of a markdown link ([guide](CONTRIBUTING.md)) it is checked like any path
  if (!clean.includes("/")) {
    if (!looksLikeFile(clean)) return null;
    if (tier === "link") { // fall through to the lookup below
      if (DOMAIN.test(clean)) return null;
    } else {
      if (tier !== "code" || !solo) return null;
      for (const base of env.bases) if (exists(path.join(base, clean))) return { token: shown, status: "valid", abs: path.join(base, clean) };
      return null;
    }
  }

  if (/^\/+$/.test(clean) || isPlaceholder(clean)) return null;
  const segs = clean.split("/").filter((s) => s !== "");
  const first = segs[0];
  const last = segs[segs.length - 1];
  const leadingDot = /^\.{1,2}\//.test(clean);
  const trailing = clean.endsWith("/");
  const absolute = clean.startsWith("/") || /^[A-Za-z]:\//.test(clean);
  if (DOMAIN.test(first)) return null;

  // is it clearly a path?
  const hasExt = looksLikeFile(last);
  let ok;
  if (tier === "link") ok = true;
  else if (tier === "code") ok = hasExt || leadingDot || trailing || solo || env.bases.some((b) => exists(path.join(b, first)));
  else ok = hasExt || leadingDot || trailing;
  if (!ok) return null;

  // where to look
  let candidates;
  if (absolute) {
    if (clean.startsWith("/") && link) candidates = [path.join(env.project, clean.slice(1))]; // site-root link: project root
    else {
      if (/^[A-Za-z]:\//.test(clean) && process.platform !== "win32") return null;
      const abs = path.resolve(clean);
      if (!isInside(env.project, abs)) return null; // somebody's machine, not ours to judge
      candidates = [abs];
    }
  } else {
    candidates = [];
    for (const base of env.bases) {
      const abs = path.resolve(base, clean);
      if (isInside(base, abs) || isInside(env.project, abs)) candidates.push(abs);
    }
  }
  if (!candidates.length) return null;
  const found = candidates.find((c) => exists(c));
  if (found) return { token: shown, status: "valid", abs: found };
  // build output that is not built yet; for an absolute path, judged from the project root, so a
  // project that lives under /tmp or /build is not mistaken for one
  const top = absolute ? path.relative(env.project, candidates[0]).split(/[\\/]/)[0] : first;
  if (GENERATED.has(String(top).toLowerCase())) return null;
  return { token: shown, status: "stale", abs: candidates[0] };
}
