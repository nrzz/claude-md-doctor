// Line-level markdown scanning for CLAUDE.md files. This is not a full CommonMark parser. It
// knows exactly what the checks need: which lines are prose, which are inside a fenced code
// block or an HTML comment, where the headings, list items and tables are, and where the inline
// code spans and links sit on a prose line.

const FENCE_OPEN = /^(\s*)(`{3,}([^`]*)|~{3,}(.*))$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const BULLET = /^(\s*)([-*+]|\d{1,3}[.)])[ \t]+(.*)$/;

const MAX_SUBTREE = 2000; // lines scanned for the nested bullets of one item

const indentOf = (s) => {
  let w = 0;
  for (const ch of s) {
    if (ch === " ") w += 1;
    else if (ch === "\t") w += 4;
    else break;
  }
  return w;
};

/**
 * Scan a text into lines. Every line gets a kind:
 *   blank, text, heading, fence (an opening or closing fence line), code (inside a fence),
 *   comment (inside a multi-line HTML comment), frontmatter (a leading --- block).
 * Text lines may also carry `bullet` (a list item starts here) and `table` (a table row).
 */
export function parseDoc(text) {
  const raw = String(text ?? "").replace(/\r\n?/g, "\n");
  const rows = raw === "" ? [] : raw.replace(/\n$/, "").split("\n");
  const lines = [];
  const headings = [];
  const fences = [];
  let fence = null;
  let inComment = false;

  // A leading --- block that starts like YAML is front matter, not a horizontal rule.
  let start = 0;
  if (rows[0] && rows[0].trim() === "---" && /^[A-Za-z0-9_-]+\s*:/.test(rows[1] || "")) {
    for (let j = 1; j < Math.min(rows.length, 60); j++) {
      if (rows[j].trim() === "---") { start = j + 1; break; }
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const t = rows[i];
    const n = i + 1;
    const line = { n, text: t, kind: "text", indent: indentOf(t) };
    lines.push(line);
    if (i < start) { line.kind = "frontmatter"; continue; }

    if (fence) {
      line.fence = fence;
      const close = new RegExp(`^\\s*(${fence.char}{${fence.length},})\\s*$`).exec(t);
      if (close) {
        line.kind = "fence";
        fence.close = n;
        fence = null;
      } else {
        line.kind = "code";
      }
      continue;
    }

    if (inComment) {
      line.kind = "comment";
      if (t.includes("-->")) inComment = false;
      continue;
    }

    const open = FENCE_OPEN.exec(t);
    if (open) {
      const marker = open[2].startsWith("`") ? "`" : "~";
      const length = /^[`~]+/.exec(open[2])[0].length;
      const info = (marker === "`" ? open[3] : open[4]) || "";
      fence = { open: n, close: null, char: marker, length, lang: (info.trim().split(/\s+/)[0] || "").replace(/^\{?\.?|\}$/g, "").toLowerCase() };
      fences.push(fence);
      line.kind = "fence";
      line.fence = fence;
      continue;
    }

    if (t.trim() === "") { line.kind = "blank"; continue; }

    const c = t.indexOf("<!--");
    if (c !== -1 && t.indexOf("-->", c + 4) === -1) {
      inComment = true;
      if (t.slice(0, c).trim() === "") { line.kind = "comment"; continue; }
    }

    const h = HEADING.exec(t);
    if (h) {
      line.kind = "heading";
      line.heading = { n, level: h[1].length, title: (h[2] || "").trim().replace(/[ \t]+#+$/, "") };
      headings.push(line.heading);
      continue;
    }

    const b = BULLET.exec(t);
    if (b) line.bullet = { indent: indentOf(b[1]), marker: b[2], ordered: /\d/.test(b[2]), body: b[3] };
    if (/^\s*\|/.test(t)) line.table = true;
  }

  for (const f of fences) {
    f.contentStart = f.open + 1;
    f.contentEnd = (f.close ?? lines.length + 1) - 1; // an unclosed fence runs to the end of the file
    f.lines = Math.max(0, f.contentEnd - f.contentStart + 1);
  }
  return { lines, headings, fences };
}

/** Replace HTML comments with spaces (same length). An unterminated comment runs to the line end. */
export function stripComments(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const a = s.indexOf("<!--", i);
    if (a === -1) { out += s.slice(i); break; }
    const b = s.indexOf("-->", a + 4);
    const end = b === -1 ? s.length : b + 3;
    out += s.slice(i, a) + " ".repeat(end - a);
    i = end;
  }
  return out;
}

/** Inline code spans on one line: [{ start, end, ticks, content }], end exclusive. */
export function codeSpans(s) {
  const spans = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "`") { i++; continue; }
    let j = i;
    while (s[j] === "`") j++;
    const ticks = j - i;
    // the closing run must have exactly the same length
    let k = j;
    let found = -1;
    while (k < s.length) {
      if (s[k] !== "`") { k++; continue; }
      let e = k;
      while (s[e] === "`") e++;
      if (e - k === ticks) { found = k; break; }
      k = e;
    }
    if (found === -1) { i = j; continue; }
    let content = s.slice(j, found);
    if (content.length > 2 && content.startsWith(" ") && content.endsWith(" ")) content = content.slice(1, -1);
    spans.push({ start: i, end: found + ticks, ticks, content });
    i = found + ticks;
  }
  return spans;
}

/** The line with comments and inline code replaced by spaces: what is left is plain prose. */
export function maskCode(s) {
  const clean = stripComments(s);
  let out = clean;
  for (const sp of codeSpans(clean)) out = out.slice(0, sp.start) + " ".repeat(sp.end - sp.start) + out.slice(sp.end);
  return out;
}

/** Markdown link and image destinations on a line: [{ dest, start, end }]. Skips code spans. */
export function linkDests(s) {
  const clean = maskCode(s);
  const out = [];
  const re = /!?\[[^\]\n]{0,300}\]\([ \t]{0,5}<?([^)\s>]{1,400})>?(?:[ \t]+(?:"[^"\n]{0,300}"|'[^'\n]{0,300}'))?[ \t]{0,5}\)/g;
  let m;
  while ((m = re.exec(clean))) out.push({ dest: m[1], start: m.index, end: m.index + m[0].length });
  return out;
}

/** The text of a line with link constructs blanked out (their destinations are checked on their own). */
export function maskLinks(s) {
  let out = s;
  for (const l of linkDests(s)) out = out.slice(0, l.start) + " ".repeat(l.end - l.start) + out.slice(l.end);
  return out;
}

/** `##`-level (or other level) sections: { level, title, start, end, headingLine } with 1-based inclusive lines. */
export function sectionsOf(doc, level = 2) {
  const out = [];
  const total = doc.lines.length;
  for (let i = 0; i < doc.headings.length; i++) {
    const h = doc.headings[i];
    if (h.level !== level) continue;
    let end = total;
    for (let j = i + 1; j < doc.headings.length; j++) {
      if (doc.headings[j].level <= level) { end = doc.headings[j].n - 1; break; }
    }
    out.push({ level, title: h.title, start: h.n, end });
  }
  return out;
}

/** Strip the list marker and task checkbox from a list item's first line. */
export function stripMarker(text) {
  return text.replace(BULLET, "$3").replace(/^\[[ xX]\][ \t]+/, "");
}

/**
 * Prose units: list items (with their wrapped lines), paragraphs and table rows, in order.
 * Each unit: { kind, start, end, text, indent, ordered, subtreeEnd, hasChildren } where start,
 * end and subtreeEnd are 1-based line numbers. Lines inside fences, comments and front matter are
 * never part of a unit.
 */
export function textUnits(doc) {
  const { lines } = doc;
  const units = [];
  const isProse = (l) => l.kind === "text" && !l.table;

  for (let i = 0; i < lines.length;) {
    const ln = lines[i];
    if (ln.kind !== "text") { i++; continue; }

    if (ln.table) {
      const isRule = /^\s*\|?[\s:|-]+\|?\s*$/.test(ln.text) && ln.text.includes("-");
      if (!isRule) units.push({ kind: "row", start: ln.n, end: ln.n, text: ln.text.trim(), indent: ln.indent, subtreeEnd: ln.n, hasChildren: false });
      i++;
      continue;
    }

    let j = i + 1;
    if (ln.bullet) {
      while (j < lines.length && isProse(lines[j]) && !lines[j].bullet && lines[j].indent > ln.bullet.indent) j++;
    } else {
      while (j < lines.length && isProse(lines[j]) && !lines[j].bullet) j++;
    }
    const parts = lines.slice(i, j).map((l, k) => (k === 0 && ln.bullet ? stripMarker(l.text) : l.text).trim());
    const unit = {
      kind: ln.bullet ? "item" : "paragraph",
      start: ln.n,
      end: lines[j - 1].n,
      text: parts.join(" ").replace(/\s+/g, " "), // one line, single spaces
      indent: ln.indent,
      ordered: !!ln.bullet?.ordered,
      hasChildren: false,
    };
    unit.subtreeEnd = unit.end;
    if (ln.bullet) {
      // Everything after the item that is blank or indented deeper belongs to its subtree.
      let k = j;
      let last = unit.end;
      while (k < lines.length && k - j < MAX_SUBTREE) {
        const l = lines[k];
        if (l.kind === "blank") { k++; continue; }
        if (l.indent > ln.bullet.indent && l.kind !== "heading") { last = l.n; k++; continue; }
        break;
      }
      unit.subtreeEnd = last;
      unit.hasChildren = last > unit.end;
    }
    units.push(unit);
    i = j;
  }
  return units;
}

/** Lines [start, end] (1-based, inclusive) as an array of strings. */
export const lineSlice = (doc, start, end) => doc.lines.slice(start - 1, end).map((l) => l.text);
