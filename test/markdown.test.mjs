import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { codeSpans, linkDests, maskCode, maskLinks, parseDoc, sectionsOf, stripComments, stripMarker, textUnits } from "../src/markdown.mjs";

const kinds = (doc) => doc.lines.map((l) => l.kind);

test("fenced code blocks: backtick and tilde fences, with a language", () => {
  const doc = parseDoc("text\n```bash\nnpm test\n```\nmore\n~~~\nraw\n~~~\n");
  assert.deepEqual(kinds(doc), ["text", "fence", "code", "fence", "text", "fence", "code", "fence"]);
  assert.equal(doc.fences.length, 2);
  assert.equal(doc.fences[0].lang, "bash");
  assert.equal(doc.fences[0].lines, 1);
  assert.equal(doc.fences[1].lang, "");
});

test("a fence closes only on the same character and at least as many marks", () => {
  const doc = parseDoc("````md\n```\ninner\n```\n````\nafter\n");
  assert.deepEqual(kinds(doc), ["fence", "code", "code", "code", "fence", "text"]);
  assert.equal(doc.fences[0].lines, 3);
  const mixed = parseDoc("```\n~~~\nstill code\n```\n");
  assert.deepEqual(kinds(mixed), ["fence", "code", "code", "fence"]);
});

test("an unclosed fence runs to the end of the file", () => {
  const doc = parseDoc("```\none\ntwo\n");
  assert.equal(doc.fences[0].close, null);
  assert.equal(doc.fences[0].lines, 2);
  assert.deepEqual(kinds(doc), ["fence", "code", "code"]);
});

test("a language tag may carry extra words", () => {
  const doc = parseDoc("```js title=\"a.js\"\nx\n```\n");
  assert.equal(doc.fences[0].lang, "js");
});

test("headings: ATX levels, closing hashes, and hashtags are not headings", () => {
  const doc = parseDoc("# One\n## Two ##\n###### Six\n#hashtag\n####### seven\n");
  assert.deepEqual(doc.headings.map((h) => [h.level, h.title]), [[1, "One"], [2, "Two"], [6, "Six"]]);
});

test("a # line inside a fence is not a heading", () => {
  const doc = parseDoc("```bash\n# a comment\n```\n## Real\n");
  assert.deepEqual(doc.headings.map((h) => h.title), ["Real"]);
});

test("HTML comments: one line and several lines", () => {
  const doc = parseDoc("a <!-- hidden --> b\n<!--\nsecret\nmore\n-->\nvisible\n");
  assert.deepEqual(kinds(doc), ["text", "comment", "comment", "comment", "comment", "text"]);
  assert.equal(stripComments("a <!-- x --> b"), "a            b");
  assert.equal(stripComments("a <!-- unterminated").trim(), "a");
});

test("front matter is recognised only when it looks like YAML", () => {
  const fm = parseDoc("---\nname: x\n---\n# Title\n");
  assert.deepEqual(kinds(fm), ["frontmatter", "frontmatter", "frontmatter", "heading"]);
  const rule = parseDoc("---\nA line of prose.\n---\n");
  assert.deepEqual(kinds(rule), ["text", "text", "text"]);
});

test("list items: bullets and numbers carry their marker and indent", () => {
  const doc = parseDoc("- one\n  - nested\n1. first\n2) second\n* star\n");
  assert.deepEqual(doc.lines.map((l) => l.bullet && l.bullet.ordered), [false, false, true, true, false]);
  assert.equal(doc.lines[1].bullet.indent, 2);
});

test("emphasis and horizontal rules are not bullets", () => {
  const doc = parseDoc("**bold** text\n---\n2026. A year, not a list\n");
  assert.ok(doc.lines.every((l) => !l.bullet));
});

test("table rows are recognised", () => {
  const doc = parseDoc("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
  assert.ok(doc.lines.every((l) => l.table));
  const units = textUnits(doc);
  assert.deepEqual(units.map((u) => u.kind), ["row", "row"]); // the separator row is not a unit
});

test("inline code spans: single, double ticks, and unmatched ticks", () => {
  assert.deepEqual(codeSpans("run `npm test` now").map((s) => s.content), ["npm test"]);
  assert.deepEqual(codeSpans("a ``x ` y`` b").map((s) => s.content), ["x ` y"]);
  assert.deepEqual(codeSpans("a `unmatched and `ok`").map((s) => s.content), ["unmatched and "]);
  assert.deepEqual(codeSpans("no ticks here"), []);
});

test("maskCode blanks code spans and comments but keeps the length", () => {
  const line = "see `src/a.ts` and <!-- x --> done";
  const masked = maskCode(line);
  assert.equal(masked.length, line.length);
  assert.ok(!masked.includes("src/a.ts"));
  assert.ok(masked.includes("done"));
});

test("link destinations, with titles and images", () => {
  const dests = linkDests('see [a](docs/a.md), [b](<b.md> "title") and ![img](img/x.png) but not `[c](c.md)`').map((d) => d.dest);
  assert.deepEqual(dests, ["docs/a.md", "b.md", "img/x.png"]);
  assert.ok(!maskLinks("[a](docs/a.md) tail").includes("docs/a.md"));
});

test("sections: a ## section runs to the next heading of the same or a higher level", () => {
  const doc = parseDoc("# T\n## A\nbody\n### A1\nsub\n## B\nbody\n# C\n## D\n");
  const sections = sectionsOf(doc, 2).map((s) => [s.title, s.start, s.end]);
  assert.deepEqual(sections, [["A", 2, 5], ["B", 6, 7], ["D", 9, 9]]);
});

test("units: a wrapped bullet is one unit and its children are its subtree", () => {
  const doc = parseDoc("- first line\n  continues here\n  - child\n- second\n\nA paragraph\nof two lines.\n");
  const units = textUnits(doc);
  assert.deepEqual(units.map((u) => [u.kind, u.start, u.end]), [["item", 1, 2], ["item", 3, 3], ["item", 4, 4], ["paragraph", 6, 7]]);
  assert.equal(units[0].text, "first line continues here");
  assert.equal(units[0].subtreeEnd, 3);
  assert.equal(units[0].hasChildren, true);
  assert.equal(units[1].hasChildren, false);
  assert.equal(units[3].text, "A paragraph of two lines.");
});

test("units never include code, comments or headings", () => {
  const doc = parseDoc("# H\ntext\n```\ncode\n```\n<!--\nc\n-->\n- item\n");
  assert.deepEqual(textUnits(doc).map((u) => u.text), ["text", "item"]);
});

test("stripMarker removes bullets, numbers and task boxes", () => {
  assert.equal(stripMarker("- item"), "item");
  assert.equal(stripMarker("  12. step"), "step");
  assert.equal(stripMarker("- [x] done"), "done");
});

test("CRLF text is read the same as LF", () => {
  const a = parseDoc("# H\r\n\r\n- one\r\n");
  const b = parseDoc("# H\n\n- one\n");
  assert.deepEqual(a.lines.map((l) => l.text), b.lines.map((l) => l.text));
});

test("an empty file has no lines", () => {
  assert.deepEqual(parseDoc("").lines, []);
});
