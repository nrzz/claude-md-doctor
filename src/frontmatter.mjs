// Minimal YAML front matter reader for skill and agent files: plain, quoted, folded (>) and
// literal (|) scalars. Enough for `name`, `description` and `disable-model-invocation`.

/** { key: "value" } from a leading --- block, or {} when there is none. */
export function parseFrontmatter(text) {
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(String(text ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n"));
  if (!m) return {};
  const lines = m[1].split("\n");
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let val = kv[2].trim();
    const block = /^[>|][+-]?$/.test(val);
    if (block) val = "";
    while (i + 1 < lines.length && (/^[ \t]+\S/.test(lines[i + 1]) || (block && lines[i + 1].trim() === ""))) {
      val += (val ? " " : "") + lines[++i].trim();
    }
    out[kv[1]] = val.trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
  }
  return out;
}

/** YAML-ish truth: true, True, "true", yes. */
export const isTrue = (v) => /^(true|yes|on)$/i.test(String(v ?? "").trim());
