# Knowledge Registry

This directory is the version-controlled source of confirmed defect knowledge.
The generated graph and the future PostgreSQL database are read models; neither
is edited by hand.

## Layout

- `defect-families/` contains reusable failure mechanisms.
- `invariants/` contains statements that must remain true.
- `guardrails/` maps executable or explicitly manual controls to invariants.
- `bugs/frontend/` and `bugs/backend/` contain reviewed RCA records.

## Workflow

1. Create or update YAML as a draft on a branch.
2. Run `npm run knowledge:validate`.
3. Run `npm run knowledge:build` and `npm test`.
4. Submit a knowledge merge request to the configured code owners.
5. Mark knowledge as confirmed or active only after evidence and human review.

## Identity and confirmation rules

- Bug IDs use `BUG:<projectKey>:<issueIid>` and must exactly match the GitLab
  identity stored under `source`.
- Code-unit IDs use repository-relative POSIX paths. Absolute paths,
  backslashes, whitespace, and `.` or `..` path segments are rejected.
- Evidence nodes use content-addressed `EVD-*` IDs derived from `sourceRefs`.
  A sibling candidate may reference only an evidence ID that exists in the
  registry.
- A `CONFIRMED` bug needs a non-placeholder root-cause analysis, at least one
  affected code unit, a completed (or explained not-applicable) sibling scan,
  a fix merge request, and at least one source reference.
- Its regression guardrail must be `ACTIVE` and enforce an invariant actually
  violated by that bug. Otherwise a complete, unexpired exception is required.
- Every exception date must be a real calendar date and is evaluated against
  the CLI/API `asOf` date.

AI-generated relationships remain proposals. They must not be promoted to
confirmed knowledge without human review, and they must not contain credentials,
PII, full source files, or production logs.

Generated files under `build/` are disposable and must not be edited.
