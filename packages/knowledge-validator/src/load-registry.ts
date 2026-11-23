import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { isAlias, parseDocument, visit } from "yaml";

import { compareText } from "./canonical-json.js";
import type {
  JsonObject,
  JsonValue,
  KnowledgeDocument,
  KnowledgeDocumentKind,
  KnowledgeRegistry,
  ValidationDiagnostic,
} from "./types.js";

const MAX_YAML_BYTES = 1_048_576;

const KNOWLEDGE_DIRECTORIES: ReadonlyArray<{
  directory: string;
  kind: KnowledgeDocumentKind;
}> = [
  { directory: "defect-families", kind: "DEFECT_FAMILY" },
  { directory: "invariants", kind: "INVARIANT" },
  { directory: "guardrails", kind: "GUARDRAIL" },
  { directory: "bugs", kind: "BUG" },
];

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await stat(value);
    return true;
  } catch {
    return false;
  }
}

async function collectYamlFiles(directory: string): Promise<string[]> {
  if (!(await pathExists(directory))) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectYamlFiles(entryPath)));
    } else if (entry.isFile() && /\.ya?ml$/iu.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    return (
      (prototype === Object.prototype || prototype === null) &&
      Object.values(value as Record<string, unknown>).every(isJsonValue)
    );
  }
  return false;
}

function parseYamlSafely(
  source: string,
  file: string,
): { data?: JsonObject; diagnostics: ValidationDiagnostic[] } {
  const diagnostics: ValidationDiagnostic[] = [];
  let document;

  try {
    document = parseDocument(source, {
      schema: "core",
      strict: true,
      uniqueKeys: true,
      prettyErrors: false,
    });
  } catch (error) {
    diagnostics.push({
      code: "LOAD_ERROR",
      file,
      path: "$",
      message: error instanceof Error ? error.message : "Unable to parse YAML",
    });
    return { diagnostics };
  }

  let hasAlias = false;
  if (document.contents !== null) {
    visit(document.contents, (_key, node) => {
      if (isAlias(node)) {
        hasAlias = true;
        return visit.BREAK;
      }
      return undefined;
    });
  }

  if (hasAlias) {
    diagnostics.push({
      code: "YAML_SECURITY_ERROR",
      file,
      path: "$",
      message: "YAML aliases are not allowed",
    });
  }

  for (const error of document.errors) {
    diagnostics.push({
      code: "LOAD_ERROR",
      file,
      path: "$",
      message: error.message,
    });
  }
  for (const warning of document.warnings) {
    diagnostics.push({
      code: "YAML_SECURITY_ERROR",
      file,
      path: "$",
      message: warning.message,
    });
  }

  if (diagnostics.length > 0) {
    return { diagnostics };
  }

  try {
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (!isJsonValue(value) || value === null || Array.isArray(value) || typeof value !== "object") {
      diagnostics.push({
        code: "LOAD_ERROR",
        file,
        path: "$",
        message: "The YAML document root must be a JSON object",
      });
      return { diagnostics };
    }
    return { data: value as JsonObject, diagnostics };
  } catch (error) {
    diagnostics.push({
      code: "YAML_SECURITY_ERROR",
      file,
      path: "$",
      message: error instanceof Error ? error.message : "Unsafe YAML document",
    });
    return { diagnostics };
  }
}

function defaultSchemaRoot(): string {
  return fileURLToPath(new URL("../../../contracts/knowledge/", import.meta.url));
}

export async function loadRegistry(root: string): Promise<KnowledgeRegistry> {
  const absoluteRoot = path.resolve(root);
  const knowledgeRoot = path.join(absoluteRoot, "knowledge");
  const localSchemaRoot = path.join(absoluteRoot, "contracts", "knowledge");
  const schemaRoot = (await pathExists(localSchemaRoot)) ? localSchemaRoot : defaultSchemaRoot();
  const documents: KnowledgeDocument[] = [];
  const loadDiagnostics: ValidationDiagnostic[] = [];

  if (!(await pathExists(knowledgeRoot))) {
    loadDiagnostics.push({
      code: "LOAD_ERROR",
      file: "knowledge",
      path: "$",
      message: `Knowledge directory does not exist: ${knowledgeRoot}`,
    });
    return { root: absoluteRoot, schemaRoot, documents, loadDiagnostics };
  }

  for (const { directory, kind } of KNOWLEDGE_DIRECTORIES) {
    const files = await collectYamlFiles(path.join(knowledgeRoot, directory));
    for (const absolutePath of files) {
      const file = portablePath(path.relative(absoluteRoot, absolutePath));
      try {
        const fileStats = await stat(absolutePath);
        if (fileStats.size > MAX_YAML_BYTES) {
          loadDiagnostics.push({
            code: "LOAD_ERROR",
            file,
            path: "$",
            message: `YAML file exceeds the ${MAX_YAML_BYTES}-byte limit`,
          });
          continue;
        }
        const source = await readFile(absolutePath, "utf8");
        const parsed = parseYamlSafely(source, file);
        loadDiagnostics.push(...parsed.diagnostics);
        if (parsed.data !== undefined) {
          documents.push({ kind, absolutePath, file, data: parsed.data });
        }
      } catch (error) {
        loadDiagnostics.push({
          code: "LOAD_ERROR",
          file,
          path: "$",
          message: error instanceof Error ? error.message : "Unable to read YAML file",
        });
      }
    }
  }

  documents.sort((left, right) => compareText(left.file, right.file));
  loadDiagnostics.sort(compareDiagnostics);
  return { root: absoluteRoot, schemaRoot, documents, loadDiagnostics };
}

export function compareDiagnostics(
  left: ValidationDiagnostic,
  right: ValidationDiagnostic,
): number {
  return (
    compareText(left.file, right.file) ||
    compareText(left.path, right.path) ||
    compareText(left.code, right.code) ||
    compareText(left.message, right.message)
  );
}
