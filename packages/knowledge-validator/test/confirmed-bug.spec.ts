import { describe, expect, it } from "vitest";

import { loadRegistry, validateRegistry } from "../src/index.js";
import { diagnosticsText, materializeFixture } from "./test-helpers.js";

describe("confirmed bug policy", () => {
  it("requires confirmed root-cause analysis instead of placeholders", async () => {
    const fixture = await materializeFixture("confirmed-bug-missing-rca");
    try {
      const result = validateRegistry(await loadRegistry(fixture.root), {
        asOf: "2026-01-15",
      });

      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/CONFIRMED_BUG_INCOMPLETE/i);
      expect(diagnosticsText(result.errors)).toMatch(
        /directCause|enablingCondition|escapeReason/i,
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("requires an active regression guardrail or an approved exception", async () => {
    const fixture = await materializeFixture("confirmed-bug-missing-guardrail");
    try {
      const result = validateRegistry(await loadRegistry(fixture.root), {
        asOf: "2026-01-15",
      });

      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/CONFIRMED_BUG_INCOMPLETE/i);
      expect(diagnosticsText(result.errors)).toMatch(/guardrail|exception/i);
    } finally {
      await fixture.dispose();
    }
  });

  it("requires sibling analysis to be completed or explicitly not applicable", async () => {
    const fixture = await materializeFixture(
      "confirmed-bug-pending-sibling-scan",
    );
    try {
      const result = validateRegistry(await loadRegistry(fixture.root), {
        asOf: "2026-01-15",
      });

      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/CONFIRMED_BUG_INCOMPLETE/i);
      expect(diagnosticsText(result.errors)).toMatch(/sibling|PENDING/i);
    } finally {
      await fixture.dispose();
    }
  });

  it("uses the supplied as-of date when rejecting an expired exception", async () => {
    const fixture = await materializeFixture("expired-exception");
    try {
      const result = validateRegistry(await loadRegistry(fixture.root), {
        asOf: "2026-01-15",
      });

      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(
        /EXPIRED_GUARDRAIL_EXCEPTION/i,
      );
      expect(diagnosticsText(result.errors)).toMatch(/2025-12-31/);
    } finally {
      await fixture.dispose();
    }
  });
});
