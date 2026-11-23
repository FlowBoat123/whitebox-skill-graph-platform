import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  compileGraph,
  loadRegistry,
  type GraphNode,
  type KnowledgeGraph,
} from "@defect-intelligence/knowledge-validator";
import { listChangedFiles } from "./impact.js";
import { endpointToCodeUnitId, sourceFileToCodeUnitId } from "./knowledge-bridge.js";
import type { ImpactMatch, LoadedSkill } from "./types.js";

const MAX_DIFF_CHARS_PER_SKILL = 16000;

export type DefectAwareSelectionReason =
  | "DIRECT_CODE_OVERLAP"
  | "CONFIRMED_DEFECT_HISTORY"
  | "OBSERVED_DRAFT_HISTORY"
  | "ACTIVE_GUARDRAIL_ENFORCES_INVARIANT"
  | "PROPOSED_GUARDRAIL_ENFORCES_INVARIANT"
  | "INVARIANT_PATH_GLOB_MATCH"
  | "SIBLING_DEFECT_PROPAGATION";

export interface DefectAwareImpactMatch extends ImpactMatch {
  riskScore: number;
  selectionReasons: DefectAwareSelectionReason[];
  /** Verified/enforced Defect Knowledge Graph signals (AGENTS.md Rule #9). */
  confirmedSignals: {
    bugIds: string[];
    invariantIds: string[];
    activeGuardrailIds: string[];
    siblingCodeUnits: string[];
  };
  /** Unconfirmed observed/proposed signals kept strictly separate from confirmed knowledge. */
  observedDraftSignals: {
    draftBugIds: string[];
    proposedInvariantIds: string[];
    proposedGuardrailIds: string[];
  };
}

export interface DefectAwareImpactResult {
  repoPath?: string;
  baseRef?: string;
  changedFiles: string[];
  knowledgeSourceDigest: string;
  affectedSkills: DefectAwareImpactMatch[];
  scopedDiffBySkill: Record<string, string>;
}

export interface DefectAwareImpactRequest {
  skills: LoadedSkill[];
  knowledgeGraph: KnowledgeGraph;
  repoPath?: string;
  baseRef?: string;
  /** Optional explicit changed file list (bypasses git diff when supplied). */
  changedFiles?: string[];
  /** Optional project key override when matching code units & invariants. */
  projectKey?: string;
}

export interface DefectKnowledgeQuery {
  filePaths?: string[];
  projectKey?: string;
  defectFamily?: string;
  query?: string;
}

export interface DefectKnowledgeQueryResult {
  sourceDigest: string;
  confirmedKnowledge: {
    bugs: Array<Record<string, unknown>>;
    invariants: Array<Record<string, unknown>>;
    activeGuardrails: Array<Record<string, unknown>>;
    siblingCandidates: Array<{ bugId: string; codeUnit: string; verdict: string }>;
  };
  observedDrafts: {
    draftBugs: Array<Record<string, unknown>>;
    proposedInvariants: Array<Record<string, unknown>>;
    proposedGuardrails: Array<Record<string, unknown>>;
  };
}

function normalizeRelPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function matchesSourceRef(changedFile: string, sourceRef: string): boolean {
  const c = normalizeRelPath(changedFile);
  const s = normalizeRelPath(sourceRef);
  if (c === s) return true;
  if (s.endsWith("/") && c.startsWith(s)) return true;
  return false;
}

/** Deterministic POSIX glob matcher supporting **, *, and ? without external dependencies. */
export function matchesPathGlob(filePath: string, pattern: string): boolean {
  const normalizedFile = normalizeRelPath(filePath);
  const normalizedPat = normalizeRelPath(pattern);
  let regexStr = "^";
  for (let i = 0; i < normalizedPat.length; i++) {
    const ch = normalizedPat[i]!;
    if (ch === "*" && normalizedPat[i + 1] === "*") {
      if (normalizedPat[i + 2] === "/") {
        regexStr += "(?:.*/)?";
        i += 2;
      } else {
        regexStr += ".*";
        i += 1;
      }
    } else if (ch === "*") {
      regexStr += "[^/]*";
    } else if (ch === "?") {
      regexStr += "[^/]";
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr).test(normalizedFile);
}

/** Extract projectKey and repo-relative file path or API endpoint from a CodeUnit stable ID. */
export function parseCodeUnitStableId(
  codeUnitId: string,
): { projectKey: string; kind: "file" | "api" | "other"; value: string } | null {
  const fileMatch = /^([A-Za-z0-9][A-Za-z0-9._-]*):(?:ts|py|template):[^:]+:([^#]+)#/.exec(codeUnitId);
  if (fileMatch?.[1] && fileMatch[2]) {
    return { projectKey: fileMatch[1], kind: "file", value: normalizeRelPath(fileMatch[2]) };
  }
  const apiMatch = /^([A-Za-z0-9][A-Za-z0-9._-]*):api:(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS):(\/[^\s]*)$/.exec(
    codeUnitId,
  );
  if (apiMatch?.[1] && apiMatch[2] && apiMatch[3]) {
    return { projectKey: apiMatch[1], kind: "api", value: `${apiMatch[2]} ${apiMatch[3]}` };
  }
  const otherMatch = /^([A-Za-z0-9][A-Za-z0-9._-]*):/.exec(codeUnitId);
  if (otherMatch?.[1]) {
    return { projectKey: otherMatch[1], kind: "other", value: codeUnitId };
  }
  return null;
}

/**
 * Load a compiled Defect Knowledge Graph either from a prebuilt JSON index file
 * (e.g. build/knowledge-index.json) or by compiling a registry root directory on the fly.
 */
export async function loadKnowledgeGraph(pathOrRoot: string): Promise<KnowledgeGraph> {
  const abs = path.resolve(pathOrRoot);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    return JSON.parse(fs.readFileSync(abs, "utf8")) as KnowledgeGraph;
  }
  const registry = await loadRegistry(abs);
  return compileGraph(registry);
}

function confirmedSeverityScore(severity: unknown): number {
  switch (severity) {
    case "P0":
      return 40;
    case "P1":
      return 30;
    case "P2":
      return 18;
    default:
      return 8;
  }
}

function draftSeverityScore(severity: unknown): number {
  return severity === "P0" || severity === "P1" ? 10 : 5;
}

function guardrailMatchesSkill(guardrail: GraphNode, loaded: LoadedSkill, projectKey: string): boolean {
  const locator = guardrail.attributes.locator as
    | { project?: string; path?: string | null; ruleId?: string | null }
    | undefined;
  if (!locator) return false;
  if (locator.project && locator.project !== projectKey && locator.project !== loaded.skill.app) {
    return false;
  }
  if (locator.ruleId && locator.ruleId === loaded.skill.id) {
    return true;
  }
  if (locator.path) {
    const normLoc = normalizeRelPath(locator.path);
    const normFile = normalizeRelPath(loaded.filePath);
    if (normFile === normLoc || normFile.endsWith(`/${normLoc}`)) {
      return true;
    }
  }
  return false;
}

function invariantAppliesToFile(
  invariant: GraphNode,
  projectKey: string,
  filePath: string,
): boolean {
  const status = String(invariant.attributes.status ?? "");
  if (status === "DEPRECATED") return false;
  const appliesTo = invariant.attributes.appliesTo as
    | { projects?: string[]; pathGlobs?: string[] }
    | undefined;
  if (!appliesTo) return false;
  const projects = Array.isArray(appliesTo.projects) ? appliesTo.projects : [];
  if (projects.length > 0 && !projects.includes(projectKey)) return false;
  const globs = Array.isArray(appliesTo.pathGlobs) ? appliesTo.pathGlobs : [];
  return globs.some((g) => matchesPathGlob(filePath, g));
}

function runScopedGitDiff(repoPath: string, baseRef: string, files: string[]): string {
  if (files.length === 0) return "";
  try {
    let diff = execFileSync("git", ["-C", repoPath, "diff", baseRef, "--", ...files], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    if (diff.length > MAX_DIFF_CHARS_PER_SKILL) {
      diff = `${diff.slice(0, MAX_DIFF_CHARS_PER_SKILL)}\n... [truncated]`;
    }
    return diff;
  } catch {
    return "";
  }
}

/**
 * Defect-Aware Risk-Prioritized Skill Impact Selection (0-LLM, strictly deterministic).
 * Unites Git diff file overlap with compiled Defect Knowledge Graph signals:
 * - Historical CONFIRMED & DRAFT BUG records via AFFECTS edges
 * - Violated & path-glob-matched INVARIANT nodes
 * - ACTIVE / PROPOSED SKILL_GRAPH_VERIFIER GUARDRAIL nodes via ENFORCES edges
 * - Cross-file SIBLING_CANDIDATE defect propagation (pulling in unmodified sibling skills)
 */
export function selectDefectAwareImpactedSkills(
  request: DefectAwareImpactRequest,
): DefectAwareImpactResult {
  const changedFiles = (
    request.changedFiles
      ? request.changedFiles.map(normalizeRelPath).filter(Boolean)
      : request.repoPath
        ? listChangedFiles(request.repoPath, request.baseRef ?? "HEAD")
        : []
  ).sort();
  const uniqueChanged = [...new Set(changedFiles)];

  const graph = request.knowledgeGraph;
  const nodeById = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
  const bugs = graph.nodes.filter((n) => n.type === "BUG");
  const invariants = graph.nodes.filter((n) => n.type === "INVARIANT");
  const guardrails = graph.nodes.filter((n) => n.type === "GUARDRAIL");

  const codeUnitToBugIds = new Map<string, Set<string>>();
  const bugToViolatedInvariants = new Map<string, Set<string>>();
  const bugToRiskySiblings = new Map<string, Set<string>>();
  const guardrailToInvariants = new Map<string, Set<string>>();

  for (const edge of graph.edges) {
    if (edge.type === "AFFECTS") {
      if (!codeUnitToBugIds.has(edge.to)) codeUnitToBugIds.set(edge.to, new Set());
      codeUnitToBugIds.get(edge.to)!.add(edge.from);
    } else if (edge.type === "VIOLATES") {
      if (!bugToViolatedInvariants.has(edge.from)) bugToViolatedInvariants.set(edge.from, new Set());
      bugToViolatedInvariants.get(edge.from)!.add(edge.to);
    } else if (edge.type === "SIBLING_CANDIDATE") {
      const verdict = String(edge.attributes?.verdict ?? "");
      if (verdict === "AFFECTED" || verdict === "DEFERRED") {
        if (!bugToRiskySiblings.has(edge.from)) bugToRiskySiblings.set(edge.from, new Set());
        bugToRiskySiblings.get(edge.from)!.add(edge.to);
      }
    } else if (edge.type === "ENFORCES") {
      if (!guardrailToInvariants.has(edge.from)) guardrailToInvariants.set(edge.from, new Set());
      guardrailToInvariants.get(edge.from)!.add(edge.to);
    }
  }

  // Index changed files -> bugs directly affecting those changed files -> violated invariants & sibling code units
  const changedBugsByProject = new Map<string, Set<string>>();
  const violatedInvariantsFromChangedBugs = new Set<string>();
  const propagatedSiblingCodeUnits = new Map<string, Set<string>>(); // codeUnitId -> triggering bugIds

  for (const [cuId, bugIds] of codeUnitToBugIds.entries()) {
    const parsed = parseCodeUnitStableId(cuId);
    if (!parsed || parsed.kind !== "file") continue;
    if (!uniqueChanged.includes(parsed.value)) continue;
    for (const bugId of bugIds) {
      if (!changedBugsByProject.has(parsed.projectKey)) {
        changedBugsByProject.set(parsed.projectKey, new Set());
      }
      changedBugsByProject.get(parsed.projectKey)!.add(bugId);
      for (const invId of bugToViolatedInvariants.get(bugId) ?? []) {
        violatedInvariantsFromChangedBugs.add(invId);
      }
      for (const sibCu of bugToRiskySiblings.get(bugId) ?? []) {
        if (!propagatedSiblingCodeUnits.has(sibCu)) {
          propagatedSiblingCodeUnits.set(sibCu, new Set());
        }
        propagatedSiblingCodeUnits.get(sibCu)!.add(bugId);
      }
    }
  }

  // Ensure deterministic scan over skills
  const sortedSkills = [...request.skills].sort((a, b) => a.skill.id.localeCompare(b.skill.id));
  const affectedSkills: DefectAwareImpactMatch[] = [];
  const scopedDiffBySkill: Record<string, string> = {};

  for (const loaded of sortedSkills) {
    const projectKey = request.projectKey ?? loaded.skill.app;
    const matchedSourceFiles = loaded.skill.codeRefs.sourceFiles
      .filter((ref) => uniqueChanged.some((cf) => matchesSourceRef(cf, ref)))
      .map(normalizeRelPath)
      .sort();

    // Map this skill's codeRefs to canonical CodeUnit stable IDs
    const skillCodeUnits = new Set<string>();
    for (const sf of loaded.skill.codeRefs.sourceFiles) {
      const cu = sourceFileToCodeUnitId(projectKey, sf);
      if (cu) skillCodeUnits.add(cu);
    }
    for (const ep of loaded.skill.codeRefs.endpoints) {
      const cu = endpointToCodeUnitId(projectKey, ep);
      if (cu) skillCodeUnits.add(cu);
    }

    const reasons = new Set<DefectAwareSelectionReason>();
    const confirmedBugIds = new Set<string>();
    const draftBugIds = new Set<string>();
    const confirmedInvariantIds = new Set<string>();
    const proposedInvariantIds = new Set<string>();
    const activeGuardrailIds = new Set<string>();
    const proposedGuardrailIds = new Set<string>();
    const matchedSiblingCodeUnits = new Set<string>();

    let riskScore = 0;

    // 1. Direct Git diff overlap
    if (matchedSourceFiles.length > 0) {
      riskScore += 10;
      reasons.add("DIRECT_CODE_OVERLAP");
    }

    // 2. Sibling defect propagation (catches unmodified sibling code units!)
    for (const cu of skillCodeUnits) {
      const triggerBugs = propagatedSiblingCodeUnits.get(cu);
      if (triggerBugs && triggerBugs.size > 0) {
        matchedSiblingCodeUnits.add(cu);
        reasons.add("SIBLING_DEFECT_PROPAGATION");
        for (const bugId of triggerBugs) {
          const bugNode = nodeById.get(bugId);
          if (bugNode?.attributes.status === "CONFIRMED") confirmedBugIds.add(bugId);
          else if (bugNode?.attributes.status === "DRAFT") draftBugIds.add(bugId);
        }
      }
    }
    if (matchedSiblingCodeUnits.size > 0) {
      riskScore += 15;
    }

    // 3. Invariants matched via pathGlobs on this skill's directly changed files
    const matchedInvariantsForSkill = new Set<string>();
    if (matchedSourceFiles.length > 0) {
      for (const inv of invariants) {
        if (matchedSourceFiles.some((mf) => invariantAppliesToFile(inv, projectKey, mf))) {
          matchedInvariantsForSkill.add(inv.id);
          reasons.add("INVARIANT_PATH_GLOB_MATCH");
          if (inv.attributes.status === "ACTIVE") {
            confirmedInvariantIds.add(inv.id);
            riskScore += 12;
          } else if (inv.attributes.status === "PROPOSED") {
            proposedInvariantIds.add(inv.id);
            riskScore += 5;
          }
        }
      }
    }

    // 4. Guardrails linked to this skill that enforce either a matched invariant or a violated-by-changed-bug invariant
    const skillGuardrails = guardrails.filter((g) => {
      const st = String(g.attributes.status ?? "");
      return st !== "DISABLED" && st !== "SUPERSEDED" && guardrailMatchesSkill(g, loaded, projectKey);
    });
    for (const grd of skillGuardrails) {
      const enforcedInvs = guardrailToInvariants.get(grd.id) ?? new Set<string>();
      const triggered = [...enforcedInvs].filter(
        (invId) => matchedInvariantsForSkill.has(invId) || violatedInvariantsFromChangedBugs.has(invId),
      );
      if (triggered.length > 0) {
        for (const invId of triggered) {
          const invNode = nodeById.get(invId);
          if (invNode?.attributes.status === "ACTIVE") confirmedInvariantIds.add(invId);
          else if (invNode?.attributes.status === "PROPOSED") proposedInvariantIds.add(invId);
        }
        if (grd.attributes.status === "ACTIVE") {
          activeGuardrailIds.add(grd.id);
          reasons.add("ACTIVE_GUARDRAIL_ENFORCES_INVARIANT");
          riskScore += 25;
        } else if (grd.attributes.status === "PROPOSED") {
          proposedGuardrailIds.add(grd.id);
          reasons.add("PROPOSED_GUARDRAIL_ENFORCES_INVARIANT");
          riskScore += 10;
        }
      }
    }

    // Stop if this skill has no direct overlap, no sibling propagation, and no violated-bug guardrail trigger
    if (reasons.size === 0) continue;

    // 5. Historical defect coupling on this skill's CodeUnits (CONFIRMED vs DRAFT strictly separated)
    const seenHistoryBugs = new Set<string>();
    for (const cu of skillCodeUnits) {
      for (const bugId of codeUnitToBugIds.get(cu) ?? []) {
        if (seenHistoryBugs.has(bugId)) continue;
        seenHistoryBugs.add(bugId);
        const bugNode = nodeById.get(bugId);
        if (!bugNode || bugNode.attributes.status === "SUPERSEDED") continue;
        if (bugNode.attributes.status === "CONFIRMED") {
          confirmedBugIds.add(bugId);
          reasons.add("CONFIRMED_DEFECT_HISTORY");
          riskScore += confirmedSeverityScore(bugNode.attributes.severity);
          for (const invId of bugToViolatedInvariants.get(bugId) ?? []) {
            const invNode = nodeById.get(invId);
            if (invNode?.attributes.status === "ACTIVE") confirmedInvariantIds.add(invId);
            else if (invNode?.attributes.status === "PROPOSED") proposedInvariantIds.add(invId);
          }
        } else if (bugNode.attributes.status === "DRAFT") {
          draftBugIds.add(bugId);
          reasons.add("OBSERVED_DRAFT_HISTORY");
          riskScore += draftSeverityScore(bugNode.attributes.severity);
        }
      }
    }

    affectedSkills.push({
      skillId: loaded.skill.id,
      filePath: loaded.filePath,
      matchedSourceFiles,
      codeRefs: loaded.skill.codeRefs,
      riskScore,
      selectionReasons: [...reasons].sort(),
      confirmedSignals: {
        bugIds: [...confirmedBugIds].sort(),
        invariantIds: [...confirmedInvariantIds].sort(),
        activeGuardrailIds: [...activeGuardrailIds].sort(),
        siblingCodeUnits: [...matchedSiblingCodeUnits].sort(),
      },
      observedDraftSignals: {
        draftBugIds: [...draftBugIds].sort(),
        proposedInvariantIds: [...proposedInvariantIds].sort(),
        proposedGuardrailIds: [...proposedGuardrailIds].sort(),
      },
    });

    if (request.repoPath && matchedSourceFiles.length > 0) {
      const relevantChanged = uniqueChanged.filter((cf) =>
        matchedSourceFiles.some((ref) => matchesSourceRef(cf, ref)),
      );
      const diff = runScopedGitDiff(request.repoPath, request.baseRef ?? "HEAD", relevantChanged);
      if (diff) scopedDiffBySkill[loaded.skill.id] = diff;
    }
  }

  // Deterministic risk-first ordering: (riskScore DESC, skillId ASC)
  affectedSkills.sort((a, b) => b.riskScore - a.riskScore || a.skillId.localeCompare(b.skillId));

  // Suppress unused variable warning for bugs index when graph has no bug nodes
  void bugs;

  return {
    ...(request.repoPath ? { repoPath: request.repoPath.replace(/\\/g, "/") } : {}),
    ...(request.baseRef ? { baseRef: request.baseRef } : {}),
    changedFiles: uniqueChanged,
    knowledgeSourceDigest: graph.sourceDigest,
    affectedSkills,
    scopedDiffBySkill,
  };
}

/**
 * Deterministic read-only query over a compiled Defect Knowledge Graph.
 * Strictly separates confirmedKnowledge from observedDrafts (AGENTS.md Rule #9).
 */
export function queryDefectKnowledgeGraph(
  graph: KnowledgeGraph,
  query: DefectKnowledgeQuery,
): DefectKnowledgeQueryResult {
  const normFiles = (query.filePaths ?? []).map(normalizeRelPath).filter(Boolean);
  const needle = query.query?.trim().toLowerCase() ?? "";

  const matchesBug = (bug: GraphNode): boolean => {
    const source = bug.attributes.source as { projectKey?: string } | undefined;
    const classification = bug.attributes.classification as { defectFamily?: string } | undefined;
    if (query.projectKey && source?.projectKey !== query.projectKey) return false;
    if (query.defectFamily && classification?.defectFamily !== query.defectFamily) return false;
    if (normFiles.length > 0) {
      const impact = bug.attributes.impact as { affectedCodeUnits?: string[] } | undefined;
      const units = impact?.affectedCodeUnits ?? [];
      const fileHit = units.some((cu) => {
        const parsed = parseCodeUnitStableId(cu);
        return parsed?.kind === "file" && normFiles.some((f) => f === parsed.value || f.endsWith(`/${parsed.value}`));
      });
      if (!fileHit) return false;
    }
    if (needle) {
      return JSON.stringify(bug.attributes).toLowerCase().includes(needle);
    }
    return true;
  };

  const matchedBugs = graph.nodes.filter((n) => n.type === "BUG" && matchesBug(n));
  const matchedBugIds = new Set(matchedBugs.map((b) => b.id));

  const violatedInvIds = new Set<string>();
  const guardedIds = new Set<string>();
  const siblingCandidates: Array<{ bugId: string; codeUnit: string; verdict: string }> = [];

  for (const edge of graph.edges) {
    if (edge.type === "VIOLATES" && matchedBugIds.has(edge.from)) {
      violatedInvIds.add(edge.to);
    } else if (edge.type === "GUARDED_BY" && matchedBugIds.has(edge.from)) {
      guardedIds.add(edge.to);
    } else if (edge.type === "SIBLING_CANDIDATE" && matchedBugIds.has(edge.from)) {
      siblingCandidates.push({
        bugId: edge.from,
        codeUnit: edge.to,
        verdict: String(edge.attributes?.verdict ?? "UNKNOWN"),
      });
    }
  }

  const matchedInvariants = graph.nodes.filter((n) => {
    if (n.type !== "INVARIANT") return false;
    if (violatedInvIds.has(n.id)) return true;
    const appliesTo = n.attributes.appliesTo as { projects?: string[]; pathGlobs?: string[] } | undefined;
    const projects = appliesTo?.projects ?? [];
    if (query.projectKey && projects.length > 0 && !projects.includes(query.projectKey)) return false;
    if (normFiles.length > 0) {
      const globs = appliesTo?.pathGlobs ?? [];
      return normFiles.some((f) => globs.some((g) => matchesPathGlob(f, g)));
    }
    if (needle) {
      return JSON.stringify(n.attributes).toLowerCase().includes(needle);
    }
    return !query.defectFamily;
  });
  const matchedInvIds = new Set(matchedInvariants.map((i) => i.id));

  for (const edge of graph.edges) {
    if (edge.type === "ENFORCES" && matchedInvIds.has(edge.to)) {
      guardedIds.add(edge.from);
    }
  }

  const matchedGuardrails = graph.nodes.filter((n) => {
    if (n.type !== "GUARDRAIL") return false;
    if (guardedIds.has(n.id)) return true;
    const loc = n.attributes.locator as { project?: string } | undefined;
    if (query.projectKey && loc?.project !== query.projectKey) return false;
    if (needle) {
      return JSON.stringify(n.attributes).toLowerCase().includes(needle);
    }
    return normFiles.length === 0 && !query.defectFamily;
  });

  const summarize = (n: GraphNode): Record<string, unknown> => ({
    id: n.id,
    type: n.type,
    status: n.attributes.status,
    ...n.attributes,
  });

  siblingCandidates.sort(
    (a, b) => a.bugId.localeCompare(b.bugId) || a.codeUnit.localeCompare(b.codeUnit),
  );

  return {
    sourceDigest: graph.sourceDigest,
    confirmedKnowledge: {
      bugs: matchedBugs.filter((b) => b.attributes.status === "CONFIRMED").map(summarize),
      invariants: matchedInvariants.filter((i) => i.attributes.status === "ACTIVE").map(summarize),
      activeGuardrails: matchedGuardrails.filter((g) => g.attributes.status === "ACTIVE").map(summarize),
      siblingCandidates,
    },
    observedDrafts: {
      draftBugs: matchedBugs.filter((b) => b.attributes.status === "DRAFT").map(summarize),
      proposedInvariants: matchedInvariants.filter((i) => i.attributes.status === "PROPOSED").map(summarize),
      proposedGuardrails: matchedGuardrails.filter((g) => g.attributes.status === "PROPOSED").map(summarize),
    },
  };
}
