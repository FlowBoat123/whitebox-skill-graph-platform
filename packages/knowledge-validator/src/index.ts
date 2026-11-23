export { compileGraph, InvalidKnowledgeRegistryError, serializeGraph } from "./compile-graph.js";
export { loadRegistry } from "./load-registry.js";
export { createEdgeId, createEvidenceId, isValidCodeUnitStableId } from "./stable-id.js";
export { countRegistry, validateRegistry } from "./validate-registry.js";
export type * from "./types.js";

export { runCli } from "./cli.js";
