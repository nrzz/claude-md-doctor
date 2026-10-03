import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { of, sandbox } from "./helpers.mjs";

// A project with a few real files, so a path can be told from one that is gone.
function project(claude, extra = {}) {
  return sandbox({
    "CLAUDE.md": claude,
    "src/real.ts": "export {};\n",
    "docs/a.md": "# A\n",
    "scripts/x.sh": "echo hi\n",
    "package.json": JSON.stringify({ scripts: { build: "tsc", test: "node --test", "test:unit": "node --test unit", lint: "eslint ." } }),
    ...extra,
  });
}
const stale = (s, id = "stale-path") => of(s.analyze(), id);
const messages = (list) => list.map((f) => f.message);

// ---------------------------------------------------------------- stale-path: true positives

test("a backticked path that does not exist is stale", () => {
  const s = project("See `src/foo.ts` for the entry point.\n");
  const [f] = stale(s);
  assert.equal(f.severity, "warn");
  assert.equal(f.file, "CLAUDE.md");
  assert.equal(f.line, 1);
  assert.match(f.message, /`src\/foo\.ts` does not exist/);
});

test("the same path is fine once the file exists", () => {
  const s = project("See `src/real.ts` and `./scripts/x.sh` and `docs/a.md`.\n");
  assert.deepEqual(stale(s), []);
});

test("a ./ path with an extension in plain text is stale when missing", () => {
  const s = project("Run ./scripts/missing.sh first.\n");
  assert.match(stale(s)[0].message, /\.\/scripts\/missing\.sh/);
});

test("plain-text paths with an extension are checked", () => {
  const s = project("The docs live in docs/gone.md and docs/a.md.\n");
  assert.deepEqual(messages(stale(s)), ["`docs/gone.md` does not exist"]);
});

test("Windows-style paths are checked, and shown as the author wrote them", () => {
  const s = project("Open `src\\gone\\foo.ts` or .\\scripts\\gone.ps1 or docs\\a.md.\n");
  const [f] = stale(s);
  assert.match(f.message, /`src\\gone\\foo\.ts`/);
  assert.match(f.message, /`\.\\scripts\\gone\.ps1`/);
  assert.doesNotMatch(f.message, /docs/);
});

test("Windows-style paths that exist are fine", () => {
  const s = project("Open `src\\real.ts` and .\\scripts\\x.sh.\n");
  assert.deepEqual(stale(s), []);
});

test("a markdown link to a missing file is stale", () => {
  const s = project("Read the [guide](docs/nope.md) and the [api](docs/a.md#top).\n");
  assert.deepEqual(messages(stale(s)), ["`docs/nope.md` does not exist"]);
});

test("a trailing-slash directory in plain text or backticks is checked", () => {
  const s = project("Old code is in src/legacy/ and also `src/old/`; the `src/` folder is fine.\n");
  assert.deepEqual(messages(stale(s)), ["`src/legacy/`, `src/old/` do not exist"]);
});

test("a backticked path with no extension is checked when it is the whole span", () => {
  const s = project("Look in `src/legacy` and `docs`.\n");
  assert.deepEqual(messages(stale(s)), ["`src/legacy` does not exist"]);
});

test("a path under an existing folder is checked even without an extension", () => {
  const s = project("Run `cd src/missing` then build.\n");
  assert.deepEqual(messages(stale(s)), ["`src/missing` does not exist"]);
});

test("file:line suffixes are stripped before checking", () => {
  const s = project("Bug at src/real.ts:12 and src/gone.ts:40:3.\n");
  assert.deepEqual(messages(stale(s)), ["`src/gone.ts` does not exist"]);
});

test("paths relative to the file's own folder count as existing", () => {
  const s = project("@docs/guide.md\n", { "docs/guide.md": "See `sibling.md` and `missing-sibling.md`.\n", "docs/sibling.md": "x\n" });
  const found = stale(s);
  assert.equal(found.length, 0, "bare names are not judged"); // no folder part: only reported when they exist
  const t = project("@docs/guide.md\n", { "docs/guide.md": "See `./sibling.md` and `./missing-sibling.md`.\n", "docs/sibling.md": "x\n" });
  assert.deepEqual(messages(stale(t)), ["`./missing-sibling.md` does not exist"]);
  assert.equal(stale(t)[0].file, "docs/guide.md");
});

test("a stale path in an imported file is reported against that file", () => {
  const s = project("@docs/b.md\n", { "docs/b.md": "Uses `lib/gone/util.ts`.\n" });
  const [f] = stale(s);
  assert.equal(f.file, "docs/b.md");
  assert.equal(f.line, 1);
});

test("a stale path inside a shell code block is reported", () => {
  const s = project("```bash\nnode scripts/missing.mjs --flag\nnode scripts/x.sh\n```\n");
  const found = stale(s);
  assert.deepEqual(messages(found), ["`scripts/missing.mjs` does not exist"]);
  assert.equal(found[0].line, 2);
});

test("a hint names a file with the same name elsewhere", () => {
  const s = project("Auth lives in `src/old/auth.ts`.\n", { "src/auth/auth.ts": "export {};\n" });
  const [f] = stale(s);
  assert.deepEqual(f.detail.moved, ["src/auth/auth.ts"]);
  assert.match(f.fix, /exists at `src\/auth\/auth\.ts`/);
});

test("a stale path costs the tokens of its line, and removing the line saves them", () => {
  const s = project("# Notes\n\n- Auth lives in `src/old/auth.ts`.\n- Keep it small.\n");
  const [f] = stale(s);
  assert.ok(f.tokens > 5);
  assert.equal(f.saves, f.tokens);
  assert.equal(f.autofix, true);
});

test("a stale path inside a long sentence is reported but its line is not removed", () => {
  const long = "The service configuration is described at length in the handbook and in `docs/gone.md`, which every engineer should read before changing anything about how it behaves in production, how it scales under load, how it fails over between regions, and what the on-call rotation expects from them afterwards.";
  const s = project(`${long}\n`);
  const [f] = stale(s);
  assert.equal(f.saves, 0);
  assert.equal(f.autofix, false);
});

// ---------------------------------------------------------------- stale-path: false-positive guards

const fine = (name, line) =>
  test(`not a stale path: ${name}`, () => {
    const s = project(`${line}\n`);
    assert.deepEqual(messages(stale(s)), []);
  });

fine("a URL", "See https://github.com/nrzz/claude-md-doctor/blob/main/src/x.ts for it.");
fine("a domain without a scheme", "Mirror at github.com/nrzz/foo and example.com/docs/a.md.");
fine("a glob", "Matches `src/**/*.ts` and src/*.test.ts and `docs/?.md` and `src/[ab].ts`.");
fine("a <placeholder>", "Replace `<file>/x.ts` or <dir>/y.md with yours.");
fine("a ${VAR} or $VAR", "Set ${HOME}/x.sh and $HOME/y.sh and %USERPROFILE%/z.txt.");
fine("path/to/ and your-project/", "Use path/to/file.ts or `your-project/src/app.ts`.");
fine("a line marked as an example (e.g.)", "Name files clearly (e.g. `src/missing/Button.tsx`).");
fine("a line marked as an example (for example)", "For example, `src/missing/Button.tsx` is a component.");
fine("a line marked as an example (such as)", "Config such as docs/missing.yml goes here.");
fine("prose with slashes", "Use and/or, read/write, client/server, input/output, TCP/IP and CI/CD.");
fine("dates and fractions", "Released 10/20/2026, a ratio of 1/2, versions v1.2/v2.0.");
fine("build output that may not be built yet", "Output goes to `dist/bundle.js`, `build/app.js` and coverage/index.html.");
fine("a path inside node_modules", "Read node_modules/pkg/index.js for the source.");
fine("an e-mail address or scoped package", "Mail a@b.com or install @scope/pkg.");
fine("an absolute path outside the project", "Config is at /usr/local/etc/tool.conf and /var/log/app.log.");
fine("a Windows absolute path with spaces", "Installed in C:\\Program Files\\Tool\\bin\\tool.exe and C:\\Users\\Me\\notes.txt.");
fine("a home-relative path in a shared file", "Settings are in ~/.config/tool/settings.json.");
fine("a path that leaves the project", "The sibling repo is at ../other-repo/README.md.");
fine("version-like and dotted names", "Node.js/npm, Next.js/React and 2.1.286/linux.");
fine("e.g./i.e.", "Common abbreviations such as e.g./i.e. appear.");
fine("a bare file name with no folder", "Edit `config.json` and README.md and Makefile.");

test("everything inside an Examples section is skipped", () => {
  const s = project("## Examples\n\nSee `src/missing/a.ts` and docs/missing/b.md.\n\n## Real\n\nSee `src/missing/c.ts`.\n");
  assert.deepEqual(messages(stale(s)), ["`src/missing/c.ts` does not exist"]);
});

test("paths inside comments and non-shell code blocks are not checked", () => {
  const s = project("<!-- see src/missing/a.ts -->\n\n```json\n{ \"main\": \"src/missing/b.ts\" }\n```\n\n```\nsrc/\n  missing/c.ts\n```\n");
  assert.deepEqual(stale(s), []);
});

test("a path that exists only in the user's home is checked in the user memory, not in shared files", () => {
  const s = project("Notes in ~/missing-notes/a.md.\n");
  assert.deepEqual(stale(s), []);
  s.cfgFile("CLAUDE.md", "My notes are in ~/missing-notes/a.md and ~/notes/here.md.\n");
  s.homeFile("notes/here.md", "x\n");
  const found = stale(s);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /~\/missing-notes\/a\.md/);
  assert.equal(found[0].file.endsWith("CLAUDE.md"), true);
});

test("relative paths in the user memory are not judged: they mean a different project each time", () => {
  const s = project("# x\n");
  s.cfgFile("CLAUDE.md", "Look in `src/never/exists.ts` of every repo.\n");
  assert.deepEqual(stale(s), []);
});

// ---------------------------------------------------------------- stale-command: true positives

test("npm run with a script that is not in package.json", () => {
  const s = project("Run `npm run deploy` to ship.\n");
  const [f] = stale(s, "stale-command");
  assert.equal(f.severity, "warn");
  assert.match(f.message, /package\.json has no "deploy" script \(it has: build, lint, test, test:unit\)/);
  assert.equal(f.detail.name, "deploy");
});

test("npm run in plain prose is checked too", () => {
  const s = project("Run npm run deploy to ship.\n");
  assert.equal(stale(s, "stale-command").length, 1);
});

test("pnpm, yarn and bun are checked", () => {
  const s = project("`pnpm run nope`, `yarn nope`, `pnpm nope2`, `bun run nope3`.\n");
  assert.deepEqual(stale(s, "stale-command").map((f) => f.detail.name).sort(), ["nope", "nope", "nope2", "nope3"]);
});

test("a near miss suggests the real script", () => {
  const s = project("Use `npm run tets`.\n");
  const [f] = stale(s, "stale-command");
  assert.equal(f.detail.suggestion, "test");
  assert.match(f.fix, /npm run test/);
});

test("npm test is stale when there is no test script", () => {
  const s = project("Run `npm test`.\n", { "package.json": JSON.stringify({ scripts: { build: "x" } }) });
  assert.equal(stale(s, "stale-command").length, 1);
});

test("scripts with colons and arguments are matched by name", () => {
  const s = project("`npm run test:unit -- --watch` and `npm run test:e2e`.\n");
  assert.deepEqual(stale(s, "stale-command").map((f) => f.detail.name), ["test:e2e"]);
});

test("make with a target that is not in the Makefile", () => {
  const s = project("Use `make deploy` and `make build`.\n", { "Makefile": ".PHONY: build test\nbuild:\n\techo b\ntest:\n\techo t\n" });
  assert.deepEqual(stale(s, "stale-command").map((f) => f.detail.name), ["deploy"]);
});

test("make without any Makefile is stale", () => {
  const s = project("Run `make all`.\n");
  const [f] = stale(s, "stale-command");
  assert.match(f.message, /there is no Makefile/);
});

test("just with a recipe that is not in the justfile", () => {
  const s = project("`just ship` and `just build`.\n", { "justfile": "build:\n  echo b\n\nalias b := build\n" });
  assert.deepEqual(stale(s, "stale-command").map((f) => f.detail.name), ["ship"]);
});

test("just without a justfile is stale", () => {
  const s = project("Run `just build`.\n");
  assert.match(stale(s, "stale-command")[0].message, /there is no justfile/);
});

test("dotnet test with a project path that does not exist", () => {
  const s = project("`dotnet test tests/App.Tests/App.Tests.csproj` and `dotnet test src/real.ts`.\n");
  const found = stale(s, "stale-command");
  assert.equal(found.length, 1);
  assert.match(found[0].message, /tests\/App\.Tests\/App\.Tests\.csproj does not exist/);
  assert.deepEqual(stale(s), [], "the missing path is reported once, by the command");
});

test("dotnet test with an existing project is fine", () => {
  const s = project("`dotnet test tests/App.Tests`\n", { "tests/App.Tests/App.Tests.csproj": "<Project/>\n" });
  assert.deepEqual(stale(s, "stale-command"), []);
});

test("commands in a shell code block are checked, one finding per line", () => {
  const s = project("```bash\nnpm run build\nnpm run deploy\nmake missing\n```\n", { Makefile: "build:\n\techo\n" });
  assert.deepEqual(stale(s, "stale-command").map((f) => [f.line, f.detail.name]), [[3, "deploy"], [4, "missing"]]);
});

test("a prompt and chained commands are understood", () => {
  const s = project("`$ npm run build && npm run deploy` and `npm test; npm run nope`.\n");
  assert.deepEqual(stale(s, "stale-command").map((f) => f.detail.name).sort(), ["deploy", "nope"]);
});

test("cd into a folder changes which package.json is used", () => {
  const s = project("```bash\ncd web\nnpm run dev\nnpm run build\n```\n", { "web/package.json": JSON.stringify({ scripts: { dev: "vite" } }) });
  // build exists in the root package.json, dev only in web/: the second command is judged in web/
  assert.deepEqual(stale(s, "stale-command").map((f) => f.detail.name), []);
});

// ---------------------------------------------------------------- stale-command: false-positive guards

const okCmd = (name, line, extra) =>
  test(`not a stale command: ${name}`, () => {
    const s = project(`${line}\n`, extra);
    assert.deepEqual(stale(s, "stale-command").map((f) => f.message), []);
  });

okCmd("scripts that exist", "`npm run build`, `npm test`, `npm run lint`, `pnpm test`, `yarn build`, `bun run lint`.");
okCmd("workspace and prefix flags", "`npm run build --workspace=web`, `npm --prefix web run dev`, `pnpm --filter web build`, `pnpm -r build`.");
okCmd("a script that only exists in another package", "`npm run dev` and `yarn workspace web start`.", { "web/package.json": JSON.stringify({ scripts: { dev: "x", start: "y" } }) });
okCmd("--if-present", "`npm run missing --if-present`.");
okCmd("placeholders", "`npm run <script>`, `npm run $NAME`, `npm run {name}`, `npm run x`.");
okCmd("the package manager's own commands", "`pnpm install`, `pnpm add x`, `pnpm dlx x`, `yarn install`, `yarn add x`, `npm install`, `npm ci`, `bun install`, `bun test`.");
okCmd("installed tools run through yarn, pnpm or bun", "`yarn tsc`, `pnpm eslint .`, `bun run vitest`.");
okCmd("a tool that is a dependency", "`pnpm mytool run`.", { "package.json": JSON.stringify({ scripts: {}, devDependencies: { mytool: "1" } }) });
okCmd("bun run with a file", "`bun run src/index.ts` and `bun run index.js`.");
okCmd("prose that merely mentions a package manager", "Use pnpm instead of npm and yarn. We use yarn workspaces. Run it via npm.");
okCmd("make with flags that change the folder", "`make -C sub build` and `make -f other.mk deploy`.");
okCmd("a Makefile that includes others", "`make anything`.", { Makefile: "include common.mk\nbuild:\n\techo\n" });
okCmd("make for a file that exists", "`make src/real.ts`.", { Makefile: "build:\n\techo\n" });
okCmd("just with flags", "`just --list` and `just -f other deploy`.");
okCmd("a justfile with imports", "`just anything`.", { justfile: "import 'common.just'\nbuild:\n  echo\n" });
okCmd("dotnet commands without a path", "`dotnet test`, `dotnet build`, `dotnet run`, `dotnet restore`.");
okCmd("dotnet with options first", "`dotnet test --no-build` and `dotnet build -c Release`.");

test("without any package.json there is nothing to compare npm commands with", () => {
  const s = sandbox({ "CLAUDE.md": "Run `npm run build`.\n" });
  assert.deepEqual(stale(s, "stale-command"), []);
});

test("a cd into a folder that does not exist skips the commands after it", () => {
  const s = project("```bash\ncd nowhere\nnpm run missing\n```\n");
  assert.deepEqual(stale(s, "stale-command"), []);
});

test("a package.json that is not valid JSON does not crash anything", () => {
  const s = project("Run `npm run build`.\n", { "package.json": "{ not json" });
  assert.deepEqual(stale(s, "stale-command"), []);
});

// ---------------------------------------------------------------- removal rules for --fix

test("a line is removable only when everything concrete on it is stale", () => {
  const s = project("- See `src/gone.ts` and `src/real.ts`.\n- See `src/gone2.ts`.\n");
  const found = stale(s);
  const mixed = found.find((f) => f.line === 1);
  const only = found.find((f) => f.line === 2);
  assert.equal(mixed.autofix, false);
  assert.equal(mixed.saves, 0);
  assert.equal(only.autofix, true);
});

test("a line with an import is never removable", () => {
  const s = project("- Docs in `src/gone.ts` and @docs/a.md\n");
  assert.equal(stale(s)[0].autofix, false);
});

test("a wrapped bullet gives one finding", () => {
  const s = project("- Start with `src/gone.ts`, which\n  explains `src/gone2.ts` too.\n");
  const found = stale(s);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 1);
  assert.equal(found[0].endLine, 2);
  assert.match(found[0].message, /`src\/gone\.ts`, `src\/gone2\.ts` do not exist/);
});

test("a stale command in the user memory is reported but never auto-fixed", () => {
  const s = project("# x\n");
  s.cfgFile("CLAUDE.md", "- Run `npm run nope` always.\n");
  const [f] = stale(s, "stale-command");
  assert.equal(f.autofix, false);
});

test("stale references in CLAUDE.local.md are found", () => {
  const s = project("# x\n", { "CLAUDE.local.md": "- My scratch file is `notes/gone.md`.\n" });
  const [f] = stale(s);
  assert.equal(f.file, "CLAUDE.local.md");
});

test("nothing is reported when everything exists", () => {
  const s = project("# Setup\n\n- Run `npm run build` then `npm test`.\n- Code is in `src/real.ts`; docs in docs/a.md; scripts in ./scripts/x.sh.\n");
  assert.deepEqual(s.analyze().findings, []);
});

test("an empty project folder name with odd characters still works", () => {
  const s = project("See `src/gone.ts`.\n");
  const odd = path.join(s.base, "my project (v2)");
  fs.mkdirSync(path.join(odd, "src"), { recursive: true });
  fs.writeFileSync(path.join(odd, "CLAUDE.md"), "See `src/gone.ts` and `src/here.ts`.\n");
  fs.writeFileSync(path.join(odd, "src", "here.ts"), "x\n");
  const m = s.analyze({ dir: odd });
  assert.deepEqual(messages(of(m, "stale-path")), ["`src/gone.ts` does not exist"]);
});

// ---------------------------------------------------------------- links to bare file names, and how long a removable line may be

test("a markdown link to a missing file with no folder is stale", () => {
  const s = project("See [contributing](CONTRIBUTING.md) and [the docs](docs/a.md) and [home](README.md).\n", { "README.md": "x\n" });
  assert.deepEqual(messages(stale(s)), ["`CONTRIBUTING.md` does not exist"]);
});

test("links that are not files are left alone: anchors, mail, domains and page names", () => {
  const s = project("See [a](#section), [b](mailto:a@b.co), [c](example.com), [d](page), [e](https://x.org/y.md), [f](docs/a.md#top).\n");
  assert.deepEqual(stale(s), []);
});

test("a stale line is removable up to 16 words, and reported only beyond that", () => {
  const short = "- Notes for the old module are kept in `docs/gone.md` (see the wiki).";
  const long = "- If it is a security release you must also email every customer listed in `docs/gone-contacts.md` on the same day.";
  const s = project(`${short}\n${long}\n`);
  const found = stale(s);
  assert.equal(found.find((f) => f.line === 1).autofix, true);
  const second = found.find((f) => f.line === 2);
  assert.equal(second.autofix, false);
  assert.equal(second.saves, 0);
  assert.match(second.fix, /^Remove or correct the path/);
});
