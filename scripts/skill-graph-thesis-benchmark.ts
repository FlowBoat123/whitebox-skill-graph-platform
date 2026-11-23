import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  authorNewSkill,
  buildBugDraftFromEvidence,
  createSkillValidator,
  executePlan,
  healSkillFromDrift,
  LlmClient,
  planToReach,
  selectImpactedSkills,
  writeBugDraft,
  type ExecutorOptions,
  type SkillDefinition,
} from "../packages/skill-graph/src/index.js";
import {
  applyEvoMutation,
  EVOBENCH_24,
  type EvoBenchApp,
  type EvoMutationSpec,
} from "../benchmarks/skill-graph/evobench-24.js";
import {
  runPureLlmBaseline,
  type PureLlmRunReceipt,
  type PureLlmTaskSpec,
} from "../benchmarks/skill-graph/pure-llm-baseline.js";
import {
  runBlackBoxHealer,
  runTelemetryGatedNoDiffHealer,
} from "../benchmarks/skill-graph/healing-ablations.js";
import {
  exportPaperArtifacts,
  type Rq1Receipt,
  type Rq1SkillGraphRun,
  type Rq2CommitRecord,
  type Rq2Receipt,
  type Rq3AuthoringRecord,
  type Rq3Receipt,
} from "../benchmarks/skill-graph/metrics-exporter.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCHEMA_PATH = path.join(ROOT, "contracts/skill-graph/skill.schema.json");
const RAW_DIR = path.join(ROOT, "runtime/thesis-benchmark");
const DRAFT_DIR = path.join(RAW_DIR, "bug-drafts");
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

function parseArgs(argv: string[]) {
  const out = { rq: "all", app: "all", doExport: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rq" && argv[i + 1]) out.rq = argv[++i]!;
    else if (a === "--app" && argv[i + 1]) out.app = argv[++i]!;
    else if (a === "--export") out.doExport = true;
    else if (a === "--force") out.force = true;
  }
  return out;
}

function restoreSandbox(sandboxDir: string): void {
  execFileSync("git", ["-C", sandboxDir, "checkout", "--", "."], { stdio: "pipe" });
}

async function resetRwaDb(): Promise<void> {
  const res = await fetch(`${RWA_API_URL}/testData/seed`, { method: "POST" });
  if (!res.ok) throw new Error(`RWA DB seed failed: HTTP ${res.status}`);
}

async function waitRwaReady(isBackendEdit: boolean): Promise<void> {
  await new Promise((r) => setTimeout(r, isBackendEdit ? 3500 : 700));
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const [fe, api] = await Promise.all([
        fetch(`${RWA_BASE_URL}/signin`),
        fetch(`${RWA_API_URL}/testData/seed`, { method: "POST" }),
      ]);
      if (fe.ok && api.ok) return;
    } catch {
      // waiting for HMR / nodemon restart
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  throw new Error("Timed out waiting for cypress-realworld-app servers.");
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

async function waitHorillaReady(isBackendEdit: boolean): Promise<void> {
  if (isBackendEdit) {
    await new Promise((r) => setTimeout(r, 5000));
    await new Promise((r) => setTimeout(r, 9000));
  } else {
    await new Promise((r) => setTimeout(r, 300));
  }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${HORILLA_BASE_URL}/login/`);
      if (res.ok) return;
    } catch {
      // Django StatReloader restarting
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timed out waiting for Horilla server.");
}

function getAppConfig(app: EvoBenchApp) {
  if (app === "cypress-rwa") {
    return {
      sandbox: RWA_SANDBOX,
      skillsDir: RWA_SKILLS_DIR,
      execOptions: {
        baseUrl: RWA_BASE_URL,
        apiBaseUrl: RWA_API_URL,
        stepTimeoutMs: 5500,
        evidenceDir: RAW_DIR,
      } satisfies ExecutorOptions,
      defaultBindings: {
        user: "Heath93",
        username: "Heath93",
        password: "s3cret",
        routingNumber: "987654321",
        accountNumber: "1234567890",
        receiverName: "Kristian Bradtke",
        amount: "45",
      },
      actorBindings: {
        Heath93: { password: "s3cret" },
        Arvilla_Hegmann: { password: "s3cret" },
      },
      resetDb: resetRwaDb,
      waitReady: waitRwaReady,
    };
  }
  return {
    sandbox: HORILLA_SANDBOX,
    skillsDir: HORILLA_SKILLS_DIR,
    execOptions: {
      baseUrl: HORILLA_BASE_URL,
      stepTimeoutMs: 8500,
      evidenceDir: RAW_DIR,
    } satisfies ExecutorOptions,
    defaultBindings: {
      user: HORILLA_USER,
      username: HORILLA_USER,
      password: HORILLA_PASS,
    },
    actorBindings: {
      [HORILLA_USER]: { password: HORILLA_PASS },
    },
    resetDb: resetHorillaDb,
    waitReady: waitHorillaReady,
  };
}

// ============================================================================
// RQ1: Cost & Latency Amortization (Skill Graph 0-LLM vs Pure-LLM Baseline)
// ============================================================================
async function runRq1(app: EvoBenchApp, llm: LlmClient, force = false): Promise<void> {
  console.log(`\n========== RQ1 (${app}): Skill Graph 0-LLM vs Pure-LLM Baseline ==========`);
  const cfg = getAppConfig(app);
  const validator = createSkillValidator(SCHEMA_PATH);
  const loaded = validator.validateDirectory(cfg.skillsDir);
  if (!loaded.valid) throw new Error(`Invalid skills in ${cfg.skillsDir}`);
  const skills = loaded.skills.map((s) => s.skill);
  const skillsById = new Map(skills.map((s) => [s.id, s]));

  interface Rq1Task {
    taskId: string;
    goal: { name: string; params: Record<string, string> };
    extraBindings?: Record<string, string>;
    pureSpec: PureLlmTaskSpec;
  }

  const tasks: Rq1Task[] =
    app === "cypress-rwa"
      ? [
          {
            taskId: "rwa_bank_create",
            goal: { name: "bank.exists", params: { user: "Heath93", bankName: "RQ1 Bank Alpha" } },
            pureSpec: {
              taskId: "rwa_bank_create",
              app: "cypress-rwa",
              description: "Sign in and create a new bank account.",
              startUrl: "/signin",
              goalInstruction:
                "Sign in with username/password from taskData, navigate to Bank Accounts (/bankaccounts), click Create, fill Bank Name, Routing Number, Account Number, and click Save until the new bank appears in the list.",
              taskData: {
                username: "Heath93",
                password: "s3cret",
                bankName: "RQ1 Bank Alpha",
                routingNumber: "987654321",
                accountNumber: "1234567890",
              },
              postconditions: [
                { kind: "HTTP_STATUS", method: "POST", path: "/graphql", expectStatus: 200 },
                { kind: "DOM_CONTAINS", text: "{{bankName}}" },
                { kind: "CONSOLE_ERRORS", maxCount: 0 },
              ],
              maxSteps: 14,
            },
          },
          {
            taskId: "rwa_tx_payment",
            goal: {
              name: "tx.paid",
              params: { sender: "Heath93", receiver: "Arvilla_Hegmann", note: "RQ1 Lunch Split" },
            },
            pureSpec: {
              taskId: "rwa_tx_payment",
              app: "cypress-rwa",
              description: "Sign in and send a payment to another user.",
              startUrl: "/signin",
              goalInstruction:
                "Sign in with username/password from taskData, click New ($ New) to create a transaction, select receiverName from the user list, enter amount and note ('Add a note'), and click Pay until 'Return To Transactions' appears.",
              taskData: {
                username: "Heath93",
                password: "s3cret",
                receiverName: "Kristian Bradtke",
                amount: "32",
                note: "RQ1 Lunch Split",
              },
              postconditions: [
                { kind: "HTTP_STATUS", method: "POST", path: "/transactions", expectStatus: 200 },
                { kind: "DOM_CONTAINS", text: "Return To Transactions" },
                { kind: "CONSOLE_ERRORS", maxCount: 0 },
              ],
              maxSteps: 16,
            },
          },
          {
            taskId: "rwa_two_user_request",
            goal: {
              name: "tx.resolved",
              params: {
                sender: "Heath93",
                receiver: "Arvilla_Hegmann",
                note: "RQ1 Shared Invoice",
                decisionLabel: "Accept Request",
              },
            },
            pureSpec: {
              taskId: "rwa_two_user_request",
              app: "cypress-rwa",
              description: "2-user workflow: User A requests money, logs out; User B logs in and accepts.",
              startUrl: "/signin",
              goalInstruction:
                "Step 1: Sign in as senderUsername/password, click New, select receiverName, enter amount and note, click Request. Step 2: Click Logout in the sidebar. Step 3: Sign in as receiverUsername/password, open the Mine tab (/personal), open the transaction matching note, and click 'Accept Request'.",
              taskData: {
                senderUsername: "Heath93",
                receiverUsername: "Arvilla_Hegmann",
                password: "s3cret",
                receiverName: "Kristian Bradtke",
                amount: "48",
                note: "RQ1 Shared Invoice",
              },
              postconditions: [
                { kind: "HTTP_STATUS", method: "PATCH", path: "/transactions", expectStatus: 204 },
                { kind: "CONSOLE_ERRORS", maxCount: 0 },
              ],
              maxSteps: 22,
            },
          },
        ]
      : [
          {
            taskId: "horilla_dept_filtered",
            goal: { name: "department.filtered", params: { department: "RQ1 Platform Eng" } },
            pureSpec: {
              taskId: "horilla_dept_filtered",
              app: "horilla",
              description: "Sign in, create a department, then search for it on /settings/department-view/.",
              startUrl: "/login/",
              goalInstruction:
                "Sign in with username/password, navigate to /settings/department-view/, click Create, fill the Department placeholder input with department, click the exact 'Save' button (NOT 'Save And Add Another'), then type department into the Search input with pressEnter=true and confirm it is visible.",
              taskData: {
                username: HORILLA_USER,
                password: HORILLA_PASS,
                department: "RQ1 Platform Eng",
              },
              postconditions: [
                { kind: "HTTP_STATUS", method: "POST", path: "/settings-department-creation/", expectStatus: 200 },
                { kind: "HTTP_STATUS", method: "GET", path: "/department-list/", expectStatus: 200 },
                { kind: "DOM_CONTAINS", text: "{{department}}" },
                { kind: "CONSOLE_ERRORS", maxCount: 0 },
              ],
              maxSteps: 16,
            },
          },
          {
            taskId: "horilla_emp_type_create",
            goal: { name: "employee_type.exists", params: { employeeType: "RQ1 Contractor" } },
            pureSpec: {
              taskId: "horilla_emp_type_create",
              app: "horilla",
              description: "Sign in and create a new employee type.",
              startUrl: "/login/",
              goalInstruction:
                "Sign in with username/password, navigate to /settings/employee-type-view/, click Create, fill the 'Employee Type' input with employeeType, and click the exact 'Save' button until employeeType appears on the page.",
              taskData: {
                username: HORILLA_USER,
                password: HORILLA_PASS,
                employeeType: "RQ1 Contractor",
              },
              postconditions: [
                { kind: "HTTP_STATUS", method: "POST", path: "/settings/employee-type-create-view/", expectStatus: 200 },
                { kind: "DOM_CONTAINS", text: "{{employeeType}}" },
                { kind: "CONSOLE_ERRORS", maxCount: 0 },
              ],
              maxSteps: 14,
            },
          },
        ];

  const outPath = path.join(RAW_DIR, `rq1-${app}.json`);
  const existingReceipt =
    fs.existsSync(outPath) && !force ? (JSON.parse(fs.readFileSync(outPath, "utf8")) as Rq1Receipt) : null;
  const skillGraphRuns: Rq1SkillGraphRun[] = existingReceipt?.skillGraphRuns ?? [];
  const pureLlmRuns: PureLlmRunReceipt[] = existingReceipt?.pureLlmRuns ?? [];
  const saveRq1 = () => {
    const receipt: Rq1Receipt = {
      version: 1,
      app,
      timestamp: new Date().toISOString(),
      model: llm.model,
      skillGraphRuns,
      pureLlmRuns,
    };
    fs.writeFileSync(outPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  };

  // Warm up dev bundler / server once before timed measurements (fair to both Skill Graph & Pure-LLM)
  await cfg.resetDb();
  const warmPlan = planToReach({
    skills,
    goal: tasks[0]!.goal,
    bindings: { ...cfg.defaultBindings, ...(tasks[0]!.extraBindings ?? {}) },
    actorBindings: cfg.actorBindings,
  });
  await executePlan(warmPlan, skillsById, { ...cfg.execOptions, stepTimeoutMs: 12000 }).catch(() => undefined);

  for (const t of tasks) {
    // 5 live 0-LLM Skill Graph runs per task
    for (let r = 1; r <= 5; r++) {
      if (skillGraphRuns.some((x) => x.taskId === t.taskId && x.runIndex === r)) {
        continue;
      }
      await cfg.resetDb();
      const variedParams = Object.fromEntries(
        Object.entries(t.goal.params).map(([k, v]) =>
          ["bankName", "note", "department", "employeeType"].includes(k) ? [k, `${v} ${r}`] : [k, v],
        ),
      );
      const plan = planToReach({
        skills,
        goal: { name: t.goal.name, params: variedParams },
        bindings: { ...cfg.defaultBindings, ...(t.extraBindings ?? {}) },
        actorBindings: cfg.actorBindings,
      });
      const rep = await executePlan(plan, skillsById, cfg.execOptions);
      console.log(
        `  [SG 0-LLM] ${t.taskId} run ${r}/5 -> ${rep.verdict} (${rep.totalDurationMs}ms, skills=${plan.steps.length})`,
      );
      skillGraphRuns.push({
        taskId: t.taskId,
        app,
        runIndex: r,
        stepsExecuted: plan.steps.map((s) => s.skillId),
        verdict: rep.verdict === "VERIFIED_PASS" ? "VERIFIED_PASS" : "FAILED",
        durationMs: rep.totalDurationMs,
        llmCallsUsed: 0,
      });
      saveRq1();
    }

    // 3 live Pure-LLM Baseline runs per task
    for (let r = 1; r <= 3; r++) {
      if (pureLlmRuns.some((x) => x.taskId === t.taskId && x.runIndex === r)) {
        continue;
      }
      await cfg.resetDb();
      const variedData = Object.fromEntries(
        Object.entries(t.pureSpec.taskData).map(([k, v]) =>
          ["bankName", "note", "department", "employeeType"].includes(k) ? [k, `${v} P${r}`] : [k, v],
        ),
      );
      const pureRep = await runPureLlmBaseline(
        { ...t.pureSpec, taskData: variedData },
        r,
        llm,
        cfg.execOptions,
      );
      console.log(
        `  [Pure-LLM] ${t.taskId} run ${r}/3 -> ${pureRep.verdict} (${pureRep.durationMs}ms, calls=${pureRep.llmCallsUsed}, in=${pureRep.promptTokens}, out=${pureRep.completionTokens})${pureRep.failureReason ? ` | ${pureRep.failureReason}` : ""}`,
      );
      pureLlmRuns.push(pureRep);
      saveRq1();
    }
  }

  saveRq1();
  console.log(`Saved RQ1 receipt -> ${outPath}`);
}

// ============================================================================
// RQ2 + RQ4: EvoBench-24 across 4 System Variants (Static, Black-Box, No-Diff, White-Box)
// ============================================================================
async function runRq2(app: EvoBenchApp, llm: LlmClient, force = false): Promise<void> {
  console.log(`\n========== RQ2 (${app}): EvoBench-24 System & Ablation Comparison ==========`);
  const cfg = getAppConfig(app);
  const validator = createSkillValidator(SCHEMA_PATH);
  const loaded = validator.validateDirectory(cfg.skillsDir);
  if (!loaded.valid) throw new Error(`Invalid skills in ${cfg.skillsDir}`);
  const skills = loaded.skills.map((s) => s.skill);
  const skillsById = new Map(skills.map((s) => [s.id, s]));

  const outPath = path.join(RAW_DIR, `rq2-${app}.json`);
  const existing =
    fs.existsSync(outPath) && !force ? (JSON.parse(fs.readFileSync(outPath, "utf8")) as Rq2Receipt) : null;
  const appMutations = EVOBENCH_24.filter((m) => m.app === app);
  const records: Rq2CommitRecord[] = existing?.commits ?? [];
  const saveRq2 = () => {
    const receipt: Rq2Receipt = {
      version: 1,
      app,
      timestamp: new Date().toISOString(),
      model: llm.model,
      commits: records,
    };
    fs.writeFileSync(outPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  };

  for (const spec of appMutations) {
    if (records.some((r) => r.id === spec.id)) {
      console.log(`  [Resume] Skipping already completed commit ${spec.id}`);
      continue;
    }
    console.log(`\n--- Commit ${spec.id} [${spec.category}]: ${spec.title} ---`);
    restoreSandbox(cfg.sandbox);
    try {
      applyEvoMutation(cfg.sandbox, spec);
      const impact = selectImpactedSkills(loaded.skills, cfg.sandbox, "HEAD");
      const actualImpacted = impact.affectedSkills.map((a) => a.skillId);
      const impactExactMatch =
        JSON.stringify([...actualImpacted].sort()) ===
        JSON.stringify([...spec.expectedImpactedSkills].sort());
      console.log(
        `  ImpactSelector: actual=${JSON.stringify(actualImpacted)} expected=${JSON.stringify(spec.expectedImpactedSkills)} exact=${impactExactMatch}`,
      );

      if (spec.category === "NO_IMPACT") {
        records.push({
          id: spec.id,
          app,
          category: spec.category,
          title: spec.title,
          targetFile: spec.targetFile,
          totalAppSkills: loaded.skills.length,
          expectedImpactedSkills: spec.expectedImpactedSkills,
          actualImpactedSkills: actualImpacted,
          impactExactMatch,
          staticVerdict: "SKIPPED_NO_IMPACT",
          staticDurationMs: 0,
          whiteBox: {
            verdict: "SKIPPED_NO_IMPACT",
            healStatus: "SKIPPED_NO_IMPACT",
            llmCallsUsed: 0,
            promptTokens: 0,
            completionTokens: 0,
            postHealZeroLlmPass: null,
          },
        });
        saveRq2();
        continue;
      }

      await cfg.waitReady(spec.requiresBackendReload);
      await cfg.resetDb();

      const bindings = { ...cfg.defaultBindings, ...(spec.extraBindings ?? {}) };
      const primarySkill = skillsById.get(spec.primarySkillId!)!;
      const goal = spec.verifyGoal!;
      const plan = planToReach({
        skills,
        goal,
        bindings,
        actorBindings: cfg.actorBindings,
      });

      const execReport = await executePlan(plan, skillsById, {
        ...cfg.execOptions,
        stepTimeoutMs: app === "cypress-rwa" ? 4000 : 6500,
      });
      const failedReport =
        execReport.skillReports.find((r) => r.skillId === spec.primarySkillId) ??
        execReport.skillReports.at(-1)!;
      console.log(
        `  Deterministic Verifier: plan=${execReport.verdict}, primary(${primarySkill.id})=${failedReport.verdict} (${execReport.totalDurationMs}ms)`,
      );

      // 1) Full White-Box Skill Graph healing / refusal
      const wbStatsBefore = llm.getStats();
      const wbHeal = await healSkillFromDrift({
        skill: primarySkill,
        allSkills: skills,
        failedReport,
        scopedGitDiff: impact.scopedDiffBySkill[primarySkill.id] ?? "",
        llm,
        executorOptions: cfg.execOptions,
        verifyGoal: goal,
        bindings,
        actorBindings: cfg.actorBindings,
        schemaPath: SCHEMA_PATH,
        beforeVerify: cfg.resetDb,
        writeOnVerify: false,
      });
      const wbStatsAfter = llm.getStats();

      let postHealPass: boolean | null = null;
      if (wbHeal.status === "HEALED_AND_VERIFIED" && wbHeal.patchedSkill) {
        await cfg.resetDb();
        const patchedSkills = skills.map((s) =>
          s.id === primarySkill.id ? wbHeal.patchedSkill! : s,
        );
        const freshGoalParams = Object.fromEntries(
          Object.entries(goal.params).map(([k, v]) =>
            ["bankName", "note", "department", "employeeType"].includes(k)
              ? [k, `${v} Fresh`]
              : [k, v],
          ),
        );
        const postPlan = planToReach({
          skills: patchedSkills,
          goal: { name: goal.name, params: freshGoalParams },
          bindings,
          actorBindings: cfg.actorBindings,
        });
        const postRep = await executePlan(
          postPlan,
          new Map(patchedSkills.map((s) => [s.id, s])),
          cfg.execOptions,
        );
        postHealPass = postRep.verdict === "VERIFIED_PASS";
      }

      let bugDraftId: string | undefined;
      let bugDraftOrigin: string | undefined;
      let bugDraftStatus: string | undefined;
      if (failedReport.verdict === "PRODUCT_BUG" && failedReport.bug) {
        const draft = buildBugDraftFromEvidence(app, failedReport.bug, { gitBaseRef: "HEAD" });
        writeBugDraft(draft, DRAFT_DIR);
        bugDraftId = draft.draftId;
        bugDraftOrigin = draft.origin;
        bugDraftStatus = draft.status;
      }

      console.log(
        `  [White-Box] status=${wbHeal.status} calls=${wbHeal.llmCallsUsed} postHeal0Llm=${postHealPass} draft=${bugDraftId ?? "none"}`,
      );

      // 2) Ablation A: Black-Box Self-Healer (NO git diff, NO PRODUCT_BUG refusal gate)
      const bbRes = await runBlackBoxHealer({
        skill: primarySkill,
        allSkills: skills,
        failedReport,
        llm,
        executorOptions: cfg.execOptions,
        verifyGoal: goal,
        bindings,
        actorBindings: cfg.actorBindings,
        schemaPath: SCHEMA_PATH,
        beforeVerify: cfg.resetDb,
      });
      const bbFalseHeal =
        spec.category === "PRODUCT_BUG" && bbRes.status === "HEALED_AND_VERIFIED";
      const bbDriftRecovered =
        spec.category === "SKILL_DRIFT" && bbRes.status === "HEALED_AND_VERIFIED";
      console.log(
        `  [Black-Box Ablation] status=${bbRes.status} weakened=${bbRes.weakenedPostconditions} falseHeal=${bbFalseHeal} driftRec=${bbDriftRecovered} (${bbRes.explanation.slice(0, 140)})`,
      );

      // 3) Ablation B: Telemetry-Gated Self-Healer WITHOUT git diff
      const ndStatsBefore = llm.getStats();
      const ndRes = await runTelemetryGatedNoDiffHealer({
        skill: primarySkill,
        allSkills: skills,
        failedReport,
        llm,
        executorOptions: cfg.execOptions,
        verifyGoal: goal,
        bindings,
        actorBindings: cfg.actorBindings,
        schemaPath: SCHEMA_PATH,
        beforeVerify: cfg.resetDb,
      });
      const ndStatsAfter = llm.getStats();
      const ndFalseHeal =
        spec.category === "PRODUCT_BUG" && ndRes.status === "HEALED_AND_VERIFIED";
      const ndDriftRecovered =
        spec.category === "SKILL_DRIFT" && ndRes.status === "HEALED_AND_VERIFIED";
      console.log(
        `  [No-Diff Ablation] status=${ndRes.status} calls=${ndRes.llmCallsUsed} falseHeal=${ndFalseHeal} driftRec=${ndDriftRecovered}`,
      );

      records.push({
        id: spec.id,
        app,
        category: spec.category,
        title: spec.title,
        targetFile: spec.targetFile,
        totalAppSkills: loaded.skills.length,
        expectedImpactedSkills: spec.expectedImpactedSkills,
        actualImpactedSkills: actualImpacted,
        impactExactMatch,
        staticVerdict: failedReport.verdict,
        staticDurationMs: execReport.totalDurationMs,
        whiteBox: {
          verdict: failedReport.verdict,
          healStatus: wbHeal.status,
          llmCallsUsed: wbHeal.llmCallsUsed,
          promptTokens: wbStatsAfter.promptTokens - wbStatsBefore.promptTokens,
          completionTokens: wbStatsAfter.completionTokens - wbStatsBefore.completionTokens,
          postHealZeroLlmPass: postHealPass,
          ...(bugDraftId ? { bugDraftId } : {}),
          ...(bugDraftOrigin ? { bugDraftOrigin } : {}),
          ...(bugDraftStatus ? { bugDraftStatus } : {}),
        },
        blackBoxAblation: {
          status: bbRes.status,
          llmCallsUsed: bbRes.llmCallsUsed,
          promptTokens: bbRes.promptTokens,
          completionTokens: bbRes.completionTokens,
          weakenedPostconditions: bbRes.weakenedPostconditions,
          falseHeal: bbFalseHeal,
          driftRecovered: bbDriftRecovered,
        },
          noDiffAblation: {
          status: ndRes.status,
          llmCallsUsed: ndRes.llmCallsUsed,
          promptTokens: ndStatsAfter.promptTokens - ndStatsBefore.promptTokens,
          completionTokens: ndStatsAfter.completionTokens - ndStatsBefore.completionTokens,
          falseHeal: ndFalseHeal,
          driftRecovered: ndDriftRecovered,
        },
      });
      saveRq2();
    } finally {
      restoreSandbox(cfg.sandbox);
      if (spec.requiresBackendReload) {
        await cfg.waitReady(true);
      } else {
        await cfg.waitReady(false);
      }
      await cfg.resetDb();
    }
  }

  saveRq2();
  console.log(`Saved RQ2 receipt -> ${outPath}`);
}

// ============================================================================
// RQ3: Cross-Stack Skill Authoring & Generalization Gate Ablation
// ============================================================================
async function runRq3(app: EvoBenchApp, llm: LlmClient): Promise<void> {
  console.log(`\n========== RQ3 (${app}): Cross-Stack Authoring & Generalization Gate ==========`);
  const cfg = getAppConfig(app);
  const validator = createSkillValidator(SCHEMA_PATH);
  const loaded = validator.validateDirectory(cfg.skillsDir);
  if (!loaded.valid) throw new Error(`Invalid skills in ${cfg.skillsDir}`);
  const existingSkills = loaded.skills.map((s) => s.skill);

  interface AuthorTrialSpec {
    skillId: string;
    description: string;
    goalPrompt: string;
    preconditions: SkillDefinition["preconditions"];
    produces: SkillDefinition["produces"];
    inputs: SkillDefinition["inputs"];
    expectedPostconditions: SkillDefinition["postconditions"];
    authorBindings: Record<string, string>;
    replayBindings: Record<string, string>;
  }

  const trialSpecs: AuthorTrialSpec[] =
    app === "cypress-rwa"
      ? [
          {
            skillId: "tx.comment",
            description: "Open a payment on the Mine tab and post a comment.",
            goalPrompt:
              "Navigate to /personal (Mine tab), click the transaction whose text includes 'Author Tx Note A', fill 'Write a comment...' with 'Author Comment One' with pressEnter=true, then finish once the comment appears.",
            preconditions: [
              { name: "tx.paid", params: { sender: "{{sender}}", receiver: "{{receiver}}", note: "{{note}}" } },
              { name: "auth.logged_in", singleton: true, params: { user: "{{sender}}" } },
            ],
            produces: [
              { name: "tx.commented", params: { sender: "{{sender}}", note: "{{note}}", commentText: "{{commentText}}" } },
            ],
            inputs: {
              sender: { type: "string", required: true },
              receiver: { type: "string", required: true },
              note: { type: "string", required: true },
              commentText: { type: "string", required: true },
            },
            expectedPostconditions: [
              { kind: "HTTP_STATUS", method: "POST", path: "/comments", expectStatus: 200 },
              { kind: "DOM_CONTAINS", text: "{{commentText}}" },
              { kind: "CONSOLE_ERRORS", maxCount: 0 },
              { kind: "PAGE_ERRORS", maxCount: 0 },
            ],
            authorBindings: {
              sender: "Heath93",
              receiver: "Arvilla_Hegmann",
              receiverName: "Kristian Bradtke",
              amount: "25",
              note: "Author Tx Note A",
              commentText: "Author Comment One",
            },
            replayBindings: {
              sender: "Heath93",
              receiver: "Arvilla_Hegmann",
              receiverName: "Kristian Bradtke",
              amount: "39",
              note: "Replay Tx Note B",
              commentText: "Generalized Replay Comment Two",
            },
          },
          {
            skillId: "user.settings_update",
            description: "Update the logged-in user's first name in My Account settings.",
            goalPrompt:
              "Navigate to /user/settings, replace the 'First Name' placeholder input with 'AuthorFirstA', and click the 'Save' button.",
            preconditions: [
              { name: "auth.logged_in", singleton: true, params: { user: "{{user}}" } },
            ],
            produces: [
              { name: "user.profile_updated", params: { user: "{{user}}", firstName: "{{firstName}}" } },
            ],
            inputs: {
              user: { type: "string", required: true },
              firstName: { type: "string", required: true },
            },
            expectedPostconditions: [
              { kind: "HTTP_STATUS", method: "PATCH", path: "/users/", expectStatus: 204 },
              { kind: "DOM_CONTAINS", text: "{{firstName}}" },
              { kind: "CONSOLE_ERRORS", maxCount: 0 },
              { kind: "PAGE_ERRORS", maxCount: 0 },
            ],
            authorBindings: {
              user: "Heath93",
              username: "Heath93",
              password: "s3cret",
              firstName: "AuthorFirstA",
            },
            replayBindings: {
              user: "Heath93",
              username: "Heath93",
              password: "s3cret",
              firstName: "ReplayFirstB",
            },
          },
        ]
      : [
          {
            skillId: "work_type.create",
            description: "Create a new work type in Horilla settings via HTMX modal.",
            goalPrompt:
              "Navigate to /settings/work-type-view/, click exact text 'Create', fill placeholder 'Work Type' with 'Author Hybrid Mode', and click exact text 'Save' (NOT 'Save And Add Another') until 'Author Hybrid Mode' is visible.",
            preconditions: [
              { name: "auth.logged_in", singleton: true, params: { user: "{{user}}" } },
            ],
            produces: [
              { name: "work_type.exists", params: { workType: "{{workType}}" } },
            ],
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
            authorBindings: {
              user: HORILLA_USER,
              username: HORILLA_USER,
              password: HORILLA_PASS,
              workType: "Author Hybrid Mode",
            },
            replayBindings: {
              user: HORILLA_USER,
              username: HORILLA_USER,
              password: HORILLA_PASS,
              workType: "Replay Remote Mode",
            },
          },
          {
            skillId: "department.delete",
            description: "Delete a specific department row in Horilla using the icon-only Delete button (title strategy).",
            goalPrompt:
              "Navigate to /settings/department-view/, click the Delete icon button using strategy='title', value='Delete', exact=true, containerText='Author Delete Dept'. Then in the Delete Confirmation modal, click the 3 checkbox labels ('I Have took manual action for the protected records', \"I acknowledge, I won't be able to revert this\", 'Confirming to delete the related and protected records') and click the 'Delete' button inside the modal.",
            preconditions: [
              { name: "auth.logged_in", singleton: true, params: { user: "{{user}}" } },
              { name: "department.exists", params: { department: "{{department}}" } },
            ],
            produces: [
              { name: "department.deleted", params: { department: "{{department}}" } },
            ],
            inputs: {
              user: { type: "string", required: true },
              department: { type: "string", required: true },
            },
            expectedPostconditions: [
              { kind: "DOM_NOT_CONTAINS", text: "{{department}}" },
              { kind: "CONSOLE_ERRORS", maxCount: 0 },
              { kind: "PAGE_ERRORS", maxCount: 0 },
            ],
            authorBindings: {
              user: HORILLA_USER,
              username: HORILLA_USER,
              password: HORILLA_PASS,
              department: "Author Delete Dept",
            },
            replayBindings: {
              user: HORILLA_USER,
              username: HORILLA_USER,
              password: HORILLA_PASS,
              department: "Replay Delete Dept",
            },
          },
        ];

  const trials: Rq3AuthoringRecord[] = [];

  for (const spec of trialSpecs) {
    console.log(`\n--- Authoring Trial: ${spec.skillId} (${app}) ---`);
    const baseExisting = existingSkills.filter((s) => s.id !== spec.skillId);

    // 1) WITH parameterization & 0-LLM fresh-data generalization gate
    const sBefore = llm.getStats();
    const gated = await authorNewSkill({
      skillId: spec.skillId,
      app,
      description: spec.description,
      goalPrompt: spec.goalPrompt,
      preconditions: spec.preconditions,
      produces: spec.produces,
      inputs: spec.inputs,
      expectedPostconditions: spec.expectedPostconditions,
      authorBindings: spec.authorBindings,
      replayBindings: spec.replayBindings,
      actorBindings: cfg.actorBindings,
      existingSkills: baseExisting,
      repoPath: cfg.sandbox,
      executorOptions: cfg.execOptions,
      llm,
      schemaPath: SCHEMA_PATH,
      beforeRun: cfg.resetDb,
      maxSteps: 10,
    });
    const sAfter = llm.getStats();
    console.log(
      `  [With Gate] status=${gated.status} calls=${gated.llmCallsUsed} replay=${gated.replayVerdict} files=${JSON.stringify(gated.discoveredSourceFiles)}`,
    );

    // 2) WITHOUT parameterization & replay gate (Ablation): compile raw unparameterized steps and test on fresh replayBindings!
    const aBefore = llm.getStats();
    const ungated = await authorNewSkill({
      skillId: spec.skillId,
      app,
      description: spec.description,
      goalPrompt: spec.goalPrompt,
      preconditions: spec.preconditions,
      produces: spec.produces,
      inputs: spec.inputs,
      expectedPostconditions: spec.expectedPostconditions,
      authorBindings: spec.authorBindings,
      replayBindings: spec.replayBindings,
      actorBindings: cfg.actorBindings,
      existingSkills: baseExisting,
      repoPath: cfg.sandbox,
      executorOptions: cfg.execOptions,
      llm,
      schemaPath: SCHEMA_PATH,
      beforeRun: cfg.resetDb,
      maxSteps: 10,
      skipGeneralizationReplay: true,
    });
    const aAfter = llm.getStats();

    let ungatedFreshVerdict = "AUTHOR_FAILED";
    if (ungated.authoredSkill) {
      await cfg.resetDb();
      const allSkills = [...baseExisting, ungated.authoredSkill];
      const prod = ungated.authoredSkill.produces[0]!;
      const goalParams: Record<string, string> = {};
      for (const [k, v] of Object.entries(prod.params ?? {})) {
        const m = /^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/.exec(v);
        goalParams[k] = m?.[1] ? (spec.replayBindings[m[1]] ?? v) : v;
      }
      const plan = planToReach({
        skills: allSkills,
        goal: { name: prod.name, params: goalParams },
        bindings: spec.replayBindings,
        actorBindings: cfg.actorBindings,
      });
      const freshRep = await executePlan(
        plan,
        new Map(allSkills.map((s) => [s.id, s])),
        cfg.execOptions,
      );
      ungatedFreshVerdict = freshRep.verdict;
    }
    const overfitCaught =
      gated.replayVerdict === "VERIFIED_PASS" && ungatedFreshVerdict !== "VERIFIED_PASS";
    console.log(
      `  [Without Gate] freshReplayVerdict=${ungatedFreshVerdict} overfitCaughtByGate=${overfitCaught}`,
    );

    trials.push({
      skillId: spec.skillId,
      app,
      description: spec.description,
      withGate: {
        status: gated.status,
        authorLlmCalls: gated.llmCallsUsed,
        promptTokens: sAfter.promptTokens - sBefore.promptTokens,
        completionTokens: sAfter.completionTokens - sBefore.completionTokens,
        replayLlmCalls: 0,
        replayVerdict: gated.replayVerdict ?? "FAILED",
        discoveredSourceFiles: gated.discoveredSourceFiles,
      },
      withoutGate: {
        authorLlmCalls: ungated.llmCallsUsed,
        promptTokens: aAfter.promptTokens - aBefore.promptTokens,
        completionTokens: aAfter.completionTokens - aBefore.completionTokens,
        freshDataReplayVerdict: ungatedFreshVerdict,
        overfitCaughtByGate: overfitCaught,
      },
    });
  }

  const receipt: Rq3Receipt = {
    version: 1,
    app,
    timestamp: new Date().toISOString(),
    model: llm.model,
    trials,
  };
  const outPath = path.join(RAW_DIR, `rq3-${app}.json`);
  fs.writeFileSync(outPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  console.log(`Saved RQ3 receipt -> ${outPath}`);
}

function runExport(): void {
  const load = <T>(name: string): T | null => {
    const p = path.join(RAW_DIR, name);
    return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, "utf8")) as T) : null;
  };
  const rq1Receipts = [load<Rq1Receipt>("rq1-cypress-rwa.json"), load<Rq1Receipt>("rq1-horilla.json")].filter(
    (x): x is Rq1Receipt => x !== null,
  );
  const rq2Receipts = [load<Rq2Receipt>("rq2-cypress-rwa.json"), load<Rq2Receipt>("rq2-horilla.json")].filter(
    (x): x is Rq2Receipt => x !== null,
  );
  const rq3Receipts = [load<Rq3Receipt>("rq3-cypress-rwa.json"), load<Rq3Receipt>("rq3-horilla.json")].filter(
    (x): x is Rq3Receipt => x !== null,
  );

  const metrics = exportPaperArtifacts(EXPORT_DIR, {
    rq1Receipts,
    rq2Receipts,
    rq3Receipts,
  });
  fs.writeFileSync(
    path.join(RAW_DIR, "computed-metrics.json"),
    JSON.stringify(metrics, null, 2) + "\n",
    "utf8",
  );
  console.log(`\nExported IEEE paper tables & CSVs -> ${EXPORT_DIR}`);
  console.log(JSON.stringify(metrics, null, 2));
}

async function main() {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(DRAFT_DIR, { recursive: true });
  const args = parseArgs(process.argv.slice(2));

  if (args.doExport && args.rq === "all" && args.app === "all" && !process.argv.includes("--rq")) {
    runExport();
    return;
  }

  const llm = new LlmClient({
    endpoint: process.env.SKILL_GRAPH_LLM_ENDPOINT ?? "https://openrouter.ai/api/v1/chat/completions",
    model: process.env.SKILL_GRAPH_LLM_MODEL ?? "deepseek/deepseek-v3.2",
  });

  const apps: EvoBenchApp[] =
    args.app === "all" ? ["cypress-rwa", "horilla"] : [args.app as EvoBenchApp];

  for (const app of apps) {
    if (args.rq === "1" || args.rq === "all") await runRq1(app, llm, args.force);
    if (args.rq === "2" || args.rq === "all") await runRq2(app, llm, args.force);
    if (args.rq === "3" || args.rq === "all") await runRq3(app, llm);
  }

  if (args.doExport || (args.rq === "all" && args.app === "all")) {
    runExport();
  }

  console.log("\nSession LLM stats:", llm.getStats());
}

main().catch((err) => {
  console.error("THESIS BENCHMARK ERROR:", err);
  process.exit(1);
});
