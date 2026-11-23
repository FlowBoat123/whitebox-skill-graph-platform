import { readFileSync } from "node:fs";
import path from "node:path";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

import type {
  JsonObject,
  JsonValue,
  KnowledgeDocumentKind,
  KnowledgeRegistry,
  ValidationDiagnostic,
} from "./types.js";

const SCHEMA_FILE_BY_KIND: Readonly<Record<KnowledgeDocumentKind, string>> = {
  DEFECT_FAMILY: "defect-family.schema.json",
  INVARIANT: "invariant.schema.json",
  GUARDRAIL: "guardrail.schema.json",
  BUG: "bug.schema.json",
};

const REQUIRED_SCHEMA_FILES = [
  "common.schema.json",
  "defect-family.schema.json",
  "invariant.schema.json",
  "guardrail.schema.json",
  "bug.schema.json",
] as const;

function collectReferences(value: JsonValue, references: string[]): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectReferences(entry, references);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ref" && typeof entry === "string") {
      references.push(entry);
    }
    collectReferences(entry, references);
  }
}

function assertOnlyLocalReferences(schema: JsonObject, file: string): void {
  const references: string[] = [];
  collectReferences(schema, references);
  for (const reference of references) {
    const isRemote =
      /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(reference) ||
      reference.startsWith("//") ||
      reference.startsWith("/") ||
      reference.includes("\\");
    if (isRemote) {
      throw new Error(`Remote or absolute schema reference is not allowed in ${file}: ${reference}`);
    }

    const target = reference.split("#", 1)[0];
    if (target !== undefined && target !== "" && !REQUIRED_SCHEMA_FILES.includes(target as never)) {
      throw new Error(`Unknown local schema reference in ${file}: ${reference}`);
    }
  }
}

function readSchema(schemaRoot: string, file: string): JsonObject {
  const schemaPath = path.join(schemaRoot, file);
  const parsed: unknown = JSON.parse(readFileSync(schemaPath, "utf8"));
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`Schema root must be an object: ${schemaPath}`);
  }
  const schema = parsed as JsonObject;
  assertOnlyLocalReferences(schema, file);
  return schema;
}

function jsonPointerToPath(pointer: string): string {
  if (pointer === "") {
    return "$";
  }
  const segments = pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  return segments.reduce((result, segment) => {
    if (/^(?:0|[1-9][0-9]*)$/u.test(segment)) {
      return `${result}[${segment}]`;
    }
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(segment)) {
      return `${result}.${segment}`;
    }
    return `${result}[${JSON.stringify(segment)}]`;
  }, "$" as string);
}

function diagnosticPath(error: ErrorObject): string {
  const base = jsonPointerToPath(error.instancePath);
  if (error.keyword === "required") {
    const missingProperty = (error.params as { missingProperty?: unknown }).missingProperty;
    if (typeof missingProperty === "string") {
      return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(missingProperty)
        ? `${base}.${missingProperty}`
        : `${base}[${JSON.stringify(missingProperty)}]`;
    }
  }
  return base;
}

function diagnosticMessage(error: ErrorObject): string {
  if (error.keyword === "additionalProperties") {
    const property = (error.params as { additionalProperty?: unknown }).additionalProperty;
    if (typeof property === "string") {
      return `Unexpected property "${property}"`;
    }
  }
  return error.message ?? `Schema rule "${error.keyword}" failed`;
}

function createValidators(schemaRoot: string): Map<KnowledgeDocumentKind, ValidateFunction> {
  const schemas = new Map<string, JsonObject>();
  for (const file of REQUIRED_SCHEMA_FILES) {
    schemas.set(file, readSchema(schemaRoot, file));
  }

  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false,
  });

  const common = schemas.get("common.schema.json");
  if (common === undefined) {
    throw new Error("Missing common.schema.json");
  }
  ajv.addSchema(common, "common.schema.json");

  const validators = new Map<KnowledgeDocumentKind, ValidateFunction>();
  for (const [kind, file] of Object.entries(SCHEMA_FILE_BY_KIND) as Array<
    [KnowledgeDocumentKind, string]
  >) {
    const schema = schemas.get(file);
    if (schema === undefined) {
      throw new Error(`Missing schema: ${file}`);
    }
    ajv.addSchema(schema, file);
    const validator = ajv.getSchema(file);
    if (validator === undefined) {
      throw new Error(`Unable to compile schema: ${file}`);
    }
    validators.set(kind, validator);
  }
  return validators;
}

export function validateSchemas(registry: KnowledgeRegistry): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  let validators: Map<KnowledgeDocumentKind, ValidateFunction>;
  try {
    validators = createValidators(registry.schemaRoot);
  } catch (error) {
    diagnostics.push({
      code: "LOAD_ERROR",
      file: "contracts/knowledge",
      path: "$",
      message: error instanceof Error ? error.message : "Unable to load JSON schemas",
    });
    return diagnostics;
  }

  for (const document of registry.documents) {
    const validator = validators.get(document.kind);
    if (validator === undefined) {
      diagnostics.push({
        code: "LOAD_ERROR",
        file: document.file,
        path: "$",
        message: `No validator registered for ${document.kind}`,
      });
      continue;
    }
    if (!validator(document.data)) {
      for (const error of validator.errors ?? []) {
        diagnostics.push({
          code: "SCHEMA_VALIDATION_ERROR",
          file: document.file,
          path: diagnosticPath(error),
          message: diagnosticMessage(error),
        });
      }
    }
  }
  return diagnostics;
}
