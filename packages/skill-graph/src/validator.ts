import fs from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import type {
  LoadedSkill,
  SkillDefinition,
  ValidationDiagnostic,
  ValidationResult,
} from "./types.js";

const TEMPLATE_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const MAX_SKILL_FILE_BYTES = 256 * 1024;

export function extractTemplateVariables(text: string): string[] {
  const vars = new Set<string>();
  for (const match of text.matchAll(TEMPLATE_PATTERN)) {
    const name = match[1];
    if (name) {
      vars.add(name);
    }
  }
  return [...vars].sort();
}

export function interpolateTemplate(
  template: string,
  params: Record<string, string>,
): string {
  return template.replace(TEMPLATE_PATTERN, (_full, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`Missing required template variable: ${key}`);
    }
    return value;
  });
}

function collectStrings(value: unknown, out: Array<{ path: string; text: string }>, prefix = ""): void {
  if (typeof value === "string") {
    out.push({ path: prefix || "/", text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, idx) => collectStrings(item, out, `${prefix}/${idx}`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      collectStrings(val, out, `${prefix}/${key}`);
    }
  }
}

export function resolveDefaultSchemaPath(cwd = process.cwd()): string {
  const candidates = [
    path.resolve(cwd, "contracts/skill-graph/skill.schema.json"),
    path.resolve(cwd, "../../contracts/skill-graph/skill.schema.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0]!;
}

export function createSkillValidator(schemaPath = resolveDefaultSchemaPath()) {
  const rawSchema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    loadSchema: async () => {
      throw new Error("Remote schema resolution is forbidden.");
    },
  });
  const validateSchema = ajv.compile<SkillDefinition>(rawSchema);

  function validateFile(filePath: string): {
    skill?: SkillDefinition;
    diagnostics: ValidationDiagnostic[];
  } {
    const normalizedPath = filePath.replace(/\\/g, "/");
    const diagnostics: ValidationDiagnostic[] = [];
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_SKILL_FILE_BYTES) {
      diagnostics.push({
        filePath: normalizedPath,
        path: "/",
        code: "FILE_TOO_LARGE",
        message: `Skill file exceeds ${MAX_SKILL_FILE_BYTES} bytes.`,
      });
      return { diagnostics };
    }

    const rawText = fs.readFileSync(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = parseYaml(rawText, {
        customTags: [],
        maxAliasCount: 25,
      });
    } catch (error) {
      diagnostics.push({
        filePath: normalizedPath,
        path: "/",
        code: "YAML_PARSE_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
      return { diagnostics };
    }

    const schemaOk = validateSchema(parsed);
    if (!schemaOk) {
      for (const err of validateSchema.errors ?? []) {
        diagnostics.push({
          filePath: normalizedPath,
          path: err.instancePath || "/",
          code: `SCHEMA_${err.keyword.toUpperCase()}`,
          message: err.message ?? "Schema validation failed.",
        });
      }
      return { diagnostics: sortDiagnostics(diagnostics) };
    }

    const skill = parsed as SkillDefinition;
    const declaredInputs = new Set(Object.keys(skill.inputs));

    // Validate semantic step requirements
    skill.steps.forEach((step, idx) => {
      const stepPath = `/steps/${idx}`;
      if (step.op === "NAVIGATE" && !step.url) {
        diagnostics.push({
          filePath: normalizedPath,
          path: stepPath,
          code: "MISSING_STEP_URL",
          message: "NAVIGATE step requires 'url'.",
        });
      }
      if (["CLICK", "FILL", "SELECT", "ASSERT_TEXT"].includes(step.op) && !step.target) {
        diagnostics.push({
          filePath: normalizedPath,
          path: stepPath,
          code: "MISSING_STEP_TARGET",
          message: `${step.op} step requires 'target'.`,
        });
      }
      if (step.target?.strategy === "role" && !step.target.role) {
        diagnostics.push({
          filePath: normalizedPath,
          path: `${stepPath}/target`,
          code: "MISSING_TARGET_ROLE",
          message: "target with strategy='role' requires 'role'.",
        });
      }
      if (["FILL", "PRESS", "SELECT", "ASSERT_TEXT"].includes(step.op) && step.value === undefined) {
        diagnostics.push({
          filePath: normalizedPath,
          path: stepPath,
          code: "MISSING_STEP_VALUE",
          message: `${step.op} step requires 'value'.`,
        });
      }
      if (step.op === "WAIT_URL" && !step.expectUrl) {
        diagnostics.push({
          filePath: normalizedPath,
          path: stepPath,
          code: "MISSING_EXPECT_URL",
          message: "WAIT_URL step requires 'expectUrl'.",
        });
      }
    });

    // Validate postcondition requirements
    skill.postconditions.forEach((post, idx) => {
      const postPath = `/postconditions/${idx}`;
      if (post.kind === "HTTP_STATUS" && (!post.method || !post.path || post.expectStatus === undefined)) {
        diagnostics.push({
          filePath: normalizedPath,
          path: postPath,
          code: "INCOMPLETE_HTTP_POSTCONDITION",
          message: "HTTP_STATUS postcondition requires method, path, and expectStatus.",
        });
      }
      if ((post.kind === "CONSOLE_ERRORS" || post.kind === "PAGE_ERRORS") && post.maxCount === undefined) {
        diagnostics.push({
          filePath: normalizedPath,
          path: postPath,
          code: "INCOMPLETE_ERROR_COUNT_POSTCONDITION",
          message: `${post.kind} postcondition requires maxCount.`,
        });
      }
      if (post.kind === "URL_MATCH" && !post.pattern) {
        diagnostics.push({
          filePath: normalizedPath,
          path: postPath,
          code: "INCOMPLETE_URL_POSTCONDITION",
          message: "URL_MATCH postcondition requires pattern.",
        });
      }
      if ((post.kind === "DOM_CONTAINS" || post.kind === "DOM_NOT_CONTAINS") && !post.text) {
        diagnostics.push({
          filePath: normalizedPath,
          path: postPath,
          code: "INCOMPLETE_DOM_POSTCONDITION",
          message: `${post.kind} postcondition requires text.`,
        });
      }
    });

    // Validate all {{var}} placeholders are declared in skill.inputs
    const allStrings: Array<{ path: string; text: string }> = [];
    collectStrings(skill.preconditions, allStrings, "/preconditions");
    collectStrings(skill.produces, allStrings, "/produces");
    collectStrings(skill.steps, allStrings, "/steps");
    collectStrings(skill.postconditions, allStrings, "/postconditions");

    for (const item of allStrings) {
      for (const variable of extractTemplateVariables(item.text)) {
        if (!declaredInputs.has(variable)) {
          diagnostics.push({
            filePath: normalizedPath,
            path: item.path,
            code: "UNDECLARED_TEMPLATE_VARIABLE",
            message: `Template placeholder '{{${variable}}}' is not declared in inputs.`,
          });
        }
      }
    }

    if (diagnostics.length > 0) {
      return { diagnostics: sortDiagnostics(diagnostics) };
    }
    return { skill, diagnostics: [] };
  }

  function validateDirectory(dirPath: string): ValidationResult {
    const files = listSkillFiles(dirPath);
    const skills: LoadedSkill[] = [];
    const diagnostics: ValidationDiagnostic[] = [];
    const seenIds = new Map<string, string>();

    for (const filePath of files) {
      const res = validateFile(filePath);
      diagnostics.push(...res.diagnostics);
      if (res.skill) {
        const existing = seenIds.get(res.skill.id);
        if (existing) {
          diagnostics.push({
            filePath: filePath.replace(/\\/g, "/"),
            path: "/id",
            code: "DUPLICATE_SKILL_ID",
            message: `Duplicate skill id '${res.skill.id}' already defined in ${existing}.`,
          });
        } else {
          seenIds.set(res.skill.id, filePath.replace(/\\/g, "/"));
          skills.push({ filePath: filePath.replace(/\\/g, "/"), skill: res.skill });
        }
      }
    }

    skills.sort((a, b) => a.skill.id.localeCompare(b.skill.id));
    return {
      valid: diagnostics.length === 0,
      skills,
      diagnostics: sortDiagnostics(diagnostics),
    };
  }

  return { validateFile, validateDirectory };
}

export function listSkillFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  const results: string[] = [];
  const walk = (current: string) => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.(ya?ml|json)$/i.test(entry.name)) {
        results.push(full);
      }
    }
  };
  walk(dirPath);
  return results;
}

function sortDiagnostics(diags: ValidationDiagnostic[]): ValidationDiagnostic[] {
  return [...diags].sort(
    (a, b) =>
      a.filePath.localeCompare(b.filePath) ||
      a.path.localeCompare(b.path) ||
      a.code.localeCompare(b.code) ||
      a.message.localeCompare(b.message),
  );
}
