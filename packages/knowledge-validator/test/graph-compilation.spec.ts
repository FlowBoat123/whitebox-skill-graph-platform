import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  compileGraph,
  loadRegistry,
  runCli,
  validateRegistry,
} from "../src/index.js";
import { materializeFixture } from "./test-helpers.js";

describe("deterministic graph compilation", () => {
  it("creates the expected core nodes and relationships", async () => {
    const fixture = await materializeFixture("valid-registry");
    try {
      const registry = await loadRegistry(fixture.root);
      expect(
        validateRegistry(registry, { asOf: "2026-01-15" }).valid,
      ).toBe(true);

      const graph = compileGraph(registry);

      expect(graph.schemaVersion).toBe(1);
      expect(graph.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(graph.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "BUG:frontend:12345", type: "BUG" }),
          expect.objectContaining({
            id: "DF-STALE_UI_STATE",
            type: "DEFECT_FAMILY",
          }),
          expect.objectContaining({ id: "INV-FE-001", type: "INVARIANT" }),
          expect.objectContaining({
            id: "GRD-FE-CRUD-001",
            type: "GUARDRAIL",
          }),
          expect.objectContaining({
            id: "MR:frontend:256:0123456789abcdef0123456789abcdef01234567",
            type: "CHANGE",
          }),
          expect.objectContaining({
            id: "frontend:ts:ANGULAR_COMPONENT:projects/campaign-app/src/app/modules/menu/menu-page.component.ts#MenuPageComponent",
            type: "CODE_UNIT",
          }),
          expect.objectContaining({
            id: "frontend:ts:ANGULAR_SERVICE:projects/shared-lib/src/lib/navigation/menu-cache.service.ts#MenuCacheService",
            type: "CODE_UNIT",
          }),
          expect.objectContaining({
            id: expect.stringMatching(/^EVD-[A-F0-9]{24}$/),
            type: "EVIDENCE",
          }),
        ]),
      );
      expect(graph.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "INSTANCE_OF",
            from: "BUG:frontend:12345",
            to: "DF-STALE_UI_STATE",
          }),
          expect.objectContaining({
            type: "VIOLATES",
            from: "BUG:frontend:12345",
            to: "INV-FE-001",
          }),
          expect.objectContaining({
            type: "AFFECTS",
            from: "BUG:frontend:12345",
            to: "frontend:ts:ANGULAR_COMPONENT:projects/campaign-app/src/app/modules/menu/menu-page.component.ts#MenuPageComponent",
          }),
          expect.objectContaining({
            type: "SIBLING_CANDIDATE",
            from: "BUG:frontend:12345",
            to: "frontend:ts:ANGULAR_SERVICE:projects/shared-lib/src/lib/navigation/menu-cache.service.ts#MenuCacheService",
            attributes: { verdict: "SAFE", evidenceRef: null },
          }),
          expect.objectContaining({
            type: "ENFORCES",
            from: "GRD-FE-CRUD-001",
            to: "INV-FE-001",
          }),
          expect.objectContaining({
            type: "FIXED_BY",
            from: "BUG:frontend:12345",
            to: "MR:frontend:256:0123456789abcdef0123456789abcdef01234567",
          }),
          expect.objectContaining({
            type: "GUARDED_BY",
            from: "BUG:frontend:12345",
            to: "GRD-FE-CRUD-001",
          }),
          expect.objectContaining({
            type: "EVIDENCED_BY",
            from: "BUG:frontend:12345",
            to: expect.stringMatching(/^EVD-[A-F0-9]{24}$/),
          }),
        ]),
      );
      expect(graph.edges.every((edge) => /^EDGE:[A-Z_]+:[0-9a-f]{24}$/.test(edge.id))).toBe(
        true,
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("sorts nodes and edges by their documented keys", async () => {
    const fixture = await materializeFixture("valid-registry");
    try {
      const graph = compileGraph(await loadRegistry(fixture.root));
      const nodeKeys = graph.nodes.map((node) => `${node.type}\0${node.id}`);
      const edgeKeys = graph.edges.map(
        (edge) => `${edge.type}\0${edge.from}\0${edge.to}\0${edge.id}`,
      );

      expect(nodeKeys).toEqual([...nodeKeys].sort());
      expect(edgeKeys).toEqual([...edgeKeys].sort());
    } finally {
      await fixture.dispose();
    }
  });

  it("returns byte-for-byte equivalent graphs for the same input", async () => {
    const fixture = await materializeFixture("valid-registry");
    try {
      const first = JSON.stringify(compileGraph(await loadRegistry(fixture.root)));
      const second = JSON.stringify(compileGraph(await loadRegistry(fixture.root)));

      expect(second).toBe(first);
    } finally {
      await fixture.dispose();
    }
  });

  it("writes byte-for-byte identical files on repeated CLI builds", async () => {
    const fixture = await materializeFixture("valid-registry");
    try {
      const firstOutput = join(fixture.root, "build", "first.json");
      const secondOutput = join(fixture.root, "build", "second.json");
      const stdout: string[] = [];
      const stderr: string[] = [];
      const io = {
        stdout: (value: string) => stdout.push(value),
        stderr: (value: string) => stderr.push(value),
      };

      expect(
        await runCli(
          [
            "build",
            "--root",
            fixture.root,
            "--output",
            firstOutput,
            "--as-of",
            "2026-01-15",
          ],
          io,
        ),
      ).toBe(0);
      expect(
        await runCli(
          [
            "build",
            "--root",
            fixture.root,
            "--output",
            secondOutput,
            "--as-of",
            "2026-01-15",
          ],
          io,
        ),
      ).toBe(0);

      expect(await readFile(secondOutput, "utf8")).toBe(
        await readFile(firstOutput, "utf8"),
      );
      expect(stderr).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });
});
