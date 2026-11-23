import { describe, expect, it } from "vitest";

import { loadRegistry, validateRegistry } from "../src/index.js";
import { diagnosticsText, materializeFixture } from "./test-helpers.js";

describe("cross-document reference validation", () => {
  it("reports duplicate identifiers across files", async () => {
    const fixture = await materializeFixture("duplicate-id");
    try {
      const result = validateRegistry(await loadRegistry(fixture.root), {
        asOf: "2026-01-15",
      });

      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/DUPLICATE_ID/i);
      expect(diagnosticsText(result.errors)).toMatch(/DF-STALE_UI_STATE/);
    } finally {
      await fixture.dispose();
    }
  });

  it("reports references to an invariant that does not exist", async () => {
    const fixture = await materializeFixture("missing-reference");
    try {
      const result = validateRegistry(await loadRegistry(fixture.root), {
        asOf: "2026-01-15",
      });

      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/UNKNOWN_REFERENCE/i);
      expect(diagnosticsText(result.errors)).toMatch(/INV-FE-999/);
    } finally {
      await fixture.dispose();
    }
  });

  it("reports a bug whose defect family does not exist", async () => {
    const fixture = await materializeFixture("missing-family-reference");
    try {
      const result = validateRegistry(await loadRegistry(fixture.root), {
        asOf: "2026-01-15",
      });

      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/UNKNOWN_REFERENCE/i);
      expect(diagnosticsText(result.errors)).toMatch(/DF-NOT_REGISTERED/);
    } finally {
      await fixture.dispose();
    }
  });

  it("reports a bug whose violated invariant does not exist", async () => {
    const fixture = await materializeFixture("missing-invariant-reference");
    try {
      const result = validateRegistry(await loadRegistry(fixture.root), {
        asOf: "2026-01-15",
      });

      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/UNKNOWN_REFERENCE/i);
      expect(diagnosticsText(result.errors)).toMatch(/INV-FE-999/);
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects cycles in the invariant supersedes graph", async () => {
    const fixture = await materializeFixture("cyclic-supersedes");
    try {
      const result = validateRegistry(await loadRegistry(fixture.root), {
        asOf: "2026-01-15",
      });

      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/CYCLIC_SUPERSEDES/i);
      expect(diagnosticsText(result.errors)).toMatch(/INV-FE-002/);
      expect(diagnosticsText(result.errors)).toMatch(/INV-FE-003/);
    } finally {
      await fixture.dispose();
    }
  });
});
