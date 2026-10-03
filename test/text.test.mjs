import "./helpers.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { isTrue, parseFrontmatter } from "../src/frontmatter.mjs";
import { clip, closest, contentWords, distance, jaccard, normalize, plural, SimilarityIndex, slugify, stem, wordsOf } from "../src/text.mjs";

// ---------------------------------------------------------------- normalizing and comparing

test("normalize lowercases and drops markdown, punctuation and apostrophes", () => {
  assert.equal(normalize("**Always** run `npm test`, don't skip it!"), "always run npm test dont skip it");
  assert.equal(normalize("See [the docs](docs/a.md) or ![img](x.png)."), "see the docs or img");
  assert.equal(normalize("a <b>bold</b> move"), "a bold move");
  assert.equal(normalize("snake_case and kebab-case"), "snake case and kebab case");
});

test("wordsOf splits a normalized line into words", () => {
  assert.deepEqual(wordsOf("  Use TWO   spaces. "), ["use", "two", "spaces"]);
  assert.deepEqual(wordsOf(""), []);
});

test("jaccard is 1 for equal sets, 0 for disjoint ones, and symmetric", () => {
  const a = new Set(["a", "b", "c"]);
  const b = new Set(["b", "c", "d"]);
  assert.equal(jaccard(a, a), 1);
  assert.equal(jaccard(a, new Set(["x"])), 0);
  assert.equal(jaccard(a, b), 0.5);
  assert.equal(jaccard(b, a), 0.5);
  assert.equal(jaccard(new Set(), new Set()), 1);
});

test("the stemmer matches the forms of one word", () => {
  for (const group of [["commit", "commits", "committing", "committed"], ["use", "uses", "using", "used"], ["change", "changes", "changing", "changed"], ["run", "runs", "running"], ["file", "files"], ["policy", "policies"]]) {
    assert.equal(new Set(group.map(stem)).size, 1, group.join(","));
  }
  assert.notEqual(stem("test"), stem("tent"));
  assert.equal(stem("add"), stem("adding"));
});

test("contentWords drops stop words and stems the rest", () => {
  assert.deepEqual(contentWords("Always use the semicolons in this repository"), ["alway", "us", "semicolon", "repository"]);
});

test("slugify makes short lowercase names", () => {
  assert.equal(slugify("Release process"), "release-process");
  assert.equal(slugify("**Deploy**: staging & prod!"), "deploy-staging-prod");
  assert.equal(slugify("  Café au lait  "), "cafe-au-lait");
  assert.equal(slugify(""), "");
  assert.equal(slugify("!!!"), "");
  const long = slugify("Releasing the production build of the customer facing web application to every region", 40);
  assert.ok(long.length <= 40 && !long.endsWith("-"), long);
});

test("clip shortens to one line with dots", () => {
  assert.equal(clip("a  b\nc", 10), "a b c");
  assert.equal(clip("x".repeat(20), 10), "xxxxxxx...");
  assert.equal(clip("short", 10), "short");
});

test("plural", () => {
  assert.equal(plural(1, "file"), "1 file");
  assert.equal(plural(2, "file"), "2 files");
  assert.equal(plural(1500, "token"), "1,500 tokens");
  assert.equal(plural(0, "agent"), "0 agents");
});

test("distance and closest find near misses", () => {
  assert.equal(distance("test", "test"), 0);
  assert.equal(distance("tets", "test"), 2);
  assert.equal(distance("lint", "list"), 1);
  assert.equal(closest("tets", ["build", "test", "lint"]), "test");
  assert.equal(closest("deploy", ["build", "test"]), null);
  assert.equal(closest("TEST", ["test"]), "test");
});

// ---------------------------------------------------------------- the similarity index

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

for (const threshold of [0.5, 0.85]) {
  test(`SimilarityIndex finds every pair at Jaccard ${threshold} or more that brute force finds`, () => {
    const r = rng(42);
    const vocab = Array.from({ length: 60 }, (_, i) => `w${i}`);
    const sets = [];
    for (let i = 0; i < 300; i++) {
      // many sets are variations of an earlier one, so there are plenty of similar pairs
      if (i > 10 && r() < 0.5) {
        const base = [...sets[Math.floor(r() * sets.length)]];
        const copy = new Set(base);
        for (let k = 0; k < Math.floor(r() * 4); k++) { copy.delete(base[Math.floor(r() * base.length)]); copy.add(vocab[Math.floor(r() * vocab.length)]); }
        sets.push(copy.size ? copy : new Set(["w1"]));
      } else {
        const size = 3 + Math.floor(r() * 20);
        const s = new Set();
        while (s.size < size) s.add(vocab[Math.floor(r() * vocab.length)]);
        sets.push(s);
      }
    }
    const index = new SimilarityIndex(sets, threshold);
    let pairs = 0;
    sets.forEach((s, j) => {
      const found = new Set(index.candidates(s));
      for (let i = 0; i < j; i++) {
        if (jaccard(sets[i], s) >= threshold) {
          pairs++;
          assert.ok(found.has(i), `pair ${i}, ${j} at ${jaccard(sets[i], s).toFixed(2)} was missed`);
        }
      }
      index.add(j, s);
    });
    assert.ok(pairs > 50, `only ${pairs} similar pairs in the data`);
  });
}

test("SimilarityIndex candidates come back in ascending order and only for earlier sets", () => {
  const sets = [new Set(["a", "b", "c"]), new Set(["a", "b", "c"]), new Set(["x", "y", "z"])];
  const index = new SimilarityIndex(sets, 0.85);
  index.add(0, sets[0]);
  assert.deepEqual(index.candidates(sets[1]), [0]);
  index.add(1, sets[1]);
  assert.deepEqual(index.candidates(sets[1]), [0, 1]);
  assert.deepEqual(index.candidates(sets[2]), []);
});

// ---------------------------------------------------------------- front matter

test("front matter: plain, quoted, folded and literal values", () => {
  const fm = parseFrontmatter(`---
name: deploy
description: "Deploy the app: staging or production."
other: 'single'
folded: >
  one
  two
literal: |
  line one
  line two
---
body
`);
  assert.equal(fm.name, "deploy");
  assert.equal(fm.description, "Deploy the app: staging or production.");
  assert.equal(fm.other, "single");
  assert.equal(fm.folded, "one two");
  assert.equal(fm.literal, "line one line two");
});

test("front matter: CRLF, a BOM, and no front matter at all", () => {
  assert.equal(parseFrontmatter("﻿---\r\nname: x\r\n---\r\nbody\r\n").name, "x");
  assert.deepEqual(parseFrontmatter("# Just a heading\n"), {});
  assert.deepEqual(parseFrontmatter(""), {});
  assert.deepEqual(parseFrontmatter(undefined), {});
  assert.deepEqual(parseFrontmatter("---\nname: never closed\n"), {});
});

test("isTrue reads the usual spellings of true", () => {
  for (const v of ["true", "True", "TRUE", "yes", "on", " true "]) assert.equal(isTrue(v), true, v);
  for (const v of ["false", "no", "", undefined, null, "0", "truthy"]) assert.equal(isTrue(v), false, String(v));
});
