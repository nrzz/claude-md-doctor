#!/usr/bin/env node
// claude-md-doctor: measure what CLAUDE.md files cost in every session, find what is stale,
// duplicated or better placed in a skill, and write a leaner version.
// All the work lives in src/cli.mjs; run `claude-md-doctor --help` for the options.
import { main } from "../src/cli.mjs";

process.exitCode = await main(process.argv.slice(2));
