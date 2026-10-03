---
name: md-doctor
description: Audit CLAUDE.md token cost and waste.
disable-model-invocation: true
allowed-tools: Bash(node *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/claude-md-doctor.mjs" "${CLAUDE_PROJECT_DIR}" --markdown --budget 2000`

In at most 8 lines: the fixes that save the most tokens, each with the change to make; edit nothing until the user agrees.
