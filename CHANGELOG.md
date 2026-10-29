# Changelog

All notable changes to claude-md-doctor are written here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-10-29

- `stale-command` checks Python task runners against `pyproject.toml`: `pdm run x` (`[tool.pdm.scripts]`), `hatch run x` and `hatch run env:x` (`[tool.hatch.envs.<env>.scripts]`, with the scripts a Hatch environment inherits from its `template`) and `poe x` (`[tool.poe.tasks]`). It stays silent for `python`, `pip`, a dependency of the project and an executable in `.venv` (`pdm run pytest`), for matrix environments, and for tasks it cannot read; scripts written as inline tables are read.
- Contributed by [@yoreva-01](https://github.com/yoreva-01) in [#4](https://github.com/nrzz/claude-md-doctor/pull/4), for the good first issue [#3](https://github.com/nrzz/claude-md-doctor/issues/3).
- The README's test count is the runner's again: 518 automated tests (519 with the one helper file), one skipped on Windows. It had said 488.

## [1.0.2] - 2026-10-04

- The skill pre-approves only md-doctor's own command (`node ${CLAUDE_PLUGIN_ROOT}/bin/claude-md-doctor.mjs ...`) instead of any `node` command.
- An icon for the plugin's listing in Anthropic's plugin directory, and the listing's links in `plugin.json`: documentation, support, privacy and terms.
- README: a Privacy section (what it reads, what it writes, and that it sends nothing anywhere).

## [1.0.1] - 2026-10-04

- `filler`: on a line of up to 8 words the phrase must now be at least half of it, so a short rule with real content such as "Be careful with database migrations" is no longer flagged, nor dropped by `--fix`.
- README: the skill report's real size, how procedure sections are detected and the report's exact wording, and Node 18 in CI.

## [1.0.0] - 2026-10-04

- First release: the load tree and the tokens of every memory file, stale paths and commands, duplicates, conflicts, procedures better as skills, big code blocks and imports, filler, an ignored CLAUDE.local.md; `--fix`, `--write`, `--ci`, `--json`, `--markdown`; a plugin.
- Fixed: build-output folders are judged from the project root, so missing paths under `/tmp` are no longer ignored on Linux (caught by CI); a rule scoped to some files ("4 spaces in Python files") is no longer a conflict.

[1.1.0]: https://github.com/nrzz/claude-md-doctor/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/nrzz/claude-md-doctor/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/nrzz/claude-md-doctor/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/nrzz/claude-md-doctor/releases/tag/v1.0.0
