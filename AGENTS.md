# White-Box Skill Graph Platform — Agent & Engineering Rules

This repository hosts the White-Box Composable Skill Graph, deterministic Defect Knowledge Graph compiler, local MCP stdio server, and reproducible thesis/IEEE empirical evaluation suite.

## Mandatory rules

1. Do not change a knowledge or skill schema without updating its positive and negative fixtures and tests.
2. Do not add free-form enum values. Extend the relevant schema and tests deliberately.
3. Never add credentials, API keys (`sk-or-*`), private tokens, production logs, personal data, or full source-code bodies to `knowledge/`, `skills/`, `docs/`, or fixtures.
4. Never hand-edit or commit files under `build/` or `runtime/`; they are deterministic generated outputs or ephemeral local sandboxes.
5. Do not weaken validation for a `CONFIRMED` bug merely to make a fixture or build pass.
6. Generated nodes, edges, error ordering, source digests, figures, and exported tables must be deterministic for identical input.
7. Validators must not resolve remote schema references or fetch any `sourceRef` URI.
8. Keep AI/heuristic and `DRAFT` observations strictly distinguishable from human-reviewed `CONFIRMED` and enforced knowledge.

## Required verification

Run these commands before reporting completion:

```text
npm ci
npm run typecheck
npm test
npm run knowledge:validate
npm run knowledge:build
```
