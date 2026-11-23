import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  authorNewSkill,
  buildBugDraftFromEvidence,
  createSkillValidator,
  executePlan,
  healSkillFromDrift,
  LlmClient,
  loadKnowledgeGraph,
  planToReach,
  selectImpactedSkills,
  type SkillDefinition,
} from "../packages/skill-graph/src/index.js";
import { applyEvoMutation, EVOBENCH_24, type EvoMutationSpec } from "../benchmarks/skill-graph/evobench-24.js";
import { EVOBENCH_24_EXTENSION } from "../benchmarks/skill-graph/evobench-48.js";
import { runBlackBoxHealer, runTelemetryGatedNoDiffHealer } from "../benchmarks/skill-graph/healing-ablations.js";
import type { Rq2CommitRecord, Rq2Receipt } from "../benchmarks/skill-graph/metrics-exporter.js";
import { evaluateRealGitHistory } from "../benchmarks/skill-graph/real-git-benchmark.js";
import {
  exportPhaseCArtifacts,
  type MultiModelReceipt,
  type RealGitReceipt,
} from "../benchmarks/skill-graph/phase-c-exporter.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCHEMA_PATH = path.join(ROOT, "contracts/skill-graph/skill.schema.json");
const RAW_DIR = path.join(ROOT, "runtime/thesis-benchmark");
const EXPORT_DIR = path.join(ROOT, "docs/thesis-evaluation");

const RWA_SANDBOX = path.join(ROOT, "runtime/sandboxes/cypress-realworld-app");
const RWA_SKILLS_DIR = path.join(ROOT, "skills/cypress-rwa");
const RWA_BASE_URL = "http://localhost:3000";
const RWA_API_URL = "http://localhost:3001";

const HORILLA_SANDBOX = path.join(ROOT, "runtime/sandboxes/horilla");
const HORILLA_SKILLS_DIR = path.join(ROOT, "skills/horilla");
const HORILLA_BASE_URL = "http://127.0.0.1:8000";
const HORILLA_PYTHON = path.join(HORILLA_SANDBOX, ".venv/Scripts/python.exe");
const HORILLA_USER = "hr_admin";
const HORILLA_PASS = "HorillaDemo2026!";

const DEFAULT_MODELS = [
  "deepseek/deepseek-v3.2",
  "google/gemini-2.5-flash",
  "openai/gpt-4o-mini",
];

// Standardized Multi-Model Panel: 8 shared drifts + 4 representative product bugs + 2 cross-stack authoring tasks
const MM_DRIFT_IDS_RWA = ["RWA-D1", "RWA-D2", "RWA-D3", "RWA-D4", "RWA-D5"];
const MM_DRIFT_IDS_HOR = ["HOR-D1", "HOR-D2", "HOR-D3"];
const MM_BUG_IDS_RWA = ["RWA-B1", "RWA-B6"];
const MM_BUG_IDS_HOR = ["HOR-B1", "HOR-B2"];

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function restoreSandbox(dir: string): void {
  execFileSync("git", ["-C", dir, "checkout", "--", "."], { stdio: "pipe" });
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function resetRwaDb(): Promise<void> {
  const res = await fetch(`${RWA_API_URL}/testData/seed`, { method: "POST" });
  if (!res.ok) throw new Error(`RWA DB seed failed: HTTP ${res.status}`);
}

async function waitRwaReady(isBackendEdit: boolean): Promise<void> {
  // When nodemon --legacy-watch reloads backend TS, wait slightly longer so new server binds cleanly
  await new Promise((r) => setTimeout(r, isBackendEdit ? 4500 : 800));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r1 = await fetch(`${RWA_API_URL}/testData/seed`, { method: "POST" });
      const r2 = await fetch(`${RWA_BASE_URL}/`);
      if (r1.ok && r2.ok) return;
    } catch {
      // restarting
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("Timed out waiting for RWA servers.");
}

async function resetHorillaDb(): Promise<void> {
  execFileSync(
    HORILLA_PYTHON,
    [
      "-c",
      [
        "import sqlite3",
        "con = sqlite3.connect('TestDB.sqlite3')",
        "cur = con.cursor()",
        "cur.execute('DELETE FROM base_jobposition')",
        "cur.execute('DELETE FROM base_department')",
        "cur.execute('DELETE FROM base_employeetype')",
        "cur.execute('DELETE FROM base_worktype')",
        "con.commit()",
        "con.close()",
      ].join("; "),
    ],
    { cwd: HORILLA_SANDBOX, stdio: "pipe" },
  );
}

async function waitHorillaReady(isPythonEdit: boolean): Promise<void> {
  await new Promise((r) => setTimeout(r, isPythonEdit ? 13000 : 500));
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${HORILLA_BASE_URL}/login/`);
      if (res.ok) return;
    } catch {
      // reloading
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error("Timed out waiting for Horilla server.");
}

function getAppConfig(app: "cypress-rwa" | "horilla") {
  if (app === "cypress-rwa") {
    return {
      sandbox: RWA_SANDBOX,
      skillsDir: RWA_SKILLS_DIR,
      execOpts: {
        baseUrl: RWA_BASE_URL,
        apiBaseUrl: RWA_API_URL,
        stepTimeoutMs: 7000,
        evidenceDir: RAW_DIR,
      },
      bindings: {
        user: "Heath93",
        sender: "Heath93",
        receiver: "Arvilla_Hegmann",
        receiverName: "Kristian Bradtke",
        amount: "25",
        note: "PhaseC Tx",
        bankName: "PhaseC Bank",
        routingNumber: "123456789",
        accountNumber: "123456789",
        commentText: "PhaseC Comment",
        decisionLabel: "Accept Request",
      } as Record<string, string>,
      actors: { Heath93: { password: "s3cret" }, Arvilla_Hegmann: { password: "s3cret" } },
      resetDb: resetRwaDb,
      waitReady: waitRwaReady,
    };
  }
  return {
    sandbox: HORILLA_SANDBOX,
    skillsDir: HORILLA_SKILLS_DIR,
    execOpts: {
      baseUrl: HORILLA_BASE_URL,
      stepTimeoutMs: 12000,
      evidenceDir: RAW_DIR,
    },
    bindings: {
      user: HORILLA_USER,
      username: HORILLA_USER,
      password: HORILLA_PASS,
      department: "PhaseC Dept",
      employeeType: "PhaseC Type",
    } as Record<string, string>,
    actors: { [HORILLA_USER]: { password: HORILLA_PASS } },
    resetDb: resetHorillaDb,
    waitReady: waitHorillaReady,
  };
}

function sameStringSet(a: string[], b: string[]): boolean {
  const sa = [...new Set(a)].sort();
  const sb = [...new Set(b)].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

async function runRealGitStage(): Promise<void> {
  console.log("\n========== PHASE C STAGE 1: REAL-WORLD GIT COMMIT REPLAY (0-LLM) ==========");
  const validator = createSkillValidator(SCHEMA_PATH);
  const graph = await loadKnowledgeGraph(path.join(ROOT, "build/knowledge-index.json"));
  const receipt: RealGitReceipt = {
    version: 1,
    timestamp: new Date().toISOString(),
    repos: {},
  };

  for (const app of ["cypress-rwa", "horilla"] as const) {
    const cfg = getAppConfig(app);
    const loaded = validator.validateDirectory(cfg.skillsDir).skills;
    const rep = evaluateRealGitHistory({
      app,
      repoPath: cfg.sandbox,
      skills: loaded,
      knowledgeGraph: graph,
      maxCommits: 50,
    });
    receipt.repos[app] = rep;
    console.log(
      `  [RealGit ${app}] commits=${rep.commitsAnalyzed} skipNoImpact=${rep.commitsSkippedNoImpact}/${rep.commitsAnalyzed} (${rep.noImpactSkipRatePct}%) reduction=${rep.testReductionRatePct}% median=${rep.medianSelectionMs}ms p95=${rep.p95SelectionMs}ms`,
    );
  }

  writeJson(path.join(RAW_DIR, "phase-c-realgit.json"), receipt);
}

async function runSingleEvoMutation(
  spec: EvoMutationSpec,
  llm: LlmClient,
): Promise<Rq2CommitRecord> {
  const cfg = getAppConfig(spec.app);
  const validator = createSkillValidator(SCHEMA_PATH);
  const loaded = validator.validateDirectory(cfg.skillsDir);
  const allSkills = loaded.skills.map((s) => s.skill);
  const skillsById = new Map<string, SkillDefinition>(allSkills.map((s) => [s.id, s]));

  restoreSandbox(cfg.sandbox);
  try {
    applyEvoMutation(cfg.sandbox, spec);
    if (spec.category !== "NO_IMPACT") {
      await cfg.waitReady(spec.requiresBackendReload);
      await cfg.resetDb();
    }

    const impact = selectImpactedSkills(loaded.skills, cfg.sandbox, "HEAD");
    const actualImpacted = impact.affectedSkills.map((s) => s.skillId);
    const impactExactMatch = sameStringSet(actualImpacted, spec.expectedImpactedSkills);

    if (spec.category === "NO_IMPACT" || actualImpacted.length === 0) {
      return {
        id: spec.id,
        app: spec.app,
        category: spec.category,
        title: spec.title,
        targetFile: spec.targetFile,
        totalAppSkills: allSkills.length,
        expectedImpactedSkills: spec.expectedImpactedSkills,
        actualImpactedSkills: actualImpacted,
        impactExactMatch,
        staticVerdict: actualImpacted.length === 0 ? "SKIPPED_NO_IMPACT" : "VERIFIED_PASS",
        staticDurationMs: 0,
        whiteBox: {
          verdict: actualImpacted.length === 0 ? "SKIPPED_NO_IMPACT" : "VERIFIED_PASS",
          healStatus: "NOT_NEEDED",
          llmCallsUsed: 0,
          promptTokens: 0,
          completionTokens: 0,
          postHealZeroLlmPass: null,
        },
      };
    }

    const bindings = { ...cfg.bindings, ...(spec.extraBindings ?? {}) };
    const verifyGoal = spec.verifyGoal!;
    const plan = planToReach({
      skills: allSkills,
      goal: verifyGoal,
      bindings,
      actorBindings: cfg.actors,
    });

    const t0 = Date.now();
    const staticReport = await executePlan(plan, skillsById, cfg.execOpts);
    const staticDurationMs = Date.now() - t0;

    const failedSkillReport =
      staticReport.skillReports.find((r) => r.verdict !== "VERIFIED_PASS") ??
      staticReport.skillReports.at(-1)!;
    const targetSkillId = failedSkillReport.skillId;
    const targetSkill = skillsById.get(targetSkillId)!;

    // 1. White-Box Skill Graph (Phase A k<=2 healer + strict 0-LLM PRODUCT_BUG gate)
    const wbBefore = llm.getStats();
    const wbHeal = await healSkillFromDrift({
      skill: targetSkill,
      allSkills,
      failedReport: failedSkillReport,
      scopedGitDiff: impact.scopedDiffBySkill[targetSkillId] ?? "",
      llm,
      executorOptions: cfg.execOpts,
      verifyGoal,
      bindings,
      actorBindings: cfg.actors,
      schemaPath: SCHEMA_PATH,
      maxAttempts: 2,
      beforeVerify: cfg.resetDb,
      writeOnVerify: false,
    });
    const wbAfter = llm.getStats();

    let postHealZeroLlmPass: boolean | null = null;
    if (wbHeal.status === "HEALED_AND_VERIFIED" && wbHeal.patchedSkill) {
      await cfg.resetDb();
      const updated = allSkills.map((s) => (s.id === targetSkillId ? wbHeal.patchedSkill! : s));
      const postPlan = planToReach({
        skills: updated,
        goal: verifyGoal,
        bindings,
        actorBindings: cfg.actors,
      });
      const postRep = await executePlan(postPlan, new Map(updated.map((s) => [s.id, s])), cfg.execOpts);
      postHealZeroLlmPass = postRep.verdict === "VERIFIED_PASS";
    }

    let bugDraftId: string | undefined;
    let bugDraftOrigin: string | undefined;
    let bugDraftStatus: string | undefined;
    if (failedSkillReport.verdict === "PRODUCT_BUG" && failedSkillReport.bug) {
      const draft = buildBugDraftFromEvidence(spec.app, failedSkillReport.bug);
      bugDraftId = draft.draftId;
      bugDraftOrigin = draft.origin;
      bugDraftStatus = draft.status;
    }

    // 2. Ablation A: Black-Box Healer (no diff, no PRODUCT_BUG refusal gate)
    const bbOutcome = await runBlackBoxHealer({
      skill: targetSkill,
      allSkills,
      failedReport: failedSkillReport,
      llm,
      executorOptions: cfg.execOpts,
      verifyGoal,
      bindings,
      actorBindings: cfg.actors,
      schemaPath: SCHEMA_PATH,
      beforeVerify: cfg.resetDb,
    });

    // 3. Ablation B: Telemetry-Gated No-Diff Healer
    const ndBefore = llm.getStats();
    const ndOutcome = await runTelemetryGatedNoDiffHealer({
      skill: targetSkill,
      allSkills,
      failedReport: failedSkillReport,
      llm,
      executorOptions: cfg.execOpts,
      verifyGoal,
      bindings,
      actorBindings: cfg.actors,
      schemaPath: SCHEMA_PATH,
      beforeVerify: cfg.resetDb,
    });
    const ndAfter = llm.getStats();

    return {
      id: spec.id,
      app: spec.app,
      category: spec.category,
      title: spec.title,
      targetFile: spec.targetFile,
      totalAppSkills: allSkills.length,
      expectedImpactedSkills: spec.expectedImpactedSkills,
      actualImpactedSkills: actualImpacted,
      impactExactMatch,
      staticVerdict: staticReport.verdict,
      staticDurationMs,
      whiteBox: {
        verdict: staticReport.verdict,
        healStatus: wbHeal.status,
        llmCallsUsed: wbAfter.calls - wbBefore.calls,
        promptTokens: wbAfter.promptTokens - wbBefore.promptTokens,
        completionTokens: wbAfter.completionTokens - wbBefore.completionTokens,
        postHealZeroLlmPass,
        ...(bugDraftId ? { bugDraftId, bugDraftOrigin, bugDraftStatus } : {}),
      },
      blackBoxAblation: {
        status: bbOutcome.status,
        llmCallsUsed: bbOutcome.llmCallsUsed,
        promptTokens: bbOutcome.promptTokens,
        completionTokens: bbOutcome.completionTokens,
        weakenedPostconditions: bbOutcome.weakenedPostconditions,
        falseHeal: spec.category === "PRODUCT_BUG" && bbOutcome.status === "HEALED_AND_VERIFIED",
        driftRecovered: spec.category === "SKILL_DRIFT" && bbOutcome.status === "HEALED_AND_VERIFIED",
      },
      noDiffAblation: {
        status: ndOutcome.status,
        llmCallsUsed: ndAfter.calls - ndBefore.calls,
        promptTokens: ndAfter.promptTokens - ndBefore.promptTokens,
        completionTokens: ndAfter.completionTokens - ndBefore.completionTokens,
        falseHeal: spec.category === "PRODUCT_BUG" && ndOutcome.status === "HEALED_AND_VERIFIED",
        driftRecovered: spec.category === "SKILL_DRIFT" && ndOutcome.status === "HEALED_AND_VERIFIED",
      },
    };
  } finally {
    restoreSandbox(cfg.sandbox);
    if (spec.requiresBackendReload) {
      await cfg.waitReady(true).catch(() => {});
    }
    if (spec.category !== "NO_IMPACT") {
      await cfg.resetDb().catch(() => {});
    }
  }
}

async function runEvoBench48Extension(app: "cypress-rwa" | "horilla", model: string): Promise<void> {
  console.log(`\n========== PHASE C STAGE 2: EVOBENCH-48 EXTENSION (${app}, ${model}) ==========`);
  const receiptPath = path.join(RAW_DIR, `phase-c-evobench48-ext-${app}.json`);
  const receipt = readJson<Rq2Receipt>(receiptPath, {
    version: 1,
    app,
    timestamp: new Date().toISOString(),
    model,
    commits: [],
  });
  const doneIds = new Set(receipt.commits.map((c) => c.id));
  const specs = EVOBENCH_24_EXTENSION.filter((m) => m.app === app);
  const llm = new LlmClient({ model });

  for (const spec of specs) {
    if (doneIds.has(spec.id)) {
      console.log(`  [SKIP cached] ${spec.id}`);
      continue;
    }
    const rec = await runSingleEvoMutation(spec, llm);
    receipt.commits.push(rec);
    receipt.timestamp = new Date().toISOString();
    writeJson(receiptPath, receipt);
    console.log(
      `  [${rec.id}] cat=${rec.category} impactExact=${rec.impactExactMatch} static=${rec.staticVerdict} wb=${rec.whiteBox.healStatus}(post=${rec.whiteBox.postHealZeroLlmPass},calls=${rec.whiteBox.llmCallsUsed}) bb=${rec.blackBoxAblation?.status ?? "-"}(weak=${rec.blackBoxAblation?.weakenedPostconditions ?? false},fhr=${rec.blackBoxAblation?.falseHeal ?? false}) nd=${rec.noDiffAblation?.status ?? "-"}`,
    );
  }
}

async function runMultiModelPanel(app: "cypress-rwa" | "horilla", models: string[]): Promise<void> {
  console.log(`\n========== PHASE C STAGE 3: MULTI-MODEL PANEL (${app}: ${models.join(", ")}) ==========`);
  const receiptPath = path.join(RAW_DIR, "phase-c-multimodel.json");
  const receipt = readJson<MultiModelReceipt>(receiptPath, {
    version: 1,
    timestamp: new Date().toISOString(),
    models: {},
  });

  const cfg = getAppConfig(app);
  const validator = createSkillValidator(SCHEMA_PATH);
  const loaded = validator.validateDirectory(cfg.skillsDir);
  const allSkills = loaded.skills.map((s) => s.skill);
  const skillsById = new Map<string, SkillDefinition>(allSkills.map((s) => [s.id, s]));

  const driftIds = app === "cypress-rwa" ? MM_DRIFT_IDS_RWA : MM_DRIFT_IDS_HOR;
  const bugIds = app === "cypress-rwa" ? MM_BUG_IDS_RWA : MM_BUG_IDS_HOR;
  const driftSpecs = driftIds.map((id) => EVOBENCH_24.find((m) => m.id === id)!);
  const bugSpecs = bugIds.map((id) => EVOBENCH_24.find((m) => m.id === id)!);

  for (const model of models) {
    if (!receipt.models[model]) {
      receipt.models[model] = { model, drifts: {}, bugs: {}, authoring: {} };
    }
    const bucket = receipt.models[model]!;
    const llm = new LlmClient({ model });

    // 1. Drifts (White-Box k<=2 vs Black-Box)
    for (const spec of driftSpecs) {
      if (bucket.drifts[spec.id]) {
        console.log(`  [SKIP cached] ${model} drift ${spec.id}`);
        continue;
      }
      restoreSandbox(cfg.sandbox);
      try {
        applyEvoMutation(cfg.sandbox, spec);
        await cfg.waitReady(spec.requiresBackendReload);
        await cfg.resetDb();
        const impact = selectImpactedSkills(loaded.skills, cfg.sandbox, "HEAD");
        const bindings = { ...cfg.bindings, ...(spec.extraBindings ?? {}) };
        const verifyGoal = spec.verifyGoal!;
        const plan = planToReach({ skills: allSkills, goal: verifyGoal, bindings, actorBindings: cfg.actors });
        const failedPlan = await executePlan(plan, skillsById, cfg.execOpts);
        const failedRep =
          failedPlan.skillReports.find((r) => r.verdict !== "VERIFIED_PASS") ?? failedPlan.skillReports.at(-1)!;
        const targetSkill = skillsById.get(failedRep.skillId)!;

        const wbB = llm.getStats();
        const wbRes = await healSkillFromDrift({
          skill: targetSkill,
          allSkills,
          failedReport: failedRep,
          scopedGitDiff: impact.scopedDiffBySkill[failedRep.skillId] ?? "",
          llm,
          executorOptions: cfg.execOpts,
          verifyGoal,
          bindings,
          actorBindings: cfg.actors,
          schemaPath: SCHEMA_PATH,
          maxAttempts: 2,
          beforeVerify: cfg.resetDb,
          writeOnVerify: false,
        });
        const wbA = llm.getStats();

        const bbRes = await runBlackBoxHealer({
          skill: targetSkill,
          allSkills,
          failedReport: failedRep,
          llm,
          executorOptions: cfg.execOpts,
          verifyGoal,
          bindings,
          actorBindings: cfg.actors,
          schemaPath: SCHEMA_PATH,
          beforeVerify: cfg.resetDb,
        });

        bucket.drifts[spec.id] = {
          mutationId: spec.id,
          app,
          whiteBoxStatus: wbRes.status,
          whiteBoxRecovered: wbRes.status === "HEALED_AND_VERIFIED",
          whiteBoxAttempts: wbRes.attemptsUsed,
          whiteBoxCalls: wbA.calls - wbB.calls,
          whiteBoxPromptTokens: wbA.promptTokens - wbB.promptTokens,
          whiteBoxCompletionTokens: wbA.completionTokens - wbB.completionTokens,
          blackBoxStatus: bbRes.status,
          blackBoxRecovered: bbRes.status === "HEALED_AND_VERIFIED",
          blackBoxCalls: bbRes.llmCallsUsed,
          blackBoxPromptTokens: bbRes.promptTokens,
          blackBoxCompletionTokens: bbRes.completionTokens,
        };
        receipt.timestamp = new Date().toISOString();
        writeJson(receiptPath, receipt);
        console.log(
          `  [MM ${model} ${spec.id}] WB=${wbRes.status}(att=${wbRes.attemptsUsed},calls=${wbA.calls - wbB.calls}) BB=${bbRes.status}(calls=${bbRes.llmCallsUsed})`,
        );
      } finally {
        restoreSandbox(cfg.sandbox);
        if (spec.requiresBackendReload) await cfg.waitReady(true).catch(() => {});
        await cfg.resetDb().catch(() => {});
      }
    }

    // 2. Product Bug Safety Panel (White-Box 0-LLM refusal vs Black-Box weakening/false-heal)
    for (const spec of bugSpecs) {
      if (bucket.bugs[spec.id]) {
        console.log(`  [SKIP cached] ${model} bug ${spec.id}`);
        continue;
      }
      restoreSandbox(cfg.sandbox);
      try {
        applyEvoMutation(cfg.sandbox, spec);
        await cfg.waitReady(spec.requiresBackendReload);
        await cfg.resetDb();
        const impact = selectImpactedSkills(loaded.skills, cfg.sandbox, "HEAD");
        const bindings = { ...cfg.bindings, ...(spec.extraBindings ?? {}) };
        const verifyGoal = spec.verifyGoal!;
        const plan = planToReach({ skills: allSkills, goal: verifyGoal, bindings, actorBindings: cfg.actors });
        const failedPlan = await executePlan(plan, skillsById, cfg.execOpts);
        const failedRep =
          failedPlan.skillReports.find((r) => r.verdict !== "VERIFIED_PASS") ?? failedPlan.skillReports.at(-1)!;
        const targetSkill = skillsById.get(failedRep.skillId)!;

        const wbRes = await healSkillFromDrift({
          skill: targetSkill,
          allSkills,
          failedReport: failedRep,
          scopedGitDiff: impact.scopedDiffBySkill[failedRep.skillId] ?? "",
          llm,
          executorOptions: cfg.execOpts,
          verifyGoal,
          bindings,
          actorBindings: cfg.actors,
          schemaPath: SCHEMA_PATH,
          maxAttempts: 2,
          beforeVerify: cfg.resetDb,
          writeOnVerify: false,
        });

        const bbRes = await runBlackBoxHealer({
          skill: targetSkill,
          allSkills,
          failedReport: failedRep,
          llm,
          executorOptions: cfg.execOpts,
          verifyGoal,
          bindings,
          actorBindings: cfg.actors,
          schemaPath: SCHEMA_PATH,
          beforeVerify: cfg.resetDb,
        });

        bucket.bugs[spec.id] = {
          mutationId: spec.id,
          app,
          whiteBoxStatus: wbRes.status,
          whiteBoxCalls: wbRes.llmCallsUsed,
          whiteBoxFalseHeal: wbRes.status === "HEALED_AND_VERIFIED",
          blackBoxStatus: bbRes.status,
          blackBoxCalls: bbRes.llmCallsUsed,
          blackBoxPromptTokens: bbRes.promptTokens,
          blackBoxCompletionTokens: bbRes.completionTokens,
          blackBoxWeakened: bbRes.weakenedPostconditions,
          blackBoxFalseHeal: bbRes.status === "HEALED_AND_VERIFIED",
        };
        receipt.timestamp = new Date().toISOString();
        writeJson(receiptPath, receipt);
        console.log(
          `  [MM ${model} ${spec.id}] WB=${wbRes.status}(calls=${wbRes.llmCallsUsed}) BB=${bbRes.status}(weak=${bbRes.weakenedPostconditions},fhr=${bbRes.status === "HEALED_AND_VERIFIED"})`,
        );
      } finally {
        restoreSandbox(cfg.sandbox);
        if (spec.requiresBackendReload) await cfg.waitReady(true).catch(() => {});
        await cfg.resetDb().catch(() => {});
      }
    }

    // 3. Cross-Stack Authoring Task (1 per app per model: user.settings_update on RWA, work_type.create on Horilla)
    const authSkillId = app === "cypress-rwa" ? "user.settings_update" : "work_type.create";
    if (!bucket.authoring[authSkillId]) {
      const bBefore = llm.getStats();
      const authRes =
        app === "cypress-rwa"
          ? await authorNewSkill({
              skillId: "user.settings_update",
              app: "cypress-rwa",
              description: "Update the user's First Name in User Settings.",
              goalPrompt:
                "Navigate to /user/settings, fill placeholder 'First Name' with 'PhaseCFirst', click button 'Save', and finish once saved.",
              preconditions: [{ name: "auth.logged_in", singleton: true, params: { user: "{{user}}" } }],
              produces: [{ name: "user.settings_updated", params: { user: "{{user}}", firstName: "{{firstName}}" } }],
              inputs: {
                user: { type: "string", required: true },
                firstName: { type: "string", required: true },
              },
              expectedPostconditions: [
                { kind: "HTTP_STATUS", method: "PATCH", path: "/users", expectStatus: 204 },
                { kind: "CONSOLE_ERRORS", maxCount: 0 },
                { kind: "PAGE_ERRORS", maxCount: 0 },
              ],
              authorBindings: { user: "Heath93", firstName: "PhaseCFirst" },
              replayBindings: { user: "Heath93", firstName: "PhaseCFresh" },
              actorBindings: cfg.actors,
              existingSkills: allSkills,
              repoPath: cfg.sandbox,
              executorOptions: cfg.execOpts,
              llm,
              maxSteps: 8,
              schemaPath: SCHEMA_PATH,
              beforeRun: cfg.resetDb,
            })
          : await authorNewSkill({
              skillId: "work_type.create",
              app: "horilla",
              description: "Create a new work type in Horilla settings via HTMX modal.",
              goalPrompt:
                "Navigate to /settings/work-type-view/, click exact text 'Create', fill placeholder 'Work Type' with 'PhaseC Hybrid Work', and click exact text 'Save' inside the [MODAL] (NOT 'Save And Add Another') until 'PhaseC Hybrid Work' appears.",
              preconditions: [{ name: "auth.logged_in", singleton: true, params: { user: "{{user}}" } }],
              produces: [{ name: "work_type.exists", params: { workType: "{{workType}}" } }],
              inputs: {
                user: { type: "string", required: true },
                workType: { type: "string", required: true },
              },
              expectedPostconditions: [
                { kind: "HTTP_STATUS", method: "POST", path: "/work-type-create-form/", expectStatus: 200 },
                { kind: "DOM_CONTAINS", text: "{{workType}}" },
                { kind: "CONSOLE_ERRORS", maxCount: 0 },
                { kind: "PAGE_ERRORS", maxCount: 0 },
              ],
              authorBindings: { ...cfg.bindings, workType: "PhaseC Hybrid Work" },
              replayBindings: { ...cfg.bindings, workType: "PhaseC Fresh Remote" },
              actorBindings: cfg.actors,
              existingSkills: allSkills,
              repoPath: cfg.sandbox,
              executorOptions: cfg.execOpts,
              llm,
              maxSteps: 10,
              schemaPath: SCHEMA_PATH,
              beforeRun: cfg.resetDb,
            });
      const bAfter = llm.getStats();
      bucket.authoring[authSkillId] = {
        skillId: authSkillId,
        app,
        status: authRes.status,
        replayVerdict: authRes.replayVerdict ?? "FAILED",
        llmCallsUsed: authRes.llmCallsUsed,
        promptTokens: bAfter.promptTokens - bBefore.promptTokens,
        completionTokens: bAfter.completionTokens - bBefore.completionTokens,
        codeRefsCount: authRes.discoveredSourceFiles.length,
      };
      receipt.timestamp = new Date().toISOString();
      writeJson(receiptPath, receipt);
      console.log(
        `  [MM Author ${model} ${authSkillId}] status=${authRes.status} replay=${authRes.replayVerdict} calls=${authRes.llmCallsUsed} codeRefs=${authRes.discoveredSourceFiles.length}`,
      );
    } else {
      console.log(`  [SKIP cached] ${model} author ${authSkillId}`);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stage = getFlag(args, "--stage") ?? "realgit";
  const appArg = (getFlag(args, "--app") ?? "all") as "cypress-rwa" | "horilla" | "all";
  const modelsFlag = getFlag(args, "--models");
  const models = modelsFlag
    ? modelsFlag.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_MODELS;
  const shouldExport = args.includes("--export");

  if (stage === "realgit" || stage === "all") {
    await runRealGitStage();
  }

  const apps: Array<"cypress-rwa" | "horilla"> =
    appArg === "all" ? ["cypress-rwa", "horilla"] : [appArg];

  if (stage === "evobench48" || stage === "all") {
    for (const app of apps) {
      await runEvoBench48Extension(app, models[0] ?? "deepseek/deepseek-v3.2");
    }
  }

  if (stage === "multimodel" || stage === "all") {
    for (const app of apps) {
      await runMultiModelPanel(app, models);
    }
  }

  if (shouldExport) {
    const out = exportPhaseCArtifacts({ rawDir: RAW_DIR, exportDir: EXPORT_DIR });
    console.log("\nExported Phase C IEEE artifacts:", out.writtenFiles);
    console.log("Summary:", JSON.stringify(out.summary));
  }
}

main().catch((err) => {
  console.error("PHASE C BENCHMARK ERROR:", err);
  process.exit(1);
});
