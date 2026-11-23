import { compareDiagnostics } from "./load-registry.js";
import { validateReferences } from "./validate-references.js";
import { validateSchemas } from "./validate-schema.js";
import type {
  KnowledgeRegistry,
  RegistryCounts,
  ValidationOptions,
  ValidationResult,
} from "./types.js";

export function countRegistry(registry: KnowledgeRegistry): RegistryCounts {
  return {
    defectFamilies: registry.documents.filter((document) => document.kind === "DEFECT_FAMILY")
      .length,
    invariants: registry.documents.filter((document) => document.kind === "INVARIANT").length,
    guardrails: registry.documents.filter((document) => document.kind === "GUARDRAIL").length,
    bugs: registry.documents.filter((document) => document.kind === "BUG").length,
  };
}

export function validateRegistry(
  registry: KnowledgeRegistry,
  options: ValidationOptions = {},
): ValidationResult {
  const errors = [
    ...registry.loadDiagnostics,
    ...validateSchemas(registry),
    ...validateReferences(registry, options),
  ];
  errors.sort(compareDiagnostics);
  return {
    valid: errors.length === 0,
    errors,
    counts: countRegistry(registry),
  };
}
