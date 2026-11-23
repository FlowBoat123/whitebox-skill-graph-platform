import { execFileSync } from "node:child_process";
import type { KnowledgeGraph } from "@defect-intelligence/knowledge-validator";
import {
  selectDefectAwareImpactedSkills,
  type LoadedSkill,
} from "@defect-intelligence/skill-graph";
import { median, percentile } from "./statistics.js";

export type RealCommitKind =
  | "DOCS_CI_DEPS_ONLY"
  | "TESTS_ONLY"
  | "UNRELATED_APP_CODE"
  | "SKILL_GROUNDED_APP_CODE";

export interface RealGitCommitEval {
  sha: string;
  shortSha: string;
  date: string;
  subject: string;
  changedFilesCount: number;
  changedFilesSample: string[];
  commitKind: RealCommitKind;
  totalAppSkills: number;
  impactedSkillIds: string[];
  topSkillId: string | null;
  topRiskScore: number;
  skippedAllSkills: boolean;
  selectionLatencyMs: number;
}

export interface RealGitRepoReport {
  app: string;
  repoPath: string;
  commitsAnalyzed: number;
  totalAppSkills: number;
  commitsWithImpact: number;
  commitsSkippedNoImpact: number;
  noImpactSkipRatePct: number;
  totalPossibleSkillRuns: number;
  selectedSkillRuns: number;
  testReductionRatePct: number;
  medianSelectionMs: number;
  p95SelectionMs: number;
  kindBreakdown: Record<RealCommitKind, number>;
  commits: RealGitCommitEval[];
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function matchesSourceRef(changedFile: string, sourceRef: string): boolean {
  const c = normalizePath(changedFile);
  const s = normalizePath(sourceRef);
  if (c === s) return true;
  if (s.endsWith("/") && c.startsWith(s)) return true;
  return false;
}

function classifyRealCommit(changedFiles: string[], hasSkillImpact: boolean): RealCommitKind {
  if (hasSkillImpact) return "SKILL_GROUNDED_APP_CODE";
  if (changedFiles.length === 0) return "DOCS_CI_DEPS_ONLY";
  const isDocCiDep = (f: string) =>
    /^(README|CHANGELOG|LICENSE|Dockerfile|docker-compose|package\.json|package-lock\.json|yarn\.lock|requirements.*\.txt|pyproject\.toml|\.github\/|\.circleci\/|\.nvmrc|\.node-version|\.eslint|tsconfig|vite\.config|webpack\.config|docs\/)/i.test(
      f,
    ) || /\.(md|txt|yml|yaml|lock|ini|cfg|toml|dockerfile)$/i.test(f);
  if (changedFiles.every(isDocCiDep)) return "DOCS_CI_DEPS_ONLY";
  const isTestOnly = (f: string) =>
    /^(cypress\/|tests\/|__tests__\/)/i.test(f) ||
    /(?:^|\/)(?:test_|tests\.py|.*\.spec\.|.*\.test\.|.*\.cy\.)/i.test(f);
  if (changedFiles.every((f) => isTestOnly(f) || isDocCiDep(f))) return "TESTS_ONLY";
  return "UNRELATED_APP_CODE";
}

/**
 * Read-only replay of real historical Git commits (`git log` + `git diff-tree`)
 * without ever modifying HEAD or the working tree.
 * Evaluates authentic developer Test Reduction Rate, NO_IMPACT skip accuracy, and impact latency (0-LLM).
 */
export function evaluateRealGitHistory(input: {
  app: string;
  repoPath: string;
  skills: LoadedSkill[];
  knowledgeGraph?: KnowledgeGraph;
  maxCommits?: number;
}): RealGitRepoReport {
  const maxCommits = input.maxCommits ?? 50;
  // Exclude root/initial shallow boundary commit by requiring parent (`^` check via %P)
  const rawLog = execFileSync(
    "git",
    ["-C", input.repoPath, "log", `-n`, `${maxCommits + 1}`, "--pretty=format:%H\t%h\t%cs\t%P\t%s"],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );

  const lines = rawLog
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const commits: RealGitCommitEval[] = [];
  const latencies: number[] = [];
  const kindBreakdown: Record<RealCommitKind, number> = {
    DOCS_CI_DEPS_ONLY: 0,
    TESTS_ONLY: 0,
    UNRELATED_APP_CODE: 0,
    SKILL_GROUNDED_APP_CODE: 0,
  };

  for (const line of lines) {
    if (commits.length >= maxCommits) break;
    const parts = line.split("\t");
    const sha = parts[0] ?? "";
    const shortSha = parts[1] ?? "";
    const date = parts[2] ?? "";
    const parents = (parts[3] ?? "").trim();
    const subject = parts.slice(4).join("\t").trim();
    // Skip shallow boundary commits with no parent (which would list the entire repo as added!)
    if (!sha || !parents) continue;
    const firstParent = parents.split(/\s+/)[0]!;

    const diffOut = execFileSync(
      "git",
      ["-C", input.repoPath, "diff", "--name-only", firstParent, sha],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    const changedFiles = diffOut
      .split(/\r?\n/)
      .map(normalizePath)
      .filter(Boolean)
      .sort();

    const t0 = performance.now();
    let impactedSkillIds: string[];
    let topSkillId: string | null = null;
    let topRiskScore = 0;

    if (input.knowledgeGraph) {
      const da = selectDefectAwareImpactedSkills({
        skills: input.skills,
        knowledgeGraph: input.knowledgeGraph,
        changedFiles,
      });
      impactedSkillIds = da.affectedSkills.map((s) => s.skillId);
      topSkillId = da.affectedSkills[0]?.skillId ?? null;
      topRiskScore = da.affectedSkills[0]?.riskScore ?? 0;
    } else {
      impactedSkillIds = input.skills
        .filter((l) =>
          l.skill.codeRefs.sourceFiles.some((sf) =>
            changedFiles.some((cf) => matchesSourceRef(cf, sf)),
          ),
        )
        .map((l) => l.skill.id)
        .sort();
      topSkillId = impactedSkillIds[0] ?? null;
    }
    const elapsedMs = Number((performance.now() - t0).toFixed(3));
    latencies.push(elapsedMs);

    const kind = classifyRealCommit(changedFiles, impactedSkillIds.length > 0);
    kindBreakdown[kind] += 1;

    commits.push({
      sha,
      shortSha,
      date,
      subject: subject.slice(0, 120),
      changedFilesCount: changedFiles.length,
      changedFilesSample: changedFiles.slice(0, 6),
      commitKind: kind,
      totalAppSkills: input.skills.length,
      impactedSkillIds,
      topSkillId,
      topRiskScore,
      skippedAllSkills: impactedSkillIds.length === 0,
      selectionLatencyMs: elapsedMs,
    });
  }

  const commitsAnalyzed = commits.length;
  const commitsWithImpact = commits.filter((c) => !c.skippedAllSkills).length;
  const commitsSkippedNoImpact = commitsAnalyzed - commitsWithImpact;
  const totalPossibleSkillRuns = commitsAnalyzed * input.skills.length;
  const selectedSkillRuns = commits.reduce((acc, c) => acc + c.impactedSkillIds.length, 0);
  const testReductionRatePct =
    totalPossibleSkillRuns > 0
      ? Number((((totalPossibleSkillRuns - selectedSkillRuns) / totalPossibleSkillRuns) * 100).toFixed(2))
      : 0;
  const noImpactSkipRatePct =
    commitsAnalyzed > 0
      ? Number(((commitsSkippedNoImpact / commitsAnalyzed) * 100).toFixed(2))
      : 0;

  return {
    app: input.app,
    repoPath: input.repoPath.replace(/\\/g, "/"),
    commitsAnalyzed,
    totalAppSkills: input.skills.length,
    commitsWithImpact,
    commitsSkippedNoImpact,
    noImpactSkipRatePct,
    totalPossibleSkillRuns,
    selectedSkillRuns,
    testReductionRatePct,
    medianSelectionMs: Number(median(latencies).toFixed(3)),
    p95SelectionMs: Number(percentile(latencies, 95).toFixed(3)),
    kindBreakdown,
    commits,
  };
}
