import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compileGraph,
  loadRegistry,
  validateRegistry,
} from "@defect-intelligence/knowledge-validator";
import {
  buildProposedSkillGuardrailYaml,
  buildRegistryBugDraftYaml,
  createSkillValidator,
  executePlan,
  groundSkillCodeRefs,
  loadKnowledgeGraph,
  planToReach,
  queryDefectKnowledgeGraph,
  selectDefectAwareImpactedSkills,
  writeRegistryBugDraftYaml,
  type BugEvidenceBundle,
} from "@defect-intelligence/skill-graph";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpContext {
  workspaceRoot: string;
  defaultKnowledgePath: string;
  defaultSkillsRoot: string;
}

export const MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "query_defect_knowledge",
    description:
      "Query the compiled Defect Knowledge Graph by file paths, project key, defect family, or text query. Strictly separates CONFIRMED/ACTIVE knowledge from observed DRAFT/PROPOSED records.",
    inputSchema: {
      type: "object",
      properties: {
        knowledgePath: {
          type: "string",
          description: "Optional path to build/knowledge-index.json or registry root directory.",
        },
        filePaths: {
          type: "array",
          items: { type: "string" },
          description: "Repository-relative file paths to look up affected bugs, invariants, and guardrails.",
        },
        projectKey: { type: "string", description: "Project key filter (e.g. cypress-rwa, horilla)." },
        defectFamily: { type: "string", description: "Defect family ID filter (e.g. DF-UI_STATE_INTERACTION)." },
        query: { type: "string", description: "Optional substring search over graph node attributes." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "plan_impacted_skills",
    description:
      "Run deterministic 0-LLM Defect-Aware Risk-Prioritized Impact Selection uniting Git diff (or explicit changedFiles) with Skill Graph codeRefs and Defect Knowledge Graph (AFFECTS, VIOLATES, ENFORCES, SIBLING_CANDIDATE).",
    inputSchema: {
      type: "object",
      required: ["skillsDir"],
      properties: {
        skillsDir: { type: "string", description: "Directory containing skill YAML files (e.g. skills/horilla)." },
        repoPath: { type: "string", description: "Git repository path to diff against baseRef." },
        baseRef: { type: "string", description: "Git base ref (default: HEAD)." },
        changedFiles: {
          type: "array",
          items: { type: "string" },
          description: "Optional explicit repo-relative changed file list (bypasses git diff).",
        },
        knowledgePath: {
          type: "string",
          description: "Optional path to compiled knowledge-index.json or registry root.",
        },
        projectKey: { type: "string", description: "Optional project key override." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "compose_skill_plan",
    description:
      "Run deterministic 0-LLM backward-chaining skill planning (planToReach) to compose the minimal ordered skill execution sequence reaching a target state predicate.",
    inputSchema: {
      type: "object",
      required: ["skillsDir", "goalFact"],
      properties: {
        skillsDir: { type: "string", description: "Directory containing skill YAML files." },
        goalFact: { type: "string", description: "Target state predicate name (e.g. department.exists, tx.paid)." },
        goalParams: { type: "object", additionalProperties: { type: "string" } },
        bindings: { type: "object", additionalProperties: { type: "string" } },
        actorBindings: {
          type: "object",
          additionalProperties: { type: "object", additionalProperties: { type: "string" } },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ground_code_refs",
    description:
      "Run 0-LLM Static Route-to-Code Grounding (TsWebRouteGrounder / DjangoRouteGrounder) to map observed routes, HTTP endpoints, and HTMX fragment URLs to repository source files.",
    inputSchema: {
      type: "object",
      required: ["repoPath", "routes", "endpoints"],
      properties: {
        repoPath: { type: "string", description: "Target application repository path." },
        routes: { type: "array", items: { type: "string" } },
        endpoints: { type: "array", items: { type: "string" } },
        fragmentUrls: { type: "array", items: { type: "string" } },
        uiTerms: { type: "array", items: { type: "string" } },
        maxFiles: { type: "integer", minimum: 1, maximum: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "run_skill_verification",
    description:
      "Execute a deterministic 0-LLM Playwright skill plan against a local app, discriminate VERIFIED_PASS vs SKILL_DRIFT vs PRODUCT_BUG, and optionally emit a schema-compliant DRAFT bug YAML on PRODUCT_BUG.",
    inputSchema: {
      type: "object",
      required: ["skillsDir", "goalFact", "baseUrl"],
      properties: {
        skillsDir: { type: "string" },
        goalFact: { type: "string" },
        goalParams: { type: "object", additionalProperties: { type: "string" } },
        bindings: { type: "object", additionalProperties: { type: "string" } },
        actorBindings: {
          type: "object",
          additionalProperties: { type: "object", additionalProperties: { type: "string" } },
        },
        baseUrl: { type: "string" },
        apiBaseUrl: { type: "string" },
        stepTimeoutMs: { type: "integer", minimum: 500, maximum: 60000 },
        evidenceDir: { type: "string" },
        draftBugsDir: {
          type: "string",
          description: "Optional directory where schema-compliant DRAFT bug YAML files are written on PRODUCT_BUG.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "emit_defect_draft",
    description:
      "Compile an observed BugEvidenceBundle into a bug.schema.json-validated DRAFT bug YAML (and optional PROPOSED SKILL_GRAPH_VERIFIER guardrail YAML). Strictly enforces status=DRAFT and validates against local contracts/knowledge/.",
    inputSchema: {
      type: "object",
      required: ["app", "bug"],
      properties: {
        app: { type: "string" },
        bug: { type: "object" },
        owner: { type: "string" },
        severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
        defectFamily: { type: "string" },
        violatedInvariants: { type: "array", items: { type: "string" } },
        draftBugsDir: { type: "string", description: "Optional output directory to persist <issueIid>.yaml." },
        proposeGuardrail: {
          type: "object",
          properties: {
            skillsDir: { type: "string" },
            skillId: { type: "string" },
            enforces: { type: "array", items: { type: "string" } },
          },
          required: ["skillsDir", "skillId", "enforces"],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
];

export const MCP_RESOURCES: McpResourceDefinition[] = [
  {
    uri: "defect-intelligence://graph/summary",
    name: "Defect Knowledge Graph Summary",
    description: "Deterministic summary of node/edge counts, active invariants, guardrails, and sourceDigest.",
    mimeType: "application/json",
  },
  {
    uri: "defect-intelligence://skills/catalog",
    name: "White-Box Skill Graph Catalog",
    description: "Catalog of all validated white-box skills across the workspace skills directory.",
    mimeType: "application/json",
  },
];

function resolvePathFromWorkspace(workspaceRoot: string, maybeRelative: string): string {
  return path.isAbsolute(maybeRelative) ? maybeRelative : path.resolve(workspaceRoot, maybeRelative);
}

async function validateDraftBugInMemory(
  workspaceRoot: string,
  app: string,
  fileName: string,
  yamlText: string,
): Promise<{ valid: boolean; errors: unknown[] }> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-draft-val-"));
  try {
    // Copy local contracts & knowledge (defect-families/invariants/guardrails) so validator checks real references offline
    fs.cpSync(path.join(workspaceRoot, "contracts"), path.join(tmpRoot, "contracts"), { recursive: true });
    fs.cpSync(path.join(workspaceRoot, "knowledge"), path.join(tmpRoot, "knowledge"), { recursive: true });
    const bugDir = path.join(tmpRoot, "knowledge", "bugs", app);
    fs.mkdirSync(bugDir, { recursive: true });
    fs.writeFileSync(path.join(bugDir, fileName), yamlText, "utf8");
    const registry = await loadRegistry(tmpRoot);
    const validation = validateRegistry(registry);
    if (validation.valid) {
      // Confirm deterministic compilation also succeeds
      compileGraph(registry);
    }
    return { valid: validation.valid, errors: validation.errors };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

export async function callMcpTool(
  ctx: McpContext,
  toolName: string,
  rawArgs: Record<string, unknown>,
): Promise<unknown> {
  switch (toolName) {
    case "query_defect_knowledge": {
      const kPath =
        typeof rawArgs.knowledgePath === "string"
          ? resolvePathFromWorkspace(ctx.workspaceRoot, rawArgs.knowledgePath)
          : ctx.defaultKnowledgePath;
      const graph = await loadKnowledgeGraph(kPath);
      return queryDefectKnowledgeGraph(graph, {
        ...(Array.isArray(rawArgs.filePaths)
          ? { filePaths: rawArgs.filePaths.filter((x): x is string => typeof x === "string") }
          : {}),
        ...(typeof rawArgs.projectKey === "string" ? { projectKey: rawArgs.projectKey } : {}),
        ...(typeof rawArgs.defectFamily === "string" ? { defectFamily: rawArgs.defectFamily } : {}),
        ...(typeof rawArgs.query === "string" ? { query: rawArgs.query } : {}),
      });
    }

    case "plan_impacted_skills": {
      if (typeof rawArgs.skillsDir !== "string" || !rawArgs.skillsDir.trim()) {
        throw new Error("skillsDir (string) is required.");
      }
      const skillsDir = resolvePathFromWorkspace(ctx.workspaceRoot, rawArgs.skillsDir);
      const validator = createSkillValidator();
      const loaded = validator.validateDirectory(skillsDir);
      if (!loaded.valid) {
        throw new Error(`Invalid skills directory: ${loaded.diagnostics.map((d) => d.message).join("; ")}`);
      }
      const kPath =
        typeof rawArgs.knowledgePath === "string"
          ? resolvePathFromWorkspace(ctx.workspaceRoot, rawArgs.knowledgePath)
          : ctx.defaultKnowledgePath;
      const knowledgeGraph = await loadKnowledgeGraph(kPath);
      return selectDefectAwareImpactedSkills({
        skills: loaded.skills,
        knowledgeGraph,
        ...(typeof rawArgs.repoPath === "string"
          ? { repoPath: resolvePathFromWorkspace(ctx.workspaceRoot, rawArgs.repoPath) }
          : {}),
        ...(typeof rawArgs.baseRef === "string" ? { baseRef: rawArgs.baseRef } : {}),
        ...(Array.isArray(rawArgs.changedFiles)
          ? { changedFiles: rawArgs.changedFiles.filter((x): x is string => typeof x === "string") }
          : {}),
        ...(typeof rawArgs.projectKey === "string" ? { projectKey: rawArgs.projectKey } : {}),
      });
    }

    case "compose_skill_plan": {
      if (typeof rawArgs.skillsDir !== "string" || typeof rawArgs.goalFact !== "string") {
        throw new Error("skillsDir and goalFact (strings) are required.");
      }
      const skillsDir = resolvePathFromWorkspace(ctx.workspaceRoot, rawArgs.skillsDir);
      const validator = createSkillValidator();
      const loaded = validator.validateDirectory(skillsDir);
      if (!loaded.valid) {
        throw new Error(`Invalid skills directory: ${loaded.diagnostics.map((d) => d.message).join("; ")}`);
      }
      return planToReach({
        skills: loaded.skills.map((s) => s.skill),
        goal: {
          name: rawArgs.goalFact,
          ...(rawArgs.goalParams && typeof rawArgs.goalParams === "object"
            ? { params: rawArgs.goalParams as Record<string, string> }
            : {}),
        },
        bindings:
          rawArgs.bindings && typeof rawArgs.bindings === "object"
            ? (rawArgs.bindings as Record<string, string>)
            : {},
        ...(rawArgs.actorBindings && typeof rawArgs.actorBindings === "object"
          ? { actorBindings: rawArgs.actorBindings as Record<string, Record<string, string>> }
          : {}),
      });
    }

    case "ground_code_refs": {
      if (
        typeof rawArgs.repoPath !== "string" ||
        !Array.isArray(rawArgs.routes) ||
        !Array.isArray(rawArgs.endpoints)
      ) {
        throw new Error("repoPath (string), routes (string[]), and endpoints (string[]) are required.");
      }
      return groundSkillCodeRefs({
        repoPath: resolvePathFromWorkspace(ctx.workspaceRoot, rawArgs.repoPath),
        routes: rawArgs.routes.filter((x): x is string => typeof x === "string"),
        endpoints: rawArgs.endpoints.filter((x): x is string => typeof x === "string"),
        ...(Array.isArray(rawArgs.fragmentUrls)
          ? { fragmentUrls: rawArgs.fragmentUrls.filter((x): x is string => typeof x === "string") }
          : {}),
        ...(Array.isArray(rawArgs.uiTerms)
          ? { uiTerms: rawArgs.uiTerms.filter((x): x is string => typeof x === "string") }
          : {}),
        ...(typeof rawArgs.maxFiles === "number" ? { maxFiles: rawArgs.maxFiles } : {}),
      });
    }

    case "run_skill_verification": {
      if (
        typeof rawArgs.skillsDir !== "string" ||
        typeof rawArgs.goalFact !== "string" ||
        typeof rawArgs.baseUrl !== "string"
      ) {
        throw new Error("skillsDir, goalFact, and baseUrl (strings) are required.");
      }
      const skillsDir = resolvePathFromWorkspace(ctx.workspaceRoot, rawArgs.skillsDir);
      const validator = createSkillValidator();
      const loaded = validator.validateDirectory(skillsDir);
      if (!loaded.valid) {
        throw new Error(`Invalid skills directory: ${loaded.diagnostics.map((d) => d.message).join("; ")}`);
      }
      const allSkills = loaded.skills.map((s) => s.skill);
      const skillsById = new Map(allSkills.map((s) => [s.id, s]));
      const plan = planToReach({
        skills: allSkills,
        goal: {
          name: rawArgs.goalFact,
          ...(rawArgs.goalParams && typeof rawArgs.goalParams === "object"
            ? { params: rawArgs.goalParams as Record<string, string> }
            : {}),
        },
        bindings:
          rawArgs.bindings && typeof rawArgs.bindings === "object"
            ? (rawArgs.bindings as Record<string, string>)
            : {},
        ...(rawArgs.actorBindings && typeof rawArgs.actorBindings === "object"
          ? { actorBindings: rawArgs.actorBindings as Record<string, Record<string, string>> }
          : {}),
      });

      const report = await executePlan(plan, skillsById, {
        baseUrl: rawArgs.baseUrl,
        ...(typeof rawArgs.apiBaseUrl === "string" ? { apiBaseUrl: rawArgs.apiBaseUrl } : {}),
        ...(typeof rawArgs.stepTimeoutMs === "number" ? { stepTimeoutMs: rawArgs.stepTimeoutMs } : {}),
        ...(typeof rawArgs.evidenceDir === "string"
          ? { evidenceDir: resolvePathFromWorkspace(ctx.workspaceRoot, rawArgs.evidenceDir) }
          : {}),
      });

      const emittedDrafts: Array<{
        bugId: string;
        status: "DRAFT";
        filePath?: string;
        schemaValid: boolean;
      }> = [];

      for (const sr of report.skillReports) {
        if (sr.verdict === "PRODUCT_BUG" && sr.bug) {
          const sk = skillsById.get(sr.skillId);
          const app = sk?.app ?? "webapp";
          const built = buildRegistryBugDraftYaml(app, sr.bug);
          const val = await validateDraftBugInMemory(ctx.workspaceRoot, app, built.fileName, built.yaml);
          let filePath: string | undefined;
          if (typeof rawArgs.draftBugsDir === "string" && rawArgs.draftBugsDir.trim()) {
            const outDir = resolvePathFromWorkspace(ctx.workspaceRoot, rawArgs.draftBugsDir);
            filePath = writeRegistryBugDraftYaml(built, outDir);
          }
          emittedDrafts.push({
            bugId: built.document.id,
            status: "DRAFT",
            ...(filePath ? { filePath } : {}),
            schemaValid: val.valid,
          });
        }
      }

      return {
        plan,
        report,
        llmCallsUsed: 0,
        emittedDrafts,
      };
    }

    case "emit_defect_draft": {
      if (typeof rawArgs.app !== "string" || !rawArgs.bug || typeof rawArgs.bug !== "object") {
        throw new Error("app (string) and bug (BugEvidenceBundle object) are required.");
      }
      const bug = rawArgs.bug as BugEvidenceBundle;
      const built = buildRegistryBugDraftYaml(rawArgs.app, bug, {
        ...(typeof rawArgs.owner === "string" ? { owner: rawArgs.owner } : {}),
        ...(rawArgs.severity === "P0" ||
        rawArgs.severity === "P1" ||
        rawArgs.severity === "P2" ||
        rawArgs.severity === "P3"
          ? { severity: rawArgs.severity }
          : {}),
        ...(typeof rawArgs.defectFamily === "string" ? { defectFamily: rawArgs.defectFamily } : {}),
        ...(Array.isArray(rawArgs.violatedInvariants)
          ? {
              violatedInvariants: rawArgs.violatedInvariants.filter(
                (x): x is string => typeof x === "string",
              ),
            }
          : {}),
      });

      const validation = await validateDraftBugInMemory(
        ctx.workspaceRoot,
        built.document.source.projectKey,
        built.fileName,
        built.yaml,
      );

      let writtenFile: string | undefined;
      if (typeof rawArgs.draftBugsDir === "string" && rawArgs.draftBugsDir.trim()) {
        const outDir = resolvePathFromWorkspace(ctx.workspaceRoot, rawArgs.draftBugsDir);
        writtenFile = writeRegistryBugDraftYaml(built, outDir);
      }

      let proposedGuardrail: { id: string; yaml: string; fileName: string } | undefined;
      if (rawArgs.proposeGuardrail && typeof rawArgs.proposeGuardrail === "object") {
        const pg = rawArgs.proposeGuardrail as {
          skillsDir: string;
          skillId: string;
          enforces: string[];
        };
        const skillsDir = resolvePathFromWorkspace(ctx.workspaceRoot, pg.skillsDir);
        const loaded = createSkillValidator().validateDirectory(skillsDir);
        const found = loaded.skills.find((s) => s.skill.id === pg.skillId);
        if (!found) {
          throw new Error(`Skill '${pg.skillId}' not found in ${pg.skillsDir}.`);
        }
        const relPath = path.relative(ctx.workspaceRoot, found.filePath).replace(/\\/g, "/");
        const builtGrd = buildProposedSkillGuardrailYaml({
          app: rawArgs.app,
          skill: found.skill,
          skillRelPath: relPath,
          enforces: pg.enforces,
        });
        proposedGuardrail = {
          id: builtGrd.document.id,
          yaml: builtGrd.yaml,
          fileName: builtGrd.fileName,
        };
      }

      return {
        provenance: "OBSERVED_DETERMINISTIC_DRAFT",
        bugId: built.document.id,
        status: built.document.status,
        fileName: built.fileName,
        schemaValidation: validation,
        ...(writtenFile ? { writtenFile } : {}),
        yaml: built.yaml,
        ...(proposedGuardrail ? { proposedGuardrail } : {}),
      };
    }

    default:
      throw new Error(`Unknown MCP tool: ${toolName}`);
  }
}

export async function readMcpResource(ctx: McpContext, uri: string): Promise<string> {
  if (uri === "defect-intelligence://graph/summary") {
    const graph = await loadKnowledgeGraph(ctx.defaultKnowledgePath);
    const countsByType: Record<string, number> = {};
    for (const node of graph.nodes) {
      countsByType[node.type] = (countsByType[node.type] ?? 0) + 1;
    }
    const confirmedBugs = graph.nodes.filter(
      (n) => n.type === "BUG" && n.attributes.status === "CONFIRMED",
    ).length;
    const draftBugs = graph.nodes.filter(
      (n) => n.type === "BUG" && n.attributes.status === "DRAFT",
    ).length;
    const activeInvariants = graph.nodes
      .filter((n) => n.type === "INVARIANT" && n.attributes.status === "ACTIVE")
      .map((n) => n.id);
    const activeGuardrails = graph.nodes
      .filter((n) => n.type === "GUARDRAIL" && n.attributes.status === "ACTIVE")
      .map((n) => n.id);

    return JSON.stringify(
      {
        sourceDigest: graph.sourceDigest,
        totalNodes: graph.nodes.length,
        totalEdges: graph.edges.length,
        countsByType,
        confirmedBugs,
        draftBugs,
        activeInvariants,
        activeGuardrails,
      },
      null,
      2,
    );
  }

  if (uri === "defect-intelligence://skills/catalog") {
    const validator = createSkillValidator();
    const res = validator.validateDirectory(ctx.defaultSkillsRoot);
    return JSON.stringify(
      {
        valid: res.valid,
        totalSkills: res.skills.length,
        skills: res.skills.map((s) => ({
          id: s.skill.id,
          app: s.skill.app,
          description: s.skill.description,
          filePath: path.relative(ctx.workspaceRoot, s.filePath).replace(/\\/g, "/"),
          preconditions: s.skill.preconditions.map((p) => p.name),
          produces: s.skill.produces.map((p) => p.name),
          codeRefs: s.skill.codeRefs,
        })),
      },
      null,
      2,
    );
  }

  throw new Error(`Unknown MCP resource URI: ${uri}`);
}
