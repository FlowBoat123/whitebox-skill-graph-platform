import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { isValidCodeUnitStableId } from "@defect-intelligence/knowledge-validator";
import type {
  BugEvidenceBundle,
  Postcondition,
  SkillDefinition,
} from "./types.js";

export interface BugKnowledgeDraftRecord {
  schemaVersion: 1;
  recordKind: "SKILL_GRAPH_OBSERVED_BUG_DRAFT";
  status: "DRAFT";
  origin: "OBSERVED_DETERMINISTIC";
  draftId: string;
  evidenceId: string;
  app: string;
  skillId: string;
  detectedAt: string;
  gitBaseRef: string;
  symptom: string;
  currentUrl: string;
  affectedSourceFiles: string[];
  affectedEndpoints: string[];
  affectedRoutes: string[];
  failedPostconditions: Array<{ kind: string; detail: string }>;
  httpErrors: Array<{ method: string; path: string; status: number; responseSnippet?: string }>;
  consoleErrors: Array<{ type: string; text: string }>;
  screenshotPath?: string;
  suggestedRegressionGuardrails: Postcondition[];
  reviewRequiredNotice: string;
}

export function buildBugDraftFromEvidence(
  app: string,
  bug: BugEvidenceBundle,
  options: { gitBaseRef?: string; detectedAt?: string } = {},
): BugKnowledgeDraftRecord {
  const canonicalKey = JSON.stringify({
    app,
    skillId: bug.skillId,
    summary: bug.summary,
    sourceFiles: [...bug.codeRefs.sourceFiles].sort(),
    failedPostconditions: bug.failedPostconditions.map((p) => `${p.kind}:${p.detail}`).sort(),
  });
  const shortHash = crypto.createHash("sha256").update(canonicalKey).digest("hex").slice(0, 8).toUpperCase();
  const projectSlug = app.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "WEBAPP";

  // Suggest deterministic regression postconditions from observed failure (never weakens existing checks)
  const suggestedGuardrails: Postcondition[] = [
    { kind: "CONSOLE_ERRORS", maxCount: 0 },
    { kind: "PAGE_ERRORS", maxCount: 0 },
  ];
  for (const err of bug.httpErrors) {
    if (err.status >= 500) {
      suggestedGuardrails.push({
        kind: "HTTP_STATUS",
        method: err.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
        path: err.path.split("?")[0] || "/",
        expectStatus: 200,
      });
    }
  }

  return {
    schemaVersion: 1,
    recordKind: "SKILL_GRAPH_OBSERVED_BUG_DRAFT",
    status: "DRAFT",
    origin: "OBSERVED_DETERMINISTIC",
    draftId: `BUG-${projectSlug}-SG-${shortHash}`,
    evidenceId: `EVD-SG-${shortHash}`,
    app,
    skillId: bug.skillId,
    detectedAt: options.detectedAt ?? new Date().toISOString(),
    gitBaseRef: options.gitBaseRef ?? "HEAD",
    symptom: bug.summary,
    currentUrl: bug.currentUrl,
    affectedSourceFiles: [...bug.codeRefs.sourceFiles].sort(),
    affectedEndpoints: [...bug.codeRefs.endpoints].sort(),
    affectedRoutes: [...bug.codeRefs.routes].sort(),
    failedPostconditions: bug.failedPostconditions.map((p) => ({
      kind: p.kind,
      detail: p.detail,
    })),
    httpErrors: bug.httpErrors.map((e) => ({
      method: e.method,
      path: e.path,
      status: e.status,
      ...(e.responseSnippet ? { responseSnippet: e.responseSnippet } : {}),
    })),
    consoleErrors: bug.consoleErrors.map((c) => ({ type: c.type, text: c.text })),
    ...(bug.screenshotPath ? { screenshotPath: bug.screenshotPath } : {}),
    suggestedRegressionGuardrails: suggestedGuardrails,
    reviewRequiredNotice:
      "Observed deterministic failure draft. Human root-cause review is required before promoting to CONFIRMED defect knowledge.",
  };
}

export function writeBugDraft(draft: BugKnowledgeDraftRecord, outDir: string): string {
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${draft.draftId.toLowerCase()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(draft, null, 2) + "\n", "utf8");
  return outPath.replace(/\\/g, "/");
}

export function attachRegressionPostcondition(
  skill: SkillDefinition,
  postcondition: Postcondition,
): SkillDefinition {
  const key = (p: Postcondition) => JSON.stringify(p);
  const exists = skill.postconditions.some((p) => key(p) === key(postcondition));
  if (exists) {
    return skill;
  }
  return {
    ...skill,
    postconditions: [...skill.postconditions, postcondition],
  };
}

export function saveSkillYaml(skill: SkillDefinition, filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringifyYaml(skill), "utf8");
}

function sanitizeProjectKey(app: string): string {
  const clean = app.trim().replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  return clean.slice(0, 128) || "webapp";
}

function normalizeRepoPath(relFile: string): string | null {
  const normalized = relFile.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes(":") ||
    /\s/.test(normalized) ||
    normalized.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
  ) {
    return null;
  }
  return normalized;
}

/**
 * Deterministically map a Skill Graph repository-relative source file path to a
 * contracts/knowledge/common.schema.json compliant CodeUnit stable ID.
 */
export function sourceFileToCodeUnitId(projectKey: string, relFile: string): string | null {
  const proj = sanitizeProjectKey(projectKey);
  const clean = normalizeRepoPath(relFile);
  if (!clean) return null;

  let candidate: string | null = null;
  if (/\.(?:tsx?|jsx?|mjs|cjs)$/i.test(clean)) {
    candidate = `${proj}:ts:FILE:${clean}#file`;
  } else if (/\.py$/i.test(clean)) {
    candidate = `${proj}:py:FILE:${clean}#file`;
  } else if (/\.(?:html?|jinja2?|j2)$/i.test(clean)) {
    candidate = `${proj}:template:FILE:${clean}#file`;
  } else if (/\.java$/i.test(clean)) {
    const dotted = clean
      .replace(/\.java$/i, "")
      .replace(/^src\/(?:main|test)\/java\//, "")
      .split("/")
      .filter(Boolean)
      .join(".");
    if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(dotted)) {
      candidate = `${proj}:java:FILE:${dotted}#file`;
    }
  }

  return candidate && isValidCodeUnitStableId(candidate) ? candidate : null;
}

/**
 * Deterministically map a Skill Graph endpoint string (e.g. "POST /comments")
 * to a contracts/knowledge/common.schema.json compliant API CodeUnit stable ID.
 */
export function endpointToCodeUnitId(projectKey: string, endpoint: string): string | null {
  const proj = sanitizeProjectKey(projectKey);
  const m = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\s+(\/[^\s]*)$/i.exec(endpoint.trim());
  if (!m?.[1] || !m[2]) return null;
  const candidate = `${proj}:api:${m[1].toUpperCase()}:${m[2]}`;
  return isValidCodeUnitStableId(candidate) ? candidate : null;
}

/**
 * Deterministically infer a Defect Family ID from observed runtime telemetry
 * using ONLY existing closed IDs from knowledge/defect-families/.
 */
export function inferDeterministicDefectFamily(bug: BugEvidenceBundle): string {
  if (bug.httpErrors.some((e) => e.status === 401 || e.status === 403)) {
    return "DF-AUTHORIZATION_ACCESS";
  }
  if (bug.httpErrors.some((e) => e.status === 400 || e.status === 422)) {
    return "DF-DATA_VALIDATION_CONTRACT";
  }
  if (bug.httpErrors.some((e) => e.status >= 500)) {
    return "DF-DATA_QUERY_PERSISTENCE";
  }
  if (bug.consoleErrors.some((c) => c.type === "pageerror" || c.type === "console.error")) {
    return "DF-UI_STATE_INTERACTION";
  }
  if (bug.failedPostconditions.some((p) => p.kind === "DOM_CONTAINS" || p.kind === "DOM_NOT_CONTAINS")) {
    return "DF-UI_STATE_INTERACTION";
  }
  return "DF-BUSINESS_RULE_WORKFLOW";
}

export interface RegistryBugDraftDocument {
  schemaVersion: 1;
  id: string;
  status: "DRAFT";
  severity: "P0" | "P1" | "P2" | "P3";
  owner: string;
  source: {
    projectKey: string;
    issueIid: number;
    issueUrl: string;
  };
  classification: {
    defectFamily: string;
  };
  analysis: {
    symptom: string;
    trigger: string;
    directCause: string;
    enablingCondition: string;
    escapeReason: string;
    violatedInvariants: string[];
  };
  impact: {
    affectedCodeUnits: string[];
    siblingScan: {
      status: "PENDING";
      method: null;
      candidates: [];
    };
  };
  resolution: {
    fixMergeRequest: null;
    regressionGuardrails: [];
    guardrailException: null;
  };
  sourceRefs: Array<{
    kind: "RUNTIME_TRACE";
    uri: string;
    commitSha: null;
    contentHash: string;
  }>;
}

export interface BuiltRegistryBugDraft {
  document: RegistryBugDraftDocument;
  yaml: string;
  issueIid: number;
  fileName: string;
}

/**
 * Compile an observed deterministic BugEvidenceBundle into a contracts/knowledge/bug.schema.json
 * compliant DRAFT YAML document. Always emits status="DRAFT" with placeholder RCA so human review
 * is strictly required before CONFIRMED promotion (AGENTS.md Rules #5 & #9).
 */
export function buildRegistryBugDraftYaml(
  app: string,
  bug: BugEvidenceBundle,
  options: {
    owner?: string;
    severity?: "P0" | "P1" | "P2" | "P3";
    defectFamily?: string;
    violatedInvariants?: string[];
  } = {},
): BuiltRegistryBugDraft {
  const projectKey = sanitizeProjectKey(app);
  const canonicalPayload = JSON.stringify({
    projectKey,
    skillId: bug.skillId,
    summary: bug.summary,
    sourceFiles: [...bug.codeRefs.sourceFiles].sort(),
    endpoints: [...bug.codeRefs.endpoints].sort(),
    failedPostconditions: bug.failedPostconditions.map((p) => `${p.kind}:${p.detail}`).sort(),
  });
  const contentHash = crypto.createHash("sha256").update(canonicalPayload).digest("hex");
  const shortHash = contentHash.slice(0, 8);
  // Deterministic positive integer issueIid in [1, 268435456]
  const issueIid = (Number.parseInt(contentHash.slice(0, 7), 16) % 268_435_455) + 1;

  const codeUnits = new Set<string>();
  for (const sf of bug.codeRefs.sourceFiles) {
    const id = sourceFileToCodeUnitId(projectKey, sf);
    if (id) codeUnits.add(id);
  }
  for (const ep of bug.codeRefs.endpoints) {
    const id = endpointToCodeUnitId(projectKey, ep);
    if (id) codeUnits.add(id);
  }

  const hasSevereCrash =
    bug.httpErrors.some((e) => e.status >= 500) ||
    bug.consoleErrors.some((c) => c.type === "pageerror");
  const severity = options.severity ?? (hasSevereCrash ? "P1" : "P2");
  const defectFamily = options.defectFamily ?? inferDeterministicDefectFamily(bug);

  const safeSummary = bug.summary.replace(/\s+/g, " ").trim().slice(0, 400) || "Observed deterministic skill failure.";
  const triggerLines = [
    `Executed deterministic skill '${bug.skillId}' on '${projectKey}'.`,
    ...(bug.failedPostconditions.length > 0
      ? [`Failed postconditions: ${bug.failedPostconditions.map((p) => `${p.kind} (${p.detail})`).join("; ").slice(0, 350)}`]
      : []),
    ...(bug.httpErrors.length > 0
      ? [`Observed HTTP errors: ${bug.httpErrors.map((e) => `${e.method} ${e.path.split("?")[0]} -> ${e.status}`).join(", ")}`]
      : []),
  ];

  const document: RegistryBugDraftDocument = {
    schemaVersion: 1,
    id: `BUG:${projectKey}:${issueIid}`,
    status: "DRAFT",
    severity,
    owner: options.owner ?? "skill-graph-verifier",
    source: {
      projectKey,
      issueIid,
      issueUrl: `skill-graph:observed:${projectKey}:${issueIid}`,
    },
    classification: {
      defectFamily,
    },
    analysis: {
      symptom: safeSummary,
      trigger: triggerLines.join(" "),
      directCause: "Chưa xác nhận.",
      enablingCondition: "Chưa xác nhận.",
      escapeReason: "Chưa xác nhận.",
      violatedInvariants: [...new Set(options.violatedInvariants ?? [])].sort(),
    },
    impact: {
      affectedCodeUnits: [...codeUnits].sort(),
      siblingScan: {
        status: "PENDING",
        method: null,
        candidates: [],
      },
    },
    resolution: {
      fixMergeRequest: null,
      regressionGuardrails: [],
      guardrailException: null,
    },
    sourceRefs: [
      {
        kind: "RUNTIME_TRACE",
        uri: `skill-graph:${projectKey}:${bug.skillId}:${shortHash}`,
        commitSha: null,
        contentHash,
      },
    ],
  };

  return {
    document,
    yaml: stringifyYaml(document),
    issueIid,
    fileName: `${issueIid}.yaml`,
  };
}

export interface ProposedGuardrailDocument {
  schemaVersion: 1;
  id: string;
  name: string;
  type: "SKILL_GRAPH_VERIFIER";
  status: "PROPOSED";
  owner: string;
  locator: {
    project: string;
    path: string;
    ruleId: string;
  };
  enforces: string[];
  sourceRefs: [];
}

/**
 * Emit a contracts/knowledge/guardrail.schema.json compliant PROPOSED SKILL_GRAPH_VERIFIER
 * guardrail record linking a skill YAML to one or more invariants.
 */
export function buildProposedSkillGuardrailYaml(input: {
  app: string;
  skill: SkillDefinition;
  skillRelPath: string;
  enforces: string[];
  guardrailId?: string;
  owner?: string;
}): { document: ProposedGuardrailDocument; yaml: string; fileName: string } {
  const project = sanitizeProjectKey(input.app);
  const projSlug = project.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "APP";
  const skillSlug = input.skill.id.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "SKILL";
  const id = input.guardrailId ?? `GRD-${projSlug}-${skillSlug}`;
  const cleanSkillPath = normalizeRepoPath(input.skillRelPath) ?? `skills/${project}/${input.skill.id}.yaml`;
  const enforces = [...new Set(input.enforces)].sort();
  if (enforces.length === 0) {
    throw new Error("buildProposedSkillGuardrailYaml requires at least one invariant ID in enforces.");
  }

  const document: ProposedGuardrailDocument = {
    schemaVersion: 1,
    id,
    name: `${input.skill.id} white-box skill verifier`,
    type: "SKILL_GRAPH_VERIFIER",
    status: "PROPOSED",
    owner: input.owner ?? "skill-graph-verifier",
    locator: {
      project,
      path: cleanSkillPath,
      ruleId: input.skill.id,
    },
    enforces,
    sourceRefs: [],
  };

  return {
    document,
    yaml: stringifyYaml(document),
    fileName: `${id}.yaml`,
  };
}

export function writeRegistryBugDraftYaml(draft: BuiltRegistryBugDraft, bugsDir: string): string {
  fs.mkdirSync(bugsDir, { recursive: true });
  const outPath = path.join(bugsDir, draft.fileName);
  fs.writeFileSync(outPath, draft.yaml, "utf8");
  return outPath.replace(/\\/g, "/");
}
