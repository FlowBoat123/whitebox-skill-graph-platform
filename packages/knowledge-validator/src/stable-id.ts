import type { GraphEdgeType } from "./types.js";
import { sha256 } from "./canonical-json.js";

const PROJECT_KEY = "[A-Za-z0-9][A-Za-z0-9._-]*";
const TYPESCRIPT_ID = new RegExp(
  `^${PROJECT_KEY}:ts:(?:MODULE|FILE|CLASS|INTERFACE|METHOD|FUNCTION|ANGULAR_COMPONENT|ANGULAR_SERVICE|API_ENDPOINT|DTO|TEST):([^#\\r\\n]+)#([^#\\r\\n]+)$`,
  "u",
);
const PYTHON_ID = new RegExp(
  `^${PROJECT_KEY}:py:(?:MODULE|FILE|CLASS|METHOD|FUNCTION|API_ENDPOINT|TEST):([^#\\r\\n]+)#([^#\\r\\n]+)$`,
  "u",
);
const TEMPLATE_ID = new RegExp(
  `^${PROJECT_KEY}:template:FILE:([^#\\r\\n]+)#([^#\\r\\n]+)$`,
  "u",
);
const JAVA_ID = new RegExp(
  `^${PROJECT_KEY}:java:(?:MODULE|FILE|CLASS|INTERFACE|METHOD|API_ENDPOINT|DTO|DATABASE_TABLE|DATABASE_COLUMN|TEST):[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*#[^#\\r\\n]+$`,
  "u",
);
const API_ID = new RegExp(
  `^${PROJECT_KEY}:api:(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS):/[^\\s]*$`,
  "u",
);
const DATABASE_ID = new RegExp(
  `^${PROJECT_KEY}:db:[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)?$`,
  "u",
);

function isValidRepoRelativePath(repositoryPath: string | undefined): boolean {
  if (
    repositoryPath === undefined ||
    repositoryPath.startsWith("/") ||
    repositoryPath.endsWith("/") ||
    repositoryPath.includes(":") ||
    repositoryPath
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return false;
  }
  return true;
}

export function isValidCodeUnitStableId(value: string): boolean {
  if (value.length < 8 || value.length > 2_048 || /[\\\s]/u.test(value)) {
    return false;
  }

  const pathMatch = TYPESCRIPT_ID.exec(value) ?? PYTHON_ID.exec(value) ?? TEMPLATE_ID.exec(value);
  if (pathMatch !== null) {
    return isValidRepoRelativePath(pathMatch[1]);
  }

  return JAVA_ID.test(value) || API_ID.test(value) || DATABASE_ID.test(value);
}

export function createEdgeId(
  type: GraphEdgeType,
  fromId: string,
  toId: string,
  sourceEntityId: string,
): string {
  const hashInput = `${type}\0${fromId}\0${toId}\0${sourceEntityId}`;
  return `EDGE:${type}:${sha256(hashInput).slice(0, 24)}`;
}

export function createEvidenceId(canonicalSourceReference: string): string {
  return `EVD-${sha256(canonicalSourceReference).slice(0, 24).toUpperCase()}`;
}
