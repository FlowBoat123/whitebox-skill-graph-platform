import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildBugDraftFromEvidence,
  createSkillValidator,
  executePlan,
  healSkillFromDrift,
  LlmClient,
  planToReach,
  selectImpactedSkills,
  writeBugDraft,
} from "../packages/skill-graph/src/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SANDBOX = path.join(ROOT, "runtime/sandboxes/horilla");
const SKILLS_DIR = path.join(ROOT, "skills/horilla");
const SCHEMA_PATH = path.join(ROOT, "contracts/skill-graph/skill.schema.json");
const EVIDENCE_DIR = path.join(ROOT, "runtime/skill-graph-evidence");
const DRAFT_DIR = path.join(EVIDENCE_DIR, "bug-drafts");
const BASE_URL = "http://127.0.0.1:8000";
const HORILLA_PYTHON = path.join(SANDBOX, ".venv/Scripts/python.exe");

const DEMO_USER = "hr_admin";
const DEMO_PASS = "HorillaDemo2026!";

function resetHorillaTestRows(): number {
  const t0 = Date.now();
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
        "con.commit()",
        "con.close()",
      ].join("; "),
    ],
    { cwd: SANDBOX, stdio: "pipe" },
  );
  return Date.now() - t0;
}

function restoreSandbox(): void {
  execFileSync("git", ["-C", SANDBOX, "checkout", "--", "."], { stdio: "pipe" });
}

async function waitHorillaReady(initialDelayMs = 500): Promise<void> {
  if (initialDelayMs > 0) {
    await new Promise((r) => setTimeout(r, initialDelayMs));
  }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/login/`);
      if (res.ok) {
        return;
      }
    } catch {
      // Server reloading
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timed out waiting for Horilla server to reload.");
}

async function main() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.mkdirSync(DRAFT_DIR, { recursive: true });

  const llm = new LlmClient({
    endpoint: process.env.SKILL_GRAPH_LLM_ENDPOINT ?? "https://openrouter.ai/api/v1/chat/completions",
    model: process.env.SKILL_GRAPH_LLM_MODEL ?? "deepseek/deepseek-v3.2",
  });

  const validator = createSkillValidator(SCHEMA_PATH);
  const loaded = validator.validateDirectory(SKILLS_DIR);
  if (!loaded.valid) {
    throw new Error(`Invalid Horilla skills: ${JSON.stringify(loaded.diagnostics)}`);
  }
  const skills = loaded.skills.map((s) => s.skill);
  const skillsById = new Map(skills.map((s) => [s.id, s]));

  try {
    // =========================================================================
    // PROOF 4.1: Zero-LLM Composable Multi-Skill Stability on Horilla (Django/HTMX)
    // =========================================================================
    console.log("=== PROOF 4.1: Zero-LLM Composable Runs on Horilla HRMS ===");
    const deptRuns = [
      "Platform QA Ops",
      "Security Governance",
      "Cloud FinOps",
    ];
    const zeroLlmRuns: Array<{
      workflow: string;
      steps: string[];
      input: string;
      verdict: string;
      durationMs: number;
      dbResetMs: number;
      llmCallsUsed: number;
    }> = [];

    for (const deptName of deptRuns) {
      const dbResetMs = resetHorillaTestRows();
      const plan = planToReach({
        skills,
        goal: {
          name: "department.filtered",
          params: { department: deptName },
        },
        bindings: {
          user: DEMO_USER,
          username: DEMO_USER,
          password: DEMO_PASS,
        },
      });
      const report = await executePlan(plan, skillsById, {
        baseUrl: BASE_URL,
        stepTimeoutMs: 10000,
        evidenceDir: EVIDENCE_DIR,
      });
      console.log(
        `  [Dept Chain] ${deptName} -> ${report.verdict} (${report.totalDurationMs}ms, steps=${plan.steps.map((s) => s.skillId).join(" -> ")}, llm=0)`,
      );
      if (report.verdict !== "VERIFIED_PASS") {
        throw new Error(`Horilla dept chain failed for ${deptName}: ${JSON.stringify(report.skillReports)}`);
      }
      zeroLlmRuns.push({
        workflow: "department.filtered",
        steps: plan.steps.map((s) => s.skillId),
        input: deptName,
        verdict: report.verdict,
        durationMs: report.totalDurationMs,
        dbResetMs,
        llmCallsUsed: plan.llmCallsUsed,
      });
    }

    // Separate module: Employee Type creation
    {
      const dbResetMs = resetHorillaTestRows();
      const plan = planToReach({
        skills,
        goal: {
          name: "employee_type.exists",
          params: { employeeType: "Contract Specialist" },
        },
        bindings: {
          user: DEMO_USER,
          username: DEMO_USER,
          password: DEMO_PASS,
        },
      });
      const report = await executePlan(plan, skillsById, {
        baseUrl: BASE_URL,
        stepTimeoutMs: 10000,
        evidenceDir: EVIDENCE_DIR,
      });
      console.log(
        `  [EmployeeType Chain] Contract Specialist -> ${report.verdict} (${report.totalDurationMs}ms, steps=${plan.steps.map((s) => s.skillId).join(" -> ")}, llm=0)`,
      );
      if (report.verdict !== "VERIFIED_PASS") {
        throw new Error(`Horilla employee_type chain failed: ${JSON.stringify(report.skillReports)}`);
      }
      zeroLlmRuns.push({
        workflow: "employee_type.exists",
        steps: plan.steps.map((s) => s.skillId),
        input: "Contract Specialist",
        verdict: report.verdict,
        durationMs: report.totalDurationMs,
        dbResetMs,
        llmCallsUsed: plan.llmCallsUsed,
      });
    }

    // =========================================================================
    // PROOF 4.2: White-Box git diff Impact Selection + Live Self-Healing (Django template UI rename)
    // =========================================================================
    console.log("\n=== PROOF 4.2: Django Template UI Drift -> Impact Selection -> 1-LLM White-Box Self-Heal ===");
    resetHorillaTestRows();
    const loginTplPath = path.join(SANDBOX, "horilla_theme/templates/login.html");
    const loginTplOrig = fs.readFileSync(loginTplPath, "utf-8");
    const loginTplEdited = loginTplOrig.replace('{% trans "Sign In" %}', '{% trans "Access Workspace" %}');
    if (loginTplEdited === loginTplOrig) {
      throw new Error("Failed to mutate Sign In button text in horilla_theme/templates/login.html");
    }
    fs.writeFileSync(loginTplPath, loginTplEdited, "utf-8");

    const impactUi = selectImpactedSkills(loaded.skills, SANDBOX, "HEAD");
    console.log("  Impacted skills on login.html edit:", impactUi.affectedSkills.map((a) => a.skillId));
    if (JSON.stringify(impactUi.affectedSkills.map((a) => a.skillId)) !== JSON.stringify(["auth.login"])) {
      throw new Error(`Expected ONLY ['auth.login'], got ${JSON.stringify(impactUi.affectedSkills.map((a) => a.skillId))}`);
    }

    const loginGoal = { name: "auth.logged_in", params: { user: DEMO_USER } };
    const loginBindings = { username: DEMO_USER, password: DEMO_PASS };
    const loginPlanBeforeHeal = planToReach({
      skills,
      goal: loginGoal,
      bindings: loginBindings,
    });
    const loginDriftReport = await executePlan(loginPlanBeforeHeal, skillsById, {
      baseUrl: BASE_URL,
      stepTimeoutMs: 5000,
      evidenceDir: EVIDENCE_DIR,
    });
    const failedLoginSkillReport = loginDriftReport.skillReports.find((r) => r.skillId === "auth.login");
    console.log("  Initial execution verdict on renamed login button:", loginDriftReport.verdict);
    if (!failedLoginSkillReport || failedLoginSkillReport.verdict !== "SKILL_DRIFT") {
      throw new Error(`Expected SKILL_DRIFT on login button rename, got ${failedLoginSkillReport?.verdict}`);
    }

    const healRes = await healSkillFromDrift({
      skill: skillsById.get("auth.login")!,
      allSkills: skills,
      failedReport: failedLoginSkillReport,
      scopedGitDiff: impactUi.scopedDiffBySkill["auth.login"] ?? "",
      llm,
      executorOptions: {
        baseUrl: BASE_URL,
        stepTimeoutMs: 10000,
        evidenceDir: EVIDENCE_DIR,
      },
      verifyGoal: loginGoal,
      bindings: loginBindings,
      schemaPath: SCHEMA_PATH,
      writeOnVerify: false,
    });
    console.log(
      `  Heal result: status=${healRes.status}, llmCalls=${healRes.llmCallsUsed}, explanation=${healRes.explanation}`,
    );
    if (healRes.status !== "HEALED_AND_VERIFIED" || !healRes.patchedSkill) {
      throw new Error(`Expected HEALED_AND_VERIFIED, got ${JSON.stringify(healRes)}`);
    }

    // Prove follow-up 0-LLM execution of the FULL 3-skill chain using the healed auth.login skill!
    resetHorillaTestRows();
    const healedSkillsMap = new Map(skillsById);
    healedSkillsMap.set("auth.login", healRes.patchedSkill);
    const healedSkillsList = Array.from(healedSkillsMap.values());
    const postHealPlan = planToReach({
      skills: healedSkillsList,
      goal: {
        name: "department.filtered",
        params: { department: "Healed Flow Engineering" },
      },
      bindings: {
        user: DEMO_USER,
        username: DEMO_USER,
        password: DEMO_PASS,
      },
    });
    const postHealReplay = await executePlan(postHealPlan, healedSkillsMap, {
      baseUrl: BASE_URL,
      stepTimeoutMs: 10000,
      evidenceDir: EVIDENCE_DIR,
    });
    console.log(
      `  Post-heal 0-LLM 3-skill replay verdict=${postHealReplay.verdict} (${postHealReplay.totalDurationMs}ms, llm=0)`,
    );
    if (postHealReplay.verdict !== "VERIFIED_PASS") {
      throw new Error(`Expected VERIFIED_PASS after healing, got ${postHealReplay.verdict}`);
    }

    restoreSandbox();

    // =========================================================================
    // PROOF 4.3: Real Python/Django PRODUCT_BUG -> Hard Refusal (0 LLM) + Bug Draft Export
    // =========================================================================
    console.log("\n=== PROOF 4.3: Python/Django Silent Persistence Bug -> PRODUCT_BUG + Refusal (0 LLM) + Bug Draft ===");
    resetHorillaTestRows();
    const deptViewPath = path.join(SANDBOX, "base/cbv/department.py");
    const deptViewOrig = fs.readFileSync(deptViewPath, "utf-8");
    const deptViewBuggy = deptViewOrig.replace(
      "            form.save()",
      "            # BUG: silently skipped form.save() before returning HTTP 200",
    );
    if (deptViewBuggy === deptViewOrig) {
      throw new Error("Failed to inject silent persistence bug into base/cbv/department.py");
    }
    fs.writeFileSync(deptViewPath, deptViewBuggy, "utf-8");

    // Wait for Django StatReloader to detect base/cbv/department.py edit and restart worker
    console.log("  Waiting for Django auto-reloader to load modified base/cbv/department.py...");
    await waitHorillaReady(5000);
    await new Promise((r) => setTimeout(r, 10000));
    await waitHorillaReady(0);

    const impactBug = selectImpactedSkills(loaded.skills, SANDBOX, "HEAD");
    console.log("  Impacted skills on base/cbv/department.py edit:", impactBug.affectedSkills.map((a) => a.skillId));
    if (
      JSON.stringify(impactBug.affectedSkills.map((a) => a.skillId)) !==
      JSON.stringify(["department.create", "department.search"])
    ) {
      throw new Error(
        `Expected ['department.create', 'department.search'], got ${JSON.stringify(impactBug.affectedSkills.map((a) => a.skillId))}`,
      );
    }

    const bugGoal = {
      name: "department.exists",
      params: { department: "Silent Bug Dept" },
    };
    const bugBindings = {
      user: DEMO_USER,
      username: DEMO_USER,
      password: DEMO_PASS,
    };
    const bugPlan = planToReach({
      skills,
      goal: bugGoal,
      bindings: bugBindings,
    });
    const bugExecReport = await executePlan(bugPlan, skillsById, {
      baseUrl: BASE_URL,
      stepTimeoutMs: 6000,
      evidenceDir: EVIDENCE_DIR,
    });
    const failedDeptReport = bugExecReport.skillReports.find((r) => r.skillId === "department.create");
    console.log("  Execution verdict on silent form.save() bug:", bugExecReport.verdict);
    if (!failedDeptReport || failedDeptReport.verdict !== "PRODUCT_BUG" || !failedDeptReport.bug) {
      throw new Error(
        `Expected PRODUCT_BUG on silent form.save() bug, got ${failedDeptReport?.verdict}: ${JSON.stringify(failedDeptReport)}`,
      );
    }

    const refusedHeal = await healSkillFromDrift({
      skill: skillsById.get("department.create")!,
      allSkills: skills,
      failedReport: failedDeptReport,
      scopedGitDiff: impactBug.scopedDiffBySkill["department.create"] ?? "",
      llm,
      executorOptions: {
        baseUrl: BASE_URL,
        stepTimeoutMs: 6000,
        evidenceDir: EVIDENCE_DIR,
      },
      verifyGoal: bugGoal,
      bindings: bugBindings,
      schemaPath: SCHEMA_PATH,
    });
    console.log(
      `  Self-heal refusal check: status=${refusedHeal.status}, llmCalls=${refusedHeal.llmCallsUsed}`,
    );
    if (refusedHeal.status !== "REFUSED_PRODUCT_BUG" || refusedHeal.llmCallsUsed !== 0) {
      throw new Error(`Expected REFUSED_PRODUCT_BUG with 0 LLM calls, got ${JSON.stringify(refusedHeal)}`);
    }

    const bugDraft = buildBugDraftFromEvidence("horilla", failedDeptReport.bug, {
      gitBaseRef: "HEAD",
    });
    const draftPath = writeBugDraft(bugDraft, DRAFT_DIR);
    console.log(`  Exported deterministic DRAFT bug record: ${bugDraft.draftId} -> ${draftPath}`);

    // =========================================================================
    // Save Phase 4 Evidence Receipt
    // =========================================================================
    const llmStats = llm.getStats();
    const avgZeroLlmMs = Math.round(
      zeroLlmRuns.reduce((acc, r) => acc + r.durationMs, 0) / zeroLlmRuns.length,
    );
    const receipt = {
      version: 1,
      stage: "PHASE_4_HORILLA_CROSS_PROJECT_PROOF",
      timestamp: new Date().toISOString(),
      targetApp: {
        name: "horilla-opensource/horilla",
        stack: "Python 3.12 + Django 5.2 + HTMX + SQLite (0 Docker)",
        coreEngineChangesRequired: 0,
      },
      llmStats,
      proof4_1_zeroLlmStability: {
        totalRuns: zeroLlmRuns.length,
        passedRuns: zeroLlmRuns.filter((r) => r.verdict === "VERIFIED_PASS").length,
        totalLlmCalls: 0,
        avgDurationMs: avgZeroLlmMs,
        runs: zeroLlmRuns,
      },
      proof4_2_djangoTemplateDriftSelfHeal: {
        editedFile: "horilla_theme/templates/login.html",
        impactedSkills: impactUi.affectedSkills.map((a) => a.skillId),
        skippedSkillCount: loaded.skills.length - impactUi.affectedSkills.length,
        initialVerdict: failedLoginSkillReport.verdict,
        healStatus: healRes.status,
        healLlmCalls: healRes.llmCallsUsed,
        healExplanation: healRes.explanation,
        postHealFullChainSteps: postHealPlan.steps.map((s) => s.skillId),
        postHealReplayVerdict: postHealReplay.verdict,
        postHealReplayDurationMs: postHealReplay.totalDurationMs,
        postHealReplayLlmCalls: 0,
      },
      proof4_3_pythonProductBugRefusalAndDraft: {
        editedFile: "base/cbv/department.py",
        impactedSkills: impactBug.affectedSkills.map((a) => a.skillId),
        skippedSkillCount: loaded.skills.length - impactBug.affectedSkills.length,
        verdict: failedDeptReport.verdict,
        healAttemptStatus: refusedHeal.status,
        healAttemptLlmCalls: refusedHeal.llmCallsUsed,
        bugDraftId: bugDraft.draftId,
        bugDraftStatus: bugDraft.status,
        bugDraftOrigin: bugDraft.origin,
        bugDraftPath: path.relative(ROOT, draftPath).replace(/\\/g, "/"),
        bugSymptom: bugDraft.symptom,
      },
    };

    const receiptPath = path.join(EVIDENCE_DIR, "phase4-horilla-cross-project-receipt.json");
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf-8");
    console.log(`\nPhase 4 Cross-Project Receipt saved -> ${receiptPath}`);
    console.log(JSON.stringify(receipt, null, 2));
  } finally {
    restoreSandbox();
    resetHorillaTestRows();
  }
}

main().catch((err) => {
  console.error("PHASE 4 HORILLA PROOF FAILED:", err);
  try {
    restoreSandbox();
  } catch {
    // ignore
  }
  process.exit(1);
});
