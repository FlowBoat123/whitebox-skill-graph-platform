export const DOCUMENT_KINDS = [
  "DEFECT_FAMILY",
  "INVARIANT",
  "GUARDRAIL",
  "BUG",
] as const;

export type KnowledgeDocumentKind = (typeof DOCUMENT_KINDS)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface KnowledgeDocument {
  kind: KnowledgeDocumentKind;
  /** Absolute path, used only while reading/reporting errors. */
  absolutePath: string;
  /** Portable path relative to the registry root. */
  file: string;
  data: JsonObject;
}

export interface KnowledgeRegistry {
  root: string;
  schemaRoot: string;
  documents: KnowledgeDocument[];
  loadDiagnostics: ValidationDiagnostic[];
}

export type ValidationErrorCode =
  | "LOAD_ERROR"
  | "YAML_SECURITY_ERROR"
  | "SCHEMA_VALIDATION_ERROR"
  | "DUPLICATE_ID"
  | "DUPLICATE_SIBLING_CANDIDATE"
  | "UNKNOWN_REFERENCE"
  | "INCONSISTENT_IDENTITY"
  | "INVALID_VALIDATION_OPTIONS"
  | "CYCLIC_SUPERSEDES"
  | "CONFIRMED_BUG_INCOMPLETE"
  | "INVALID_GUARDRAIL_EXCEPTION"
  | "EXPIRED_GUARDRAIL_EXCEPTION"
  | "INVALID_STABLE_KEY";

export interface ValidationDiagnostic {
  code: ValidationErrorCode;
  file: string;
  path: string;
  message: string;
}

export interface RegistryCounts {
  defectFamilies: number;
  invariants: number;
  guardrails: number;
  bugs: number;
}

export interface ValidationOptions {
  /** Inclusive validation date in YYYY-MM-DD form. Defaults to today (UTC). */
  asOf?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationDiagnostic[];
  counts: RegistryCounts;
}

export const GRAPH_NODE_TYPES = [
  "BUG",
  "DEFECT_FAMILY",
  "INVARIANT",
  "GUARDRAIL",
  "CODE_UNIT",
  "CHANGE",
  "EVIDENCE",
] as const;

export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

export const GRAPH_EDGE_TYPES = [
  "INSTANCE_OF",
  "VIOLATES",
  "AFFECTS",
  "SIBLING_CANDIDATE",
  "FIXED_BY",
  "GUARDED_BY",
  "ENFORCES",
  "EVIDENCED_BY",
  "SUPERSEDES",
] as const;

export type GraphEdgeType = (typeof GRAPH_EDGE_TYPES)[number];

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  attributes: JsonObject;
}

export interface GraphEdge {
  id: string;
  type: GraphEdgeType;
  from: string;
  to: string;
  sourceEntityId: string;
  attributes?: JsonObject;
}

export interface KnowledgeGraph {
  schemaVersion: 1;
  sourceDigest: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface CliIo {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  env?: Readonly<Record<string, string | undefined>>;
}
