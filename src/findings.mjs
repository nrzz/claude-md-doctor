// What a finding looks like, and how severe each kind is. One place, so changing a severity is
// a one-line edit.

export const SEVERITY = {
  "over-budget": "error",
  "import-error": "error",
  "stale-path": "warn",
  "stale-command": "warn",
  duplicate: "warn",
  conflict: "warn",
  "move-to-skill": "warn",
  "big-code-block": "warn",
  "big-import": "warn",
  "local-not-ignored": "warn",
  filler: "info",
};

export const SEVERITY_RANK = { error: 0, warn: 1, info: 2 };

/**
 * A finding.
 *   file, line, endLine  where it is (display path, 1-based lines), or null for a project-wide one
 *   tokens               what the flagged lines cost in every session
 *   saves                what the proposed fix takes out of every session (0 for a correction)
 *   message, fix         what is wrong, and the concrete change to make
 *   autofix              true when --fix writes this change into the proposal
 *   detail               check-specific data, kept in the JSON output
 */
export function makeFinding(id, fields) {
  return {
    id,
    severity: SEVERITY[id],
    file: null,
    line: null,
    endLine: null,
    tokens: 0,
    saves: 0,
    message: "",
    fix: "",
    autofix: false,
    detail: {},
    ...fields,
  };
}

// Plain code-unit comparison, so the order is the same on every machine and locale.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Errors first, then warnings, then notes; biggest saving first; then file and line. */
export function sortFindings(list) {
  const first = (x) => (x.id === "over-budget" ? 0 : 1); // the headline problem leads
  return [...list].sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || first(a) - first(b)
    || b.saves - a.saves
    || cmp(String(a.file ?? ""), String(b.file ?? ""))
    || (a.line ?? 0) - (b.line ?? 0)
    || cmp(a.id, b.id)
    || cmp(a.message, b.message));
}
