import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createSkillValidator,
  executePlan,
  planToReach,
  selectImpactedSkills,
} from "../packages/skill-graph/src/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SANDBOX = path.join(ROOT, "runtime/sandboxes/cypress-realworld-app");
const SKILLS_DIR = path.join(ROOT, "skills/cypress-rwa");
const EVIDENCE_DIR = path.join(ROOT, "runtime/skill-graph-evidence");
const BASE_URL = "http://localhost:3000";
const API_URL = "http://localhost:3001";

async function resetDb(): Promise<number> {
  const t0 = Date.now();
  const res = await fetch(`${API_URL}/testData/seed`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`DB reset failed: HTTP ${res.status}`);
  }
  return Date.now() - t0;
}

function restoreSandbox(): void {
  execFileSync("git", ["-C", SANDBOX, "checkout", "--", "."], { stdio: "pipe" });
}

async function main() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const validator = createSkillValidator(path.join(ROOT, "contracts/skill-graph/skill.schema.json"));
  const loaded = validator.validateDirectory(SKILLS_DIR);
  if (!loaded.valid) {
    throw new Error(`Invalid skills: ${JSON.stringify(loaded.diagnostics)}`);
  }
  const skills = loaded.skills.map((s) => s.skill);
  const skillsById = new Map(skills.map((s) => [s.id, s]));

  // 1. Stability Proof: 5 consecutive runs of 5-skill 2-user workflow with varying inputs & Accept/Reject
  const stabilityRuns: Array<{
    run: number;
    note: string;
    amount: string;
    decision: string;
    resetMs: number;
    durationMs: number;
    verdict: string;
    llmCallsUsed: number;
    skillsExecuted: string[];
  }> = [];

  const cases = [
    { note: "Proof Run 1 Coffee", amount: "18", decision: "Accept Request" },
    { note: "Proof Run 2 Dinner", amount: "62", decision: "Reject Request" },
    { note: "Proof Run 3 Tickets", amount: "95", decision: "Accept Request" },
    { note: "Proof Run 4 Groceries", amount: "41", decision: "Reject Request" },
    { note: "Proof Run 5 Utility", amount: "120", decision: "Accept Request" },
  ];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const resetMs = await resetDb();
    const plan = planToReach({
      skills,
      goal: {
        name: "tx.resolved",
        params: {
          sender: "Heath93",
          receiver: "Arvilla_Hegmann",
          note: c.note,
          decisionLabel: c.decision,
        },
      },
      bindings: { receiverName: "Kristian Bradtke", amount: c.amount },
      actorBindings: {
        Heath93: { password: "s3cret" },
        Arvilla_Hegmann: { password: "s3cret" },
      },
    });
    const res = await executePlan(plan, skillsById, {
      baseUrl: BASE_URL,
      apiBaseUrl: API_URL,
      evidenceDir: EVIDENCE_DIR,
    });
    stabilityRuns.push({
      run: i + 1,
      note: c.note,
      amount: c.amount,
      decision: c.decision,
      resetMs,
      durationMs: res.totalDurationMs,
      verdict: res.verdict,
      llmCallsUsed: res.llmCallsUsed,
      skillsExecuted: res.skillReports.map((r) => r.skillId),
    });
  }

  // 2. Live White-Box Discrimination Proofs (SKILL_DRIFT vs PRODUCT_BUG via real sandbox edits + git diff)
  const bankExistsPlan = planToReach({
    skills,
    goal: { name: "bank.exists", params: { user: "Heath93", bankName: "WhiteBox Bank" } },
    bindings: { password: "s3cret", routingNumber: "987654321", accountNumber: "1234567890" },
  });

  const discriminationResults: Record<string, unknown> = {};

  try {
    // Case A: Breaking UI Rename Drift in BankAccountForm.tsx ("Save" -> "Confirm Account")
    const bankFormPath = path.join(SANDBOX, "src/components/BankAccountForm.tsx");
    const origBankForm = fs.readFileSync(bankFormPath, "utf8");
    fs.writeFileSync(
      bankFormPath,
      origBankForm.replace(">\r\n                Save\r\n              </Button>", ">\r\n                Confirm Account\r\n              </Button>")
        .replace(">\n                Save\n              </Button>", ">\n                Confirm Account\n              </Button>"),
    );
    await new Promise((r) => setTimeout(r, 400));
    await resetDb();
    const impactDrift = selectImpactedSkills(loaded.skills, SANDBOX, "HEAD");
    const driftRun = await executePlan(bankExistsPlan, skillsById, {
      baseUrl: BASE_URL,
      apiBaseUrl: API_URL,
      stepTimeoutMs: 3000,
      evidenceDir: EVIDENCE_DIR,
    });
    discriminationResults.uiRenameDrift = {
      impactedSkills: impactDrift.affectedSkills.map((a) => a.skillId),
      diffContainsNewLabel: (impactDrift.scopedDiffBySkill["bank.create"] ?? "").includes("Confirm Account"),
      verdict: driftRun.verdict,
      failedSkillId: driftRun.failedSkillId,
      snapshotSawNewButton: Boolean(
        driftRun.skillReports.at(-1)?.drift?.interactiveSnapshot.some((l) =>
          l.includes("Confirm Account"),
        ),
      ),
    };
    restoreSandbox();
    await new Promise((r) => setTimeout(r, 400));

    // Case B: Runtime JS Crash Bug in BankAccountForm.tsx (onSubmit throws)
    const bankFormCrash = fs
      .readFileSync(bankFormPath, "utf8")
      .replace(
        "createBankAccount({ ...values, userId });",
        'throw new Error("Simulated bank submission crash");',
      );
    fs.writeFileSync(bankFormPath, bankFormCrash);
    await new Promise((r) => setTimeout(r, 400));
    await resetDb();
    const impactCrash = selectImpactedSkills(loaded.skills, SANDBOX, "HEAD");
    const crashRun = await executePlan(bankExistsPlan, skillsById, {
      baseUrl: BASE_URL,
      apiBaseUrl: API_URL,
      stepTimeoutMs: 3000,
      evidenceDir: EVIDENCE_DIR,
    });
    discriminationResults.runtimeCrashBug = {
      impactedSkills: impactCrash.affectedSkills.map((a) => a.skillId),
      verdict: crashRun.verdict,
      failedSkillId: crashRun.failedSkillId,
      bugSummary: crashRun.skillReports.at(-1)?.bug?.summary ?? null,
      capturedPageError: crashRun.skillReports
        .at(-1)
        ?.consoleErrors.some((e) => e.text.includes("Simulated bank submission crash")) ?? false,
    };
    restoreSandbox();
    await new Promise((r) => setTimeout(r, 400));

    // Case C: Silent Business Logic Regression in TransactionDetail.tsx (Accept Request button does nothing)
    const txDetailPath = path.join(SANDBOX, "src/components/TransactionDetail.tsx");
    const origTxDetail = fs.readFileSync(txDetailPath, "utf8");
    fs.writeFileSync(
      txDetailPath,
      origTxDetail.replace(
        "requestStatus: TransactionRequestStatus.accepted,",
        "/* regression: no-op */ requestStatus: TransactionRequestStatus.accepted,",
      ).replace(
        /onClick=\{\(\) =>\s*transactionUpdate\(\{\s*id: transaction\.id,\s*\/\* regression: no-op \*\/ requestStatus: TransactionRequestStatus\.accepted,\s*\}\)\s*\}/m,
        "onClick={() => { /* regression: swallowed click */ }}",
      ),
    );
    await new Promise((r) => setTimeout(r, 400));
    await resetDb();
    const impactSilent = selectImpactedSkills(loaded.skills, SANDBOX, "HEAD");
    const txPlan = planToReach({
      skills,
      goal: {
        name: "tx.resolved",
        params: {
          sender: "Heath93",
          receiver: "Arvilla_Hegmann",
          note: "Silent Bug Probe",
          decisionLabel: "Accept Request",
        },
      },
      bindings: { receiverName: "Kristian Bradtke", amount: "33" },
      actorBindings: {
        Heath93: { password: "s3cret" },
        Arvilla_Hegmann: { password: "s3cret" },
      },
    });
    const silentRun = await executePlan(txPlan, skillsById, {
      baseUrl: BASE_URL,
      apiBaseUrl: API_URL,
      stepTimeoutMs: 3500,
      evidenceDir: EVIDENCE_DIR,
    });
    discriminationResults.silentLogicBug = {
      impactedSkills: impactSilent.affectedSkills.map((a) => a.skillId),
      verdict: silentRun.verdict,
      failedSkillId: silentRun.failedSkillId,
      bugSummary: silentRun.skillReports.at(-1)?.bug?.summary ?? null,
      failedPostconditions:
        silentRun.skillReports.at(-1)?.bug?.failedPostconditions.map((p) => p.kind) ?? [],
    };
  } finally {
    restoreSandbox();
    await resetDb();
  }

  const receipt = {
    version: 1,
    stage: "PHASE_0_AND_1_LIVE_PROOF_CYPRESS_RWA",
    targetApp: "cypress-io/cypress-realworld-app",
    timestamp: new Date().toISOString(),
    stabilityProof: {
      totalRuns: stabilityRuns.length,
      passedRuns: stabilityRuns.filter((r) => r.verdict === "VERIFIED_PASS").length,
      totalLlmCalls: stabilityRuns.reduce((s, r) => s + r.llmCallsUsed, 0),
      avgDurationMs: Math.round(
        stabilityRuns.reduce((s, r) => s + r.durationMs, 0) / stabilityRuns.length,
      ),
      avgDbResetMs: Math.round(
        stabilityRuns.reduce((s, r) => s + r.resetMs, 0) / stabilityRuns.length,
      ),
      runs: stabilityRuns,
    },
    whiteBoxDiscriminationProof: discriminationResults,
  };

  const outPath = path.join(EVIDENCE_DIR, "phase1-rwa-live-receipt.json");
  fs.writeFileSync(outPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(receipt, null, 2));
}

main().catch((err) => {
  try {
    restoreSandbox();
  } catch {
    // ignore
  }
  console.error(err);
  process.exitCode = 1;
});
