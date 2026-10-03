# Changelog

All notable changes to claude-md-doctor are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-04

- First release: the load tree and the tokens of every memory file, stale paths and commands, duplicates, conflicts, procedures better as skills, big code blocks and imports, filler, an ignored CLAUDE.local.md; `--fix`, `--write`, `--ci`, `--json`, `--markdown`; a plugin.
- Fixed: build-output folders are judged from the project root, so missing paths under `/tmp` are no longer ignored on Linux (caught by CI); a rule scoped to some files ("4 spaces in Python files") is no longer a conflict.

[1.0.0]: https://github.com/nrzz/claude-md-doctor/releases/tag/v1.0.0
