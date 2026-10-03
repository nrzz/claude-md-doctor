// Small file helpers: tolerant reads, identity keys, display paths, backup names.
import fs from "node:fs";
import path from "node:path";

const MAX_BYTES = 16 * 1024 * 1024;

/**
 * Read a text file the way the tool needs it: BOM removed, line endings normalized to \n, with
 * the original BOM and line-ending style remembered so a rewrite keeps them.
 * Returns null when it cannot be read; { binary: true } for a file with NUL bytes and
 * { tooLarge: true } past 16 MB.
 */
export function readFileText(file) {
  let buf;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    if (st.size > MAX_BYTES) return { text: "", tooLarge: true, bytes: st.size };
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (buf.subarray(0, 8000).includes(0)) return { text: "", binary: true, bytes: buf.length };
  let text = buf.toString("utf8");
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return { text: text.replace(/\r\n?/g, "\n"), bom, eol: crlf > lf ? "\r\n" : "\n", bytes: buf.length };
}

/** Write text back with the original BOM and line endings. */
export function writeFileText(file, text, { bom = false, eol = "\n" } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
  fs.writeFileSync(file, (bom ? "﻿" : "") + body);
}

export const exists = (p) => {
  try { fs.statSync(p); return true; } catch { return false; }
};
export const isFile = (p) => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};
export const isDir = (p) => {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
};
export const listDir = (dir) => {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
};

/** A string that is equal for two paths to the same file (symlinks resolved, case folded on Windows). */
export function realKey(p) {
  let r;
  try { r = fs.realpathSync.native(p); } catch { r = path.resolve(p); }
  return process.platform === "win32" ? r.toLowerCase() : r;
}

export const toPosix = (p) => String(p).replace(/\\/g, "/");

/** True when `child` is `parent` or lies below it. */
export function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The path to show people: relative to the project when inside it, ~/... inside home, else absolute. */
export function displayPath(abs, { project, home } = {}) {
  if (project && isInside(project, abs)) return toPosix(path.relative(project, abs)) || ".";
  if (home && isInside(home, abs)) return `~/${toPosix(path.relative(home, abs))}`;
  return toPosix(abs);
}

const two = (n) => String(n).padStart(2, "0");

/** 20261004-153012 (local time), used in backup names. */
export function timestamp(d = new Date()) {
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

/** `base` if it does not exist yet, else `base-1`, `base-2` ... */
export function uniquePath(base) {
  if (!exists(base)) return base;
  for (let i = 1; i < 1000; i++) if (!exists(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}
