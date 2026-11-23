import { describe, expect, it } from "vitest";

import {
  compileGraph,
  InvalidKnowledgeRegistryError,
  isValidCodeUnitStableId,
  loadRegistry,
  serializeGraph,
  validateRegistry,
  type JsonObject,
  type JsonValue,
  type KnowledgeDocument,
  type KnowledgeDocumentKind,
  type KnowledgeRegistry,
} from "../src/index.js";
import { diagnosticsText, materializeFixture } from "./test-helpers.js";

const AS_OF = "2026-01-15";

function copyRegistry(registry: KnowledgeRegistry): KnowledgeRegistry {
  return structuredClone(registry);
}

function documentOf(
  registry: KnowledgeRegistry,
  kind: KnowledgeDocumentKind,
): KnowledgeDocument {
  const document = registry.documents.find((candidate) => candidate.kind === kind);
  if (document === undefined) {
    throw new Error(`Fixture does not contain a ${kind} document`);
  }
  return document;
}

function objectAt(object: JsonObject, key: string): JsonObject {
  const value = object[key];
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`Expected ${key} to be an object`);
  }
  return value;
}

function reverseObjectKeys(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(reverseObjectKeys);
  }
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, entry]) => [key, reverseObjectKeys(entry)]),
  );
}

describe("identity and evidence integrity", () => {
  it.each([
    ["projectKey", "backend"],
    ["issueIid", 54321],
  ] as const)("rejects a bug whose source.%s disagrees with its ID", async (key, value) => {
    const fixture = await materializeFixture("valid-registry");
    try {
      const registry = copyRegistry(await loadRegistry(fixture.root));
      const source = objectAt(documentOf(registry, "BUG").data, "source");
      source[key] = value;

      const result = validateRegistry(registry, { asOf: AS_OF });
      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/INCONSISTENT_IDENTITY/i);
      expect(diagnosticsText(result.errors)).toMatch(/projectKey|issueIid|Bug ID/i);
    } finally {
      await fixture.dispose();
    }
  });

  it("resolves a sibling evidenceRef to a generated EVD node", async () => {
    const fixture = await materializeFixture("valid-registry");
    try {
      const registry = copyRegistry(await loadRegistry(fixture.root));
      const evidence = compileGraph(registry, { asOf: AS_OF }).nodes.find(
        (node) => node.type === "EVIDENCE",
      );
      expect(evidence?.id).toMatch(/^EVD-[A-Z0-9_-]+$/);

      const siblingScan = objectAt(
        objectAt(documentOf(registry, "BUG").data, "impact"),
        "siblingScan",
      );
      const candidates = siblingScan.candidates;
      if (!Array.isArray(candidates) || evidence === undefined) {
        throw new Error("Valid fixture needs a sibling candidate and evidence");
      }
      const candidate = candidates[0];
      if (candidate === null || Array.isArray(candidate) || typeof candidate !== "object") {
        throw new Error("Valid fixture sibling candidate is malformed");
      }
      candidate.evidenceRef = evidence.id;

      expect(validateRegistry(registry, { asOf: AS_OF }).valid).toBe(true);
      const graph = compileGraph(registry, { asOf: AS_OF });
      expect(graph.nodes.some((node) => node.id === evidence.id)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects an orphan sibling evidenceRef", async () => {
    const fixture = await materializeFixture("valid-registry");
    try {
      const registry = copyRegistry(await loadRegistry(fixture.root));
      const siblingScan = objectAt(
        objectAt(documentOf(registry, "BUG").data, "impact"),
        "siblingScan",
      );
      const candidates = siblingScan.candidates;
      if (!Array.isArray(candidates)) {
        throw new Error("Valid fixture needs sibling candidates");
      }
      const candidate = candidates[0];
      if (candidate === null || Array.isArray(candidate) || typeof candidate !== "object") {
        throw new Error("Valid fixture sibling candidate is malformed");
      }
      candidate.evidenceRef = "EVD-ORPHAN";

      const result = validateRegistry(registry, { asOf: AS_OF });
      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/UNKNOWN_REFERENCE/i);
      expect(diagnosticsText(result.errors)).toMatch(/EVD-ORPHAN/);
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects duplicate sibling candidates before graph edges can collapse", async () => {
    const fixture = await materializeFixture("valid-registry");
    try {
      const registry = copyRegistry(await loadRegistry(fixture.root));
      const siblingScan = objectAt(
        objectAt(documentOf(registry, "BUG").data, "impact"),
        "siblingScan",
      );
      const candidates = siblingScan.candidates;
      if (!Array.isArray(candidates) || candidates[0] === undefined) {
        throw new Error("Valid fixture needs a sibling candidate");
      }
      candidates.push(structuredClone(candidates[0]));

      const result = validateRegistry(registry, { asOf: AS_OF });
      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/DUPLICATE_SIBLING_CANDIDATE/i);
    } finally {
      await fixture.dispose();
    }
  });
});

describe("guardrail and validation-date integrity", () => {
  it("requires evidence before a bug can become CONFIRMED", async () => {
    const fixture = await materializeFixture("valid-registry");
    try {
      const registry = copyRegistry(await loadRegistry(fixture.root));
      documentOf(registry, "BUG").data.sourceRefs = [];

      const result = validateRegistry(registry, { asOf: AS_OF });
      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/CONFIRMED_BUG_INCOMPLETE/i);
      expect(diagnosticsText(result.errors)).toMatch(/evidence source reference/i);
    } finally {
      await fixture.dispose();
    }
  });

  it("rejects an active guardrail that does not enforce any invariant violated by the bug", async () => {
    const fixture = await materializeFixture("valid-registry");
    try {
      const registry = copyRegistry(await loadRegistry(fixture.root));
      const originalInvariant = documentOf(registry, "INVARIANT");
      const secondInvariant = structuredClone(originalInvariant);
      secondInvariant.file = "knowledge/invariants/invariant-002.yaml";
      secondInvariant.absolutePath = `${fixture.root}/knowledge/invariants/invariant-002.yaml`;
      secondInvariant.data.id = "INV-FE-002";
      secondInvariant.data.title = "Different active invariant";
      secondInvariant.data.supersedes = [];
      registry.documents.push(secondInvariant);

      documentOf(registry, "GUARDRAIL").data.enforces = ["INV-FE-002"];

      const result = validateRegistry(registry, { asOf: AS_OF });
      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/CONFIRMED_BUG_INCOMPLETE/i);
      expect(diagnosticsText(result.errors)).toMatch(/enforces a violated invariant/i);
    } finally {
      await fixture.dispose();
    }
  });

  it.each([
    ["2026-02-30", "INVALID_GUARDRAIL_EXCEPTION"],
    ["2025-12-31", "EXPIRED_GUARDRAIL_EXCEPTION"],
  ])(
    "rejects exception date %s for a DRAFT bug even when it has an active guardrail",
    async (expiresOn, expectedCode) => {
      const fixture = await materializeFixture("valid-registry");
      try {
        const registry = copyRegistry(await loadRegistry(fixture.root));
        const bug = documentOf(registry, "BUG");
        bug.data.status = "DRAFT";
        objectAt(bug.data, "resolution").guardrailException = {
          reason: "Temporary manual verification",
          owner: "technical-lead",
          expiresOn,
        };

        const result = validateRegistry(registry, { asOf: AS_OF });
        expect(result.valid).toBe(false);
        expect(diagnosticsText(result.errors)).toMatch(new RegExp(expectedCode, "i"));
      } finally {
        await fixture.dispose();
      }
    },
  );

  it.each(["not-a-date", "2026-02-30"])(
    "rejects invalid ValidationOptions.asOf value %s",
    async (asOf) => {
      const fixture = await materializeFixture("valid-registry");
      try {
        const result = validateRegistry(await loadRegistry(fixture.root), { asOf });
        expect(result.valid).toBe(false);
        expect(diagnosticsText(result.errors)).toMatch(/INVALID_VALIDATION_OPTIONS/i);
        expect(diagnosticsText(result.errors)).toContain(asOf);
      } finally {
        await fixture.dispose();
      }
    },
  );
});

describe("confirmed sibling-scan consistency", () => {
  it("rejects deferred work in a completed scan", async () => {
    const fixture = await materializeFixture("valid-registry");
    try {
      const registry = copyRegistry(await loadRegistry(fixture.root));
      const siblingScan = objectAt(
        objectAt(documentOf(registry, "BUG").data, "impact"),
        "siblingScan",
      );
      const candidates = siblingScan.candidates;
      if (!Array.isArray(candidates)) {
        throw new Error("Valid fixture needs sibling candidates");
      }
      const candidate = candidates[0];
      if (candidate === null || Array.isArray(candidate) || typeof candidate !== "object") {
        throw new Error("Valid fixture sibling candidate is malformed");
      }
      candidate.verdict = "DEFERRED";

      const result = validateRegistry(registry, { asOf: AS_OF });
      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/completed sibling scan.*deferred/i);
    } finally {
      await fixture.dispose();
    }
  });

  it("requires affected sibling candidates to be included in affectedCodeUnits", async () => {
    const fixture = await materializeFixture("valid-registry");
    try {
      const registry = copyRegistry(await loadRegistry(fixture.root));
      const siblingScan = objectAt(
        objectAt(documentOf(registry, "BUG").data, "impact"),
        "siblingScan",
      );
      const candidates = siblingScan.candidates;
      if (!Array.isArray(candidates)) {
        throw new Error("Valid fixture needs sibling candidates");
      }
      const candidate = candidates[0];
      if (candidate === null || Array.isArray(candidate) || typeof candidate !== "object") {
        throw new Error("Valid fixture sibling candidate is malformed");
      }
      candidate.verdict = "AFFECTED";

      const result = validateRegistry(registry, { asOf: AS_OF });
      expect(result.valid).toBe(false);
      expect(diagnosticsText(result.errors)).toMatch(/affectedCodeUnits/i);
    } finally {
      await fixture.dispose();
    }
  });
});

describe("fail-closed and complete graph compilation", () => {
  it("refuses to compile an invalid registry", async () => {
    const fixture = await materializeFixture("missing-reference");
    try {
      const registry = await loadRegistry(fixture.root);
      expect(() => compileGraph(registry, { asOf: AS_OF })).toThrow(
        InvalidKnowledgeRegistryError,
      );
    } finally {
      await fixture.dispose();
    }
  });

  it("creates graph nodes for every edge endpoint and all core evidence paths", async () => {
    const fixture = await materializeFixture("valid-registry");
    try {
      const graph = compileGraph(await loadRegistry(fixture.root), { asOf: AS_OF });
      const nodeIds = new Set(graph.nodes.map((node) => node.id));

      expect(graph.edges.every((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))).toBe(
        true,
      );
      expect(graph.nodes.some((node) => node.type === "CODE_UNIT")).toBe(true);
      expect(graph.nodes.some((node) => node.type === "EVIDENCE")).toBe(true);
      expect(graph.edges.some((edge) => edge.type === "AFFECTS")).toBe(true);
      expect(graph.edges.some((edge) => edge.type === "GUARDED_BY")).toBe(true);
      expect(graph.edges.some((edge) => edge.type === "EVIDENCED_BY")).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });

  it("produces the same digest and artifact after in-memory key reordering", async () => {
    const fixture = await materializeFixture("valid-registry");
    try {
      const registry = await loadRegistry(fixture.root);
      const reordered: KnowledgeRegistry = {
        ...registry,
        documents: registry.documents.map((document) => ({
          ...document,
          data: reverseObjectKeys(document.data) as JsonObject,
        })),
      };

      const originalGraph = compileGraph(registry, { asOf: AS_OF });
      const reorderedGraph = compileGraph(reordered, { asOf: AS_OF });
      expect(reorderedGraph.sourceDigest).toBe(originalGraph.sourceDigest);
      expect(serializeGraph(reorderedGraph)).toBe(serializeGraph(originalGraph));
    } finally {
      await fixture.dispose();
    }
  });

  it("produces the same digest and artifact after YAML key reordering", async () => {
    const original = await materializeFixture("valid-registry");
    const reordered = await materializeFixture("reordered-yaml");
    try {
      const originalGraph = compileGraph(await loadRegistry(original.root), {
        asOf: AS_OF,
      });
      const reorderedGraph = compileGraph(await loadRegistry(reordered.root), {
        asOf: AS_OF,
      });

      expect(reorderedGraph.sourceDigest).toBe(originalGraph.sourceDigest);
      expect(serializeGraph(reorderedGraph)).toBe(serializeGraph(originalGraph));
    } finally {
      await original.dispose();
      await reordered.dispose();
    }
  });
});

describe("stable code-unit paths and supersedes branches", () => {
  it("accepts repository-relative TypeScript paths", () => {
    expect(
      isValidCodeUnitStableId(
        "frontend:ts:CLASS:projects/campaign-app/src/app/menu.ts#MenuComponent",
      ),
    ).toBe(true);
  });

  it.each([
    "frontend:ts:CLASS:projects\\campaign-app\\menu.ts#MenuComponent",
    "frontend:ts:CLASS:/projects/campaign-app/menu.ts#MenuComponent",
    "frontend:ts:CLASS:C:/projects/campaign-app/menu.ts#MenuComponent",
    "frontend:ts:CLASS:../campaign-app/menu.ts#MenuComponent",
    "frontend:ts:CLASS:projects/campaign-app/../menu.ts#MenuComponent",
  ])("rejects unsafe TypeScript repository path %s", (stableId) => {
    expect(isValidCodeUnitStableId(stableId)).toBe(false);
  });

  it("accepts an acyclic SUPERSEDES branch and materializes its endpoints", async () => {
    const fixture = await materializeFixture("valid-supersedes");
    try {
      const registry = await loadRegistry(fixture.root);
      expect(validateRegistry(registry, { asOf: AS_OF }).valid).toBe(true);

      const graph = compileGraph(registry, { asOf: AS_OF });
      expect(graph.nodes.some((node) => node.id === "INV-FE-002")).toBe(true);
      expect(graph.nodes.some((node) => node.id === "INV-FE-001")).toBe(true);
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          type: "SUPERSEDES",
          from: "INV-FE-002",
          to: "INV-FE-001",
        }),
      );
    } finally {
      await fixture.dispose();
    }
  });
});
