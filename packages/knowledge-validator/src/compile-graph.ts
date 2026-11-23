import { canonicalJson, compareText, sha256 } from "./canonical-json.js";
import { createEdgeId, createEvidenceId } from "./stable-id.js";
import { validateRegistry } from "./validate-registry.js";
import type {
  GraphEdge,
  GraphEdgeType,
  GraphNode,
  GraphNodeType,
  JsonObject,
  JsonValue,
  KnowledgeDocument,
  KnowledgeGraph,
  KnowledgeRegistry,
  ValidationOptions,
  ValidationResult,
} from "./types.js";

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && !Array.isArray(value) && typeof value === "object" ? value : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function sourceDigest(registry: KnowledgeRegistry): string {
  const source = registry.documents
    .map((document) => ({
      file: document.file,
      kind: document.kind,
      data: document.data,
    }))
    .sort((left, right) => compareText(left.file, right.file));
  return sha256(canonicalJson(source as unknown as JsonValue));
}

function sourceEntityNodeType(document: KnowledgeDocument): GraphNodeType {
  return document.kind;
}

function canonicalObject(value: JsonObject): JsonObject {
  return JSON.parse(canonicalJson(value)) as JsonObject;
}

export class InvalidKnowledgeRegistryError extends Error {
  constructor(public readonly validation: ValidationResult) {
    const first = validation.errors[0];
    super(
      first === undefined
        ? "Cannot compile an invalid knowledge registry"
        : `Cannot compile invalid knowledge registry: ${first.file} ${first.path}: ${first.message}`,
    );
    this.name = "InvalidKnowledgeRegistryError";
  }
}

export function compileGraph(
  registry: KnowledgeRegistry,
  options: ValidationOptions = {},
): KnowledgeGraph {
  const validation = validateRegistry(registry, options);
  if (!validation.valid) {
    throw new InvalidKnowledgeRegistryError(validation);
  }

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();

  const addNode = (node: GraphNode): void => {
    if (!nodes.has(node.id)) {
      nodes.set(node.id, node);
    }
  };

  const addEdge = (
    type: GraphEdgeType,
    from: string,
    to: string,
    sourceEntityId: string,
    attributes?: JsonObject,
  ): void => {
    const id = createEdgeId(type, from, to, sourceEntityId);
    if (!edges.has(id)) {
      edges.set(
        id,
        attributes === undefined
          ? { id, type, from, to, sourceEntityId }
          : { id, type, from, to, sourceEntityId, attributes: canonicalObject(attributes) },
      );
    }
  };

  for (const document of registry.documents) {
    const entityId = stringValue(document.data.id);
    if (entityId === undefined) {
      continue;
    }
    addNode({
      id: entityId,
      type: sourceEntityNodeType(document),
      attributes: canonicalObject({ ...document.data, sourceFile: document.file }),
    });

    const sourceRefs = document.data.sourceRefs;
    if (Array.isArray(sourceRefs)) {
      for (const sourceRefValue of sourceRefs) {
        const sourceRef = objectValue(sourceRefValue);
        if (sourceRef === undefined) {
          continue;
        }
        const evidenceId = createEvidenceId(canonicalJson(sourceRef));
        addNode({ id: evidenceId, type: "EVIDENCE", attributes: canonicalObject(sourceRef) });
        addEdge("EVIDENCED_BY", entityId, evidenceId, entityId);
      }
    }

    if (document.kind === "INVARIANT") {
      for (const supersededId of stringArray(document.data.supersedes)) {
        addEdge("SUPERSEDES", entityId, supersededId, entityId);
      }
      continue;
    }

    if (document.kind === "GUARDRAIL") {
      for (const invariantId of stringArray(document.data.enforces)) {
        addEdge("ENFORCES", entityId, invariantId, entityId);
      }
      continue;
    }

    if (document.kind !== "BUG") {
      continue;
    }

    const classification = objectValue(document.data.classification);
    const familyId = stringValue(classification?.defectFamily);
    if (familyId !== undefined) {
      addEdge("INSTANCE_OF", entityId, familyId, entityId);
    }

    const analysis = objectValue(document.data.analysis);
    for (const invariantId of stringArray(analysis?.violatedInvariants)) {
      addEdge("VIOLATES", entityId, invariantId, entityId);
    }

    const impact = objectValue(document.data.impact);
    for (const codeUnitId of stringArray(impact?.affectedCodeUnits)) {
      addNode({
        id: codeUnitId,
        type: "CODE_UNIT",
        attributes: { stableKey: codeUnitId },
      });
      addEdge("AFFECTS", entityId, codeUnitId, entityId);
    }
    const siblingScan = objectValue(impact?.siblingScan);
    if (Array.isArray(siblingScan?.candidates)) {
      for (const candidateValue of siblingScan.candidates) {
        const candidate = objectValue(candidateValue);
        const codeUnitId = stringValue(candidate?.codeUnit);
        const verdict = stringValue(candidate?.verdict);
        if (codeUnitId === undefined || verdict === undefined) {
          continue;
        }
        const evidenceRef = stringValue(candidate?.evidenceRef);
        addNode({
          id: codeUnitId,
          type: "CODE_UNIT",
          attributes: { stableKey: codeUnitId },
        });
        addEdge("SIBLING_CANDIDATE", entityId, codeUnitId, entityId, {
          verdict,
          evidenceRef: evidenceRef ?? null,
        });
        if (evidenceRef !== undefined) {
          addEdge("EVIDENCED_BY", entityId, evidenceRef, entityId);
        }
      }
    }

    const resolution = objectValue(document.data.resolution);
    const changeId = stringValue(resolution?.fixMergeRequest);
    if (changeId !== undefined) {
      addNode({ id: changeId, type: "CHANGE", attributes: { stableKey: changeId } });
      addEdge("FIXED_BY", entityId, changeId, entityId);
    }
    for (const guardrailId of stringArray(resolution?.regressionGuardrails)) {
      addEdge("GUARDED_BY", entityId, guardrailId, entityId);
    }
  }

  const sortedNodes = [...nodes.values()].sort(
    (left, right) => compareText(left.type, right.type) || compareText(left.id, right.id),
  );
  const sortedEdges = [...edges.values()].sort(
    (left, right) =>
      compareText(left.type, right.type) ||
      compareText(left.from, right.from) ||
      compareText(left.to, right.to) ||
      compareText(left.id, right.id),
  );

  return {
    schemaVersion: 1,
    sourceDigest: sourceDigest(registry),
    nodes: sortedNodes,
    edges: sortedEdges,
  };
}

export function serializeGraph(graph: KnowledgeGraph): string {
  return `${JSON.stringify(graph, null, 2)}\n`;
}
