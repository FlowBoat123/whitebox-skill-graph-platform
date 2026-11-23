import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compileGraph, loadRegistry, validateRegistry } from "../src/index.js";
import { diagnosticsText, materializeFixture } from "./test-helpers.js";

describe("knowledge schema validation", () => {
  it("accepts a complete valid registry", async () => {
    const fixture = await materializeFixture("valid-registry");
    try {
      const registry = await loadRegistry(fixture.root);
      const result = validateRegistry(registry, { asOf: "2026-01-15" });

      expect(result).toEqual(
        expect.objectContaining({
          valid: true,
          errors: [],
          counts: {
            defectFamilies: 1,
            invariants: 1,
            guardrails: 1,
            bugs: 1,
          },
        }),
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects a document that violates its JSON Schema", async () => {
    const fixture = await materializeFixture("invalid-schema");
    try {
      const result = validateRegistry(await loadRegistry(fixture.root), {
        asOf: "2026-01-15",
      });

      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/SCHEMA_VALIDATION_ERROR/i);
      expect(diagnosticsText(result.errors)).toMatch(/MAGIC_AI_CHECK|type/i);
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects malformed stable code-unit identifiers", async () => {
    const fixture = await materializeFixture("invalid-stable-key");
    try {
      const result = validateRegistry(await loadRegistry(fixture.root), {
        asOf: "2026-01-15",
      });

      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(
        /INVALID_STABLE_KEY|affectedCodeUnits|codeUnitId/i,
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects invalid commit and content hashes in source references", async () => {
    const fixture = await materializeFixture("invalid-source-ref");
    try {
      const result = validateRegistry(await loadRegistry(fixture.root), {
        asOf: "2026-01-15",
      });

      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(
        /SCHEMA_VALIDATION_ERROR|commitSha|contentHash/i,
      );
      expect(result.errors.length).toBeGreaterThan(1);
      expect(
        validateRegistry(await loadRegistry(fixture.root), {
          asOf: "2026-01-15",
        }).errors,
      ).toEqual(result.errors);
    } finally {
      await fixture.dispose();
    }
  });

  it("accepts REDMINE_ISSUE and rejects unregistered tracker kinds", async () => {
    const fixture = await materializeFixture("invalid-redmine-kind");
    try {
      const result = validateRegistry(await loadRegistry(fixture.root), { asOf: "2026-01-15" });
      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/REDMINE_TICKET|SCHEMA_VALIDATION_ERROR/iu);
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects YAML files larger than one megabyte before parsing", async () => {
    const fixture = await materializeFixture("valid-registry");
    try {
      const directory = join(fixture.root, "knowledge", "defect-families");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "oversized.yaml"), "x".repeat(1_048_577));

      const result = validateRegistry(await loadRegistry(fixture.root), {
        asOf: "2026-01-15",
      });

      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/LOAD_ERROR/i);
      expect(diagnosticsText(result.errors)).toMatch(/exceeds|1[ ,]?048[ ,]?576/i);
    } finally {
      await fixture.dispose();
    }
  });

  it("accepts :py:, :template: code units and ACTIVE SKILL_GRAPH_VERIFIER guardrails", async () => {
    const fixture = await materializeFixture("valid-multistack-skill-guardrail");
    try {
      const registry = await loadRegistry(fixture.root);
      const result = validateRegistry(registry, { asOf: "2026-01-15" });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.counts).toEqual({
        defectFamilies: 1,
        invariants: 2,
        guardrails: 2,
        bugs: 2,
      });

      const graph = compileGraph(registry, { asOf: "2026-01-15" });
      expect(graph.nodes).toContainEqual(
        expect.objectContaining({
          id: "horilla:py:FILE:base/cbv/department.py#file",
          type: "CODE_UNIT",
        }),
      );
      expect(graph.nodes).toContainEqual(
        expect.objectContaining({
          id: "horilla:template:FILE:horilla_theme/templates/generic/form.html#file",
          type: "CODE_UNIT",
        }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          type: "GUARDED_BY",
          from: "BUG:horilla:5001",
          to: "GRD-HOR-DEPT-001",
        }),
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects path traversal in :py: stable code-unit identifiers", async () => {
    const fixture = await materializeFixture("invalid-py-stable-key");
    try {
      const result = validateRegistry(await loadRegistry(fixture.root), {
        asOf: "2026-01-15",
      });
      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/INVALID_STABLE_KEY/i);
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects unsupported kinds in :template: stable code-unit identifiers", async () => {
    const fixture = await materializeFixture("invalid-template-kind");
    try {
      const result = validateRegistry(await loadRegistry(fixture.root), {
        asOf: "2026-01-15",
      });
      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/SCHEMA_VALIDATION_ERROR|INVALID_STABLE_KEY/i);
    } finally {
      await fixture.dispose();
    }
  });
});
