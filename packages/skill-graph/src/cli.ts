import fs from "node:fs";
import path from "node:path";
import { createSkillValidator } from "./validator.js";
import { planToReach } from "./planner.js";
import { selectImpactedSkills } from "./impact.js";
import { loadKnowledgeGraph, selectDefectAwareImpactedSkills } from "./defect-aware-impact.js";
import { executePlan } from "./executor.js";
import { LlmClient } from "./llm-client.js";
import { healSkillFromDrift } from "./healer.js";
import { buildBugDraftFromEvidence, writeBugDraft } from "./knowledge-bridge.js";

function getFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function readJsonArg<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  return JSON.parse(fs.existsSync(raw) ? fs.readFileSync(raw, "utf8") : raw) as T;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help") {
    console.log(
      [
        "Usage: tsx packages/skill-graph/src/cli.ts <command> [options]",
        "  validate    --skills <dir>",
        "  plan        --skills <dir> --goal <factName> [--goal-params <json|file>] [--params <json|file>] [--actors <json|file>]",
        "  impact      --skills <dir> --repo <gitRepoPath> [--base <gitRef>]",
        "  run         --skills <dir> --goal <factName> --url <baseUrl> [--api-url <apiUrl>] [--goal-params <json|file>] [--params <json|file>] [--actors <json|file>] [--evidence-dir <dir>] [--draft-dir <dir>]",
        "  verify-diff --skills <dir> --repo <gitRepoPath> --url <baseUrl> [--api-url <apiUrl>] [--base <gitRef>] [--params <json|file>] [--actors <json|file>] [--heal] [--write] [--evidence-dir <dir>] [--draft-dir <dir>]",
      ].join("\n"),
    );
    return;
  }

  const skillsDir = path.resolve(getFlag(args, "--skills") ?? "skills");
  const validator = createSkillValidator();
  const validation = validator.validateDirectory(skillsDir);

  if (command === "validate") {
    console.log(
      JSON.stringify(
        {
          valid: validation.valid,
          skillCount: validation.skills.length,
          skillIds: validation.skills.map((s) => s.skill.id),
          diagnostics: validation.diagnostics,
        },
        null,
        2,
      ),
    );
    if (!validation.valid) process.exitCode = 1;
    return;
  }

  if (!validation.valid) {
    console.error(JSON.stringify({ valid: false, diagnostics: validation.diagnostics }, null, 2));
    process.exitCode = 1;
    return;
  }

  if (command === "impact") {
    const repoPath = path.resolve(getFlag(args, "--repo") ?? ".");
    const baseRef = getFlag(args, "--base") ?? "HEAD";
    const knowledgePath = getFlag(args, "--knowledge-index");
    if (knowledgePath) {
      const knowledgeGraph = await loadKnowledgeGraph(knowledgePath);
      const result = selectDefectAwareImpactedSkills({
        skills: validation.skills,
        knowledgeGraph,
        repoPath,
        baseRef,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const result = selectImpactedSkills(validation.skills, repoPath, baseRef);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "plan" || command === "run") {
    const goalName = getFlag(args, "--goal");
    if (!goalName) {
      throw new Error("--goal <factName> is required.");
    }
    const bindings = readJsonArg<Record<string, string>>(getFlag(args, "--params"), {});
    const goalParams = readJsonArg<Record<string, string>>(getFlag(args, "--goal-params"), {});
    const actorBindings = readJsonArg<Record<string, Record<string, string>>>(
      getFlag(args, "--actors"),
      {},
    );

    const plan = planToReach({
      skills: validation.skills.map((s) => s.skill),
      goal: { name: goalName, params: goalParams },
      bindings,
      actorBindings,
    });

    if (command === "plan") {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }

    const baseUrl = getFlag(args, "--url");
    if (!baseUrl) {
      throw new Error("--url <baseUrl> is required for run.");
    }
    const apiBaseUrl = getFlag(args, "--api-url");
    const evidenceDir = getFlag(args, "--evidence-dir");
    const draftDir = getFlag(args, "--draft-dir");
    const skillsById = new Map(validation.skills.map((s) => [s.skill.id, s.skill]));

    const report = await executePlan(plan, skillsById, {
      baseUrl,
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
      ...(evidenceDir ? { evidenceDir } : {}),
    });

    const writtenDrafts: string[] = [];
    if (draftDir) {
      for (const sr of report.skillReports) {
        if (sr.verdict === "PRODUCT_BUG" && sr.bug) {
          const sk = skillsById.get(sr.skillId);
          const draft = buildBugDraftFromEvidence(sk?.app ?? "webapp", sr.bug);
          writtenDrafts.push(writeBugDraft(draft, draftDir));
        }
      }
    }

    console.log(
      JSON.stringify(
        {
          ...report,
          ...(writtenDrafts.length > 0 ? { writtenBugDrafts: writtenDrafts } : {}),
        },
        null,
        2,
      ),
    );
    if (report.verdict !== "VERIFIED_PASS") {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "verify-diff") {
    const repoPath = path.resolve(getFlag(args, "--repo") ?? ".");
    const baseRef = getFlag(args, "--base") ?? "HEAD";
    const baseUrl = getFlag(args, "--url");
    if (!baseUrl) {
      throw new Error("--url <baseUrl> is required for verify-diff.");
    }
    const apiBaseUrl = getFlag(args, "--api-url");
    const evidenceDir = getFlag(args, "--evidence-dir");
    const draftDir = getFlag(args, "--draft-dir");
    const allowHeal = hasFlag(args, "--heal");
    const writeOnVerify = hasFlag(args, "--write");
    const bindings = readJsonArg<Record<string, string>>(getFlag(args, "--params"), {});
    const actorBindings = readJsonArg<Record<string, Record<string, string>>>(
      getFlag(args, "--actors"),
      {},
    );

    const impact = selectImpactedSkills(validation.skills, repoPath, baseRef);
    const allSkills = validation.skills.map((s) => s.skill);
    const skillsById = new Map(allSkills.map((s) => [s.id, s]));
    const loadedById = new Map(validation.skills.map((s) => [s.skill.id, s]));
    const llm = allowHeal ? new LlmClient() : null;

    const results: Array<Record<string, unknown>> = [];
    let overallOk = true;

    for (const match of impact.affectedSkills) {
      const loaded = loadedById.get(match.skillId)!;
      const targetProduce = loaded.skill.produces[0];
      if (!targetProduce) {
        results.push({ skillId: match.skillId, skipped: true, reason: "No produces predicate." });
        continue;
      }
      const goalParams: Record<string, string> = {};
      for (const [k, v] of Object.entries(targetProduce.params ?? {})) {
        const m = /^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/.exec(v);
        if (m?.[1] && bindings[m[1]] !== undefined) {
          goalParams[k] = bindings[m[1]]!;
        }
      }

      const plan = planToReach({
        skills: allSkills,
        goal: { name: targetProduce.name, params: goalParams },
        bindings,
        actorBindings,
      });
      const execOptions = {
        baseUrl,
        ...(apiBaseUrl ? { apiBaseUrl } : {}),
        ...(evidenceDir ? { evidenceDir } : {}),
      };
      const execReport = await executePlan(plan, skillsById, execOptions);

      const entry: Record<string, unknown> = {
        skillId: match.skillId,
        matchedSourceFiles: match.matchedSourceFiles,
        verdict: execReport.verdict,
        durationMs: execReport.totalDurationMs,
        llmCallsUsed: 0,
      };

      const failedSkillReport = execReport.skillReports.at(-1);
      if (execReport.verdict === "PRODUCT_BUG" && failedSkillReport?.bug) {
        overallOk = false;
        const draft = buildBugDraftFromEvidence(loaded.skill.app, failedSkillReport.bug, {
          gitBaseRef: baseRef,
        });
        entry.bugDraft = draft;
        if (draftDir) {
          entry.bugDraftPath = writeBugDraft(draft, draftDir);
        }
      } else if (execReport.verdict === "SKILL_DRIFT" && allowHeal && llm && failedSkillReport) {
        const healRes = await healSkillFromDrift({
          skill: loaded.skill,
          skillFilePath: loaded.filePath,
          allSkills,
          failedReport: failedSkillReport,
          scopedGitDiff: impact.scopedDiffBySkill[match.skillId] ?? "",
          llm,
          executorOptions: execOptions,
          verifyGoal: { name: targetProduce.name, params: goalParams },
          bindings,
          actorBindings,
          writeOnVerify,
        });
        entry.healing = healRes;
        entry.llmCallsUsed = healRes.llmCallsUsed;
        if (healRes.status !== "HEALED_AND_VERIFIED") {
          overallOk = false;
        }
      } else if (execReport.verdict !== "VERIFIED_PASS") {
        overallOk = false;
      }

      results.push(entry);
    }

    console.log(
      JSON.stringify(
        {
          repoPath: impact.repoPath,
          baseRef: impact.baseRef,
          changedFiles: impact.changedFiles,
          impactedSkillCount: impact.affectedSkills.length,
          overallOk,
          results,
        },
        null,
        2,
      ),
    );
    if (!overallOk) {
      process.exitCode = 1;
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
