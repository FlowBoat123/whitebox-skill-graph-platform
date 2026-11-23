import { describe, expect, it } from "vitest";

import { loadRegistry, runCli, validateRegistry } from "../src/index.js";
import { diagnosticsText, materializeFixture } from "./test-helpers.js";

describe("safe YAML loading", () => {
  it("rejects YAML custom tags without executing or materializing them", async () => {
    const fixture = await materializeFixture("malicious-yaml");
    try {
      const registry = await loadRegistry(fixture.root);
      const result = validateRegistry(registry, { asOf: "2026-01-15" });

      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(
        /YAML_SECURITY_ERROR|custom tag|tag/i,
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects excessive YAML alias expansion", async () => {
    const fixture = await materializeFixture("malicious-alias");
    try {
      const registry = await loadRegistry(fixture.root);
      const result = validateRegistry(registry, { asOf: "2026-01-15" });

      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(
        /YAML_SECURITY_ERROR|alias|aliases/i,
      );
    } finally {
      await fixture.dispose();
    }
  });
});

describe("CLI contract", () => {
  it("returns 0 and machine-readable counts for a valid registry", async () => {
    const fixture = await materializeFixture("valid-registry");
    try {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runCli(
        [
          "validate",
          "--root",
          fixture.root,
          "--as-of",
          "2026-01-15",
          "--json",
        ],
        {
          stdout: (value) => stdout.push(value),
          stderr: (value) => stderr.push(value),
        },
      );

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      expect(JSON.parse(stdout.join("\n"))).toEqual(
        expect.objectContaining({
          valid: true,
          counts: expect.objectContaining({ bugs: 1 }),
        }),
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("returns 1 and all diagnostics for an invalid registry", async () => {
    const fixture = await materializeFixture("missing-reference");
    try {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runCli(
        [
          "validate",
          "--root",
          fixture.root,
          "--as-of",
          "2026-01-15",
        ],
        {
          stdout: (value) => stdout.push(value),
          stderr: (value) => stderr.push(value),
        },
      );

      expect(exitCode).toBe(1);
      expect(`${stdout.join("\n")}\n${stderr.join("\n")}`).toMatch(
        /INV-FE-999/,
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("returns 2 for invalid CLI usage", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(["unknown-command"], {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    });

    expect(exitCode).toBe(2);
    expect(stderr.join("\n")).toMatch(/usage|unknown/i);
  });
});

