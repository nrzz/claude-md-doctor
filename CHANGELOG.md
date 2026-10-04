# Changelog

All notable changes to claude-md-doctor are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-10-04

- `filler`: on a line of up to 8 words the phrase must now be at least half of it, so a short rule with real content such as "Be careful with database migrations" is no longer flagged, nor dropped by `--fix`.
- README: the skill report's real size, how procedure sections are detected and the report's exact wording, and Node 18 in CI.

## [1.0.0] - 2026-10-04

- First release: the load tree and the tokens of every memory file, stale paths and commands, duplicates, conflicts, procedures better as skills, big code blocks and imports, filler, an ignored CLAUDE.local.md; `--fix`, `--write`, `--ci`, `--json`, `--markdown`; a plugin.
- Fixed: build-output folders are judged from the project root, so missing paths under `/tmp` are no longer ignored on Linux (caught by CI); a rule scoped to some files ("4 spaces in Python files") is no longer a conflict.

[1.0.1]: https://github.com/nrzz/claude-md-doctor/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/nrzz/claude-md-doctor/releases/tag/v1.0.0
