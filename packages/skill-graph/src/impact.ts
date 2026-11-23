import { execFileSync } from "node:child_process";
import type { ImpactAnalysisResult, ImpactMatch, LoadedSkill } from "./types.js";

const MAX_DIFF_CHARS_PER_SKILL = 16000;

function normalizeRelPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function runGit(repoPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

export function listChangedFiles(repoPath: string, baseRef = "HEAD"): string[] {
  const changed = new Set<string>();
  const diffOut = runGit(repoPath, ["diff", "--name-only", baseRef]);
  for (const line of diffOut.split(/\r?\n/)) {
    const clean = normalizeRelPath(line);
    if (clean) changed.add(clean);
  }
  if (baseRef === "HEAD") {
    const untracked = runGit(repoPath, ["ls-files", "--others", "--exclude-standard"]);
    for (const line of untracked.split(/\r?\n/)) {
      const clean = normalizeRelPath(line);
      if (clean) changed.add(clean);
    }
  }
  return [...changed].sort();
}

function matchesSourceRef(changedFile: string, sourceRef: string): boolean {
  const c = normalizeRelPath(changedFile);
  const s = normalizeRelPath(sourceRef);
  if (c === s) return true;
  if (s.endsWith("/") && c.startsWith(s)) return true;
  return false;
}

export function selectImpactedSkills(
  skills: LoadedSkill[],
  repoPath: string,
  baseRef = "HEAD",
): ImpactAnalysisResult {
  const changedFiles = listChangedFiles(repoPath, baseRef);
  const affectedSkills: ImpactMatch[] = [];
  const scopedDiffBySkill: Record<string, string> = {};

  const sortedSkills = [...skills].sort((a, b) => a.skill.id.localeCompare(b.skill.id));

  for (const loaded of sortedSkills) {
    const matched = loaded.skill.codeRefs.sourceFiles
      .filter((ref) => changedFiles.some((cf) => matchesSourceRef(cf, ref)))
      .map(normalizeRelPath)
      .sort();

    if (matched.length > 0) {
      affectedSkills.push({
        skillId: loaded.skill.id,
        filePath: loaded.filePath,
        matchedSourceFiles: matched,
        codeRefs: loaded.skill.codeRefs,
      });

      const relevantChanged = changedFiles.filter((cf) =>
        matched.some((ref) => matchesSourceRef(cf, ref)),
      );
      if (relevantChanged.length > 0) {
        let diff = runGit(repoPath, ["diff", baseRef, "--", ...relevantChanged]);
        if (diff.length > MAX_DIFF_CHARS_PER_SKILL) {
          diff = `${diff.slice(0, MAX_DIFF_CHARS_PER_SKILL)}\n... [truncated]`;
        }
        scopedDiffBySkill[loaded.skill.id] = diff;
      }
    }
  }

  return {
    repoPath: repoPath.replace(/\\/g, "/"),
    baseRef,
    changedFiles,
    affectedSkills,
    scopedDiffBySkill,
  };
}
