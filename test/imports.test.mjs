import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { classifyImport, importCandidates, missingIsError, resolveImport, MAX_IMPORT_DEPTH } from "../src/imports.mjs";
import { parseDoc } from "../src/markdown.mjs";
import { sandbox } from "./helpers.mjs";

const refs = (text) => importCandidates(parseDoc(text)).map((c) => c.ref);

test("an import can start a line or sit in the middle of a sentence", () => {
  assert.deepEqual(refs("@README.md\nSee @docs/a.md for details.\n(see @b.md)\n"), ["README.md", "docs/a.md", "b.md"]);
});

test("the line number of each import is reported", () => {
  const found = importCandidates(parseDoc("one\n\ntwo @a.md\n"));
  assert.deepEqual(found, [{ ref: "a.md", line: 3 }]);
});

test("imports inside inline code and fenced blocks are not imports", () => {
  assert.deepEqual(refs("Use `@docs/a.md` literally.\n"), []);
  assert.deepEqual(refs("```\n@docs/a.md\n```\n"), []);
  assert.deepEqual(refs("~~~md\n@docs/a.md\n~~~\n"), []);
});

test("imports inside HTML comments are not imports", () => {
  assert.deepEqual(refs("<!-- @docs/a.md -->\n"), []);
  assert.deepEqual(refs("<!--\n@docs/a.md\n-->\n"), []);
});

test("e-mail addresses and user@host are not imports", () => {
  assert.deepEqual(refs("Mail me@example.com or ssh git@github.com:org/repo.git\n"), []);
});

test("trailing punctuation is not part of the path", () => {
  assert.deepEqual(refs("Read @docs/a.md. Then @docs/b.md, and (@docs/c.md)!\n"), ["docs/a.md", "docs/b.md", "docs/c.md"]);
});

test("a path with an escaped space is one import", () => {
  assert.deepEqual(refs("@docs/my\\ notes.md\n"), ["docs/my notes.md"]);
});

test("URLs containing @ are not imports", () => {
  assert.deepEqual(refs("See https://example.com/@user/page for it\n"), []);
});

test("relative paths resolve from the importing file's folder", () => {
  assert.equal(resolveImport("a.md", path.join(path.sep, "x", "docs")), path.resolve(path.sep, "x", "docs", "a.md"));
  assert.equal(resolveImport("../b.md", path.join(path.sep, "x", "docs")), path.resolve(path.sep, "x", "b.md"));
});

test("~/ resolves from the given home folder", () => {
  const home = path.join(path.sep, "h", "me");
  assert.equal(resolveImport("~/notes/a.md", "/ignored", home), path.join(home, "notes", "a.md"));
});

test("backslashes in a relative import are treated as folder separators", () => {
  const s = sandbox({ "docs/a.md": "hello\n" });
  const abs = resolveImport("docs\\a.md", s.dir);
  assert.equal(abs, path.join(s.dir, "docs", "a.md"));
  assert.equal(classifyImport("docs\\a.md", s.dir, s.home).status, "file");
});

test("an absolute path resolves to itself", () => {
  const s = sandbox({ "x.md": "hi\n" });
  assert.equal(classifyImport(path.join(s.dir, "x.md"), "/elsewhere", s.home).status, "file");
});

test("a Windows drive path cannot exist on other systems", () => {
  const abs = resolveImport("C:\\notes\\a.md", "/x");
  if (process.platform === "win32") assert.equal(abs, path.resolve("C:\\notes\\a.md"));
  else assert.equal(abs, null);
});

test("an existing file is always an import, whatever its shape", () => {
  const s = sandbox({ "Makefile": "all:\n" });
  assert.equal(classifyImport("Makefile", s.dir, s.home).status, "file");
});

test("a missing target is an error only when it looks like a file reference", () => {
  assert.equal(missingIsError("docs/missing.md"), true);
  assert.equal(missingIsError("README.md"), true);
  assert.equal(missingIsError("./x"), true);
  assert.equal(missingIsError("~/x"), true);
  assert.equal(missingIsError("../x"), true);
  assert.equal(missingIsError("C:\\x\\y"), true);
  assert.equal(missingIsError("/etc/notes.txt"), true);
});

test("mentions, scoped packages and aliases are not broken imports", () => {
  assert.equal(missingIsError("Override"), false);
  assert.equal(missingIsError("someone"), false);
  assert.equal(missingIsError("types/node"), false); // @types/node
  assert.equal(missingIsError("angular/core"), false);
  assert.equal(missingIsError("/components/Button"), false); // @/components/Button
  assert.equal(missingIsError("john.doe"), false); // a handle with a dot
});

test("a folder import is classified as a folder", () => {
  const s = sandbox({ "docs/a.md": "x\n" });
  assert.equal(classifyImport("./docs", s.dir, s.home).status, "folder");
  assert.equal(classifyImport("docs/", s.dir, s.home).status, "folder");
});

test("the nesting limit is five levels", () => {
  assert.equal(MAX_IMPORT_DEPTH, 5);
});
