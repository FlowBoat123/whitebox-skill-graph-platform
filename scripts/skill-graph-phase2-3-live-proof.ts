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
} from "../packages/skill-graph/src/index.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const SANDBOX = path.join(ROOT, "runtime/sandboxes/cypress-realworld-app");
const SKILLS_DIR = path.join(ROOT, "skills/cypress-rwa");
const SCHEMA_PATH = path.join(ROOT, "contracts/skill-graph/skill.schema.json");
const EVIDENCE_DIR = path.join(ROOT, "runtime/skill-graph-evidence");
const DRAFT_DIR = path.join(EVIDENCE_DIR, "bug-drafts");
const BASE_URL = "http://localhost:3000";
const API_URL = "http://localhost:3001";

async function resetDb(): Promise<void> {
  const res = await fetch(`${API_URL}/testData/seed`, { method: "POST" });
  if (!res.ok) throw new Error(`DB reset failed: HTTP ${res.status}`);
}

function restoreSandbox(): void {
  execFileSync("git", ["-C", SANDBOX, "checkout", "--", "."], { stdio: "pipe" });
}

async function waitHmr(): Promise<void> {
  await new Promise((r) => setTimeout(r, 600));
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
    throw new Error(`Invalid skills: ${JSON.stringify(loaded.diagnostics)}`);
  }
  const existingSkills = loaded.skills.map((s) => s.skill);
  const skillsById = new Map(existingSkills.map((s) => [s.id, s]));

  // =========================================================================
  // PROOF #3: Author brand-new skill `tx.comment` with 1 Cloud LLM -> 0-LLM Replay!
  // =========================================================================
  console.log("=== PROOF #3: Live White-Box Authoring (`tx.comment`) ===");
  const commentSkillPath = path.join(SKILLS_DIR, "tx.comment.yaml");
  const authorRes = await authorNewSkill({
    skillId: "tx.comment",
    app: "cypress-rwa",
    description: "Open a newly created payment on the Mine tab and post a comment.",
    goalPrompt:
      "Navigate to Home (click 'Home' link in sidebar or go to /personal), click the 'Mine' tab if needed, open the transaction with description 'Author Target Tx', then type 'First authored comment!' into the 'Write a comment...' box and press Enter to submit it.",
    preconditions: [
      {
        name: "tx.paid",
        params: { sender: "{{sender}}", receiver: "{{receiver}}", note: "{{note}}" },
      },
      {
        name: "auth.logged_in",
        singleton: true,
        params: { user: "{{sender}}" },
      },
    ],
    produces: [
      {
        name: "tx.commented",
        params: { sender: "{{sender}}", note: "{{note}}", commentText: "{{commentText}}" },
      },
    ],
    inputs: {
      sender: { type: "string", required: true },
      receiver: { type: "string", required: true },
      note: { type: "string", required: true },
      commentText: { type: "string", required: true },
    },
    expectedPostconditions: [
      { kind: "HTTP_STATUS", method: "POST", path: "/comments", expectStatus: 200 },
      { kind: "CONSOLE_ERRORS", maxCount: 0 },
      { kind: "PAGE_ERRORS", maxCount: 0 },
      { kind: "DOM_CONTAINS", text: "{{commentText}}" },
    ],
    authorBindings: {
      sender: "Heath93",
      receiver: "Arvilla_Hegmann",
      receiverName: "Kristian Bradtke",
      amount: "25",
      note: "Author Target Tx",
      commentText: "First authored comment!",
    },
    replayBindings: {
      sender: "Heath93",
      receiver: "Arvilla_Hegmann",
      receiverName: "Kristian Bradtke",
      amount: "37",
      note: "Fresh Generalized Replay Tx",
      commentText: "Verified zero-LLM generalized replay!",
    },
    actorBindings: {
      Heath93: { password: "s3cret" },
    },
    existingSkills: existingSkills.filter((s) => s.id !== "tx.comment"),
    repoPath: SANDBOX,
    executorOptions: {
      baseUrl: BASE_URL,
      apiBaseUrl: API_URL,
      stepTimeoutMs: 6000,
      evidenceDir: EVIDENCE_DIR,
    },
    llm,
    maxSteps: 8,
    schemaPath: SCHEMA_PATH,
    beforeRun: resetDb,
    outputFilePath: commentSkillPath,
  });
  console.log("Author result:", authorRes.status, "llmCalls=", authorRes.llmCallsUsed, "replay=", authorRes.replayVerdict);

  // =========================================================================
  // PROOF #4A: White-Box Healing Commit UI-A (Button Rename Save -> Confirm Account)
  // =========================================================================
  console.log("=== PROOF #4A: White-Box Self-Healing Commit UI-A (Button Rename) ===");
  const bankSkill = skillsById.get("bank.create")!;
  const bankFormPath = path.join(SANDBOX, "src/components/BankAccountForm.tsx");
  const bankGoal = {
    name: "bank.exists",
    params: { user: "Heath93", bankName: "Healed Bank A" },
  };
  const bankBindings = {
    password: "s3cret",
    routingNumber: "987654321",
    accountNumber: "1234567890",
  };

  let proof4A: Record<string, unknown> = {};
  let proof4B: Record<string, unknown> = {};
  let proof4C: Record<string, unknown> = {};

  try {
    const origBankForm = fs.readFileSync(bankFormPath, "utf8");
    fs.writeFileSync(
      bankFormPath,
      origBankForm
        .replace(">\r\n                Save\r\n              </Button>", ">\r\n                Confirm Account\r\n              </Button>")
        .replace(">\n                Save\n              </Button>", ">\n                Confirm Account\n              </Button>"),
    );
    await waitHmr();
    await resetDb();

    const impactA = selectImpactedSkills(loaded.skills, SANDBOX, "HEAD");
    const planA = planToReach({ skills: existingSkills, goal: bankGoal, bindings: bankBindings });
    const driftA = await executePlan(planA, skillsById, {
      baseUrl: BASE_URL,
      apiBaseUrl: API_URL,
      stepTimeoutMs: 3500,
      evidenceDir: EVIDENCE_DIR,
    });
    const healA = await healSkillFromDrift({
      skill: bankSkill,
      allSkills: existingSkills,
      failedReport: driftA.skillReports.at(-1)!,
      scopedGitDiff: impactA.scopedDiffBySkill["bank.create"] ?? "",
      llm,
      executorOptions: {
        baseUrl: BASE_URL,
        apiBaseUrl: API_URL,
        stepTimeoutMs: 5000,
        evidenceDir: EVIDENCE_DIR,
      },
      verifyGoal: bankGoal,
      bindings: bankBindings,
      schemaPath: SCHEMA_PATH,
      beforeVerify: resetDb,
      writeOnVerify: false,
    });

    // Follow-up 0-LLM run with healed skill and fresh bank name!
    let followUpVerdictA = "SKIPPED";
    let followUpMsA = 0;
    if (healA.status === "HEALED_AND_VERIFIED" && healA.patchedSkill) {
      await resetDb();
      const updatedA = existingSkills.map((s) => (s.id === "bank.create" ? healA.patchedSkill! : s));
      const fPlan = planToReach({
        skills: updatedA,
        goal: { name: "bank.exists", params: { user: "Heath93", bankName: "Healed Bank A2" } },
        bindings: bankBindings,
      });
      const fRes = await executePlan(
        fPlan,
        new Map(updatedA.map((s) => [s.id, s])),
        { baseUrl: BASE_URL, apiBaseUrl: API_URL, stepTimeoutMs: 5000 },
      );
      followUpVerdictA = fRes.verdict;
      followUpMsA = fRes.totalDurationMs;
    }

    proof4A = {
      impactedSkills: impactA.affectedSkills.map((a) => a.skillId),
      initialVerdict: driftA.verdict,
      healStatus: healA.status,
      healLlmCalls: healA.llmCallsUsed,
      healExplanation: healA.explanation,
      followUpZeroLlmVerdict: followUpVerdictA,
      followUpZeroLlmDurationMs: followUpMsA,
    };
    console.log("Proof #4A:", proof4A);

    restoreSandbox();
    await waitHmr();

    // =========================================================================
    // PROOF #4B: White-Box Healing Commit UI-B (New Required Field "Branch Code" added!)
    // =========================================================================
    console.log("=== PROOF #4B: White-Box Self-Healing Commit UI-B (New Required Field) ===");
    let formWithBranch = fs.readFileSync(bankFormPath, "utf8");
    formWithBranch = formWithBranch
      .replace(
        'bankName: string().min(5, "Must contain at least 5 characters").required("Enter a bank name"),',
        'bankName: string().min(5, "Must contain at least 5 characters").required("Enter a bank name"),\n  branchCode: string().min(3, "Must contain at least 3 characters").required("Enter a branch code"),',
      )
      .replace(
        'routingNumber: "",',
        'routingNumber: "",\n    branchCode: "",',
      )
      .replace(
        'const initialValues: BankAccountPayload = {',
        'const initialValues: BankAccountPayload & { branchCode: string } = {',
      )
      .replace(
        '<Grid\n            container',
        `<Field name="branchCode">
            {({ field, meta: { error, value, initialValue, touched } }: FieldProps) => (
              <TextField
                variant="outlined"
                margin="dense"
                fullWidth
                required
                id={"bankaccount-branchCode-input"}
                type="text"
                placeholder="Branch Code"
                data-test={"bankaccount-branchCode-input"}
                error={(touched || value !== initialValue) && Boolean(error)}
                helperText={touched || value !== initialValue ? error : ""}
                {...field}
              />
            )}
          </Field>
          <Grid\n            container`,
      )
      .replace(
        '<Grid\r\n            container',
        `<Field name="branchCode">
            {({ field, meta: { error, value, initialValue, touched } }: FieldProps) => (
              <TextField
                variant="outlined"
                margin="dense"
                fullWidth
                required
                id={"bankaccount-branchCode-input"}
                type="text"
                placeholder="Branch Code"
                data-test={"bankaccount-branchCode-input"}
                error={(touched || value !== initialValue) && Boolean(error)}
                helperText={touched || value !== initialValue ? error : ""}
                {...field}
              />
            )}
          </Field>
          <Grid\r\n            container`,
      );
    fs.writeFileSync(bankFormPath, formWithBranch);
    await waitHmr();
    await resetDb();

    const impactB = selectImpactedSkills(loaded.skills, SANDBOX, "HEAD");
    const planB = planToReach({
      skills: existingSkills,
      goal: { name: "bank.exists", params: { user: "Heath93", bankName: "Healed Bank B" } },
      bindings: { ...bankBindings, branchCode: "NYC-101" },
    });
    const driftB = await executePlan(planB, skillsById, {
      baseUrl: BASE_URL,
      apiBaseUrl: API_URL,
      stepTimeoutMs: 3500,
      evidenceDir: EVIDENCE_DIR,
    });
    const healB = await healSkillFromDrift({
      skill: bankSkill,
      allSkills: existingSkills,
      failedReport: driftB.skillReports.at(-1)!,
      scopedGitDiff: impactB.scopedDiffBySkill["bank.create"] ?? "",
      llm,
      executorOptions: {
        baseUrl: BASE_URL,
        apiBaseUrl: API_URL,
        stepTimeoutMs: 5000,
        evidenceDir: EVIDENCE_DIR,
      },
      verifyGoal: { name: "bank.exists", params: { user: "Heath93", bankName: "Healed Bank B" } },
      bindings: { ...bankBindings, branchCode: "NYC-101" },
      schemaPath: SCHEMA_PATH,
      beforeVerify: resetDb,
      writeOnVerify: false,
    });

    let followUpVerdictB = "SKIPPED";
    let followUpMsB = 0;
    if (healB.status === "HEALED_AND_VERIFIED" && healB.patchedSkill) {
      await resetDb();
      const updatedB = existingSkills.map((s) => (s.id === "bank.create" ? healB.patchedSkill! : s));
      const fPlanB = planToReach({
        skills: updatedB,
        goal: { name: "bank.exists", params: { user: "Heath93", bankName: "Healed Bank B2" } },
        bindings: { ...bankBindings, branchCode: "SFO-202" },
      });
      const fResB = await executePlan(
        fPlanB,
        new Map(updatedB.map((s) => [s.id, s])),
        { baseUrl: BASE_URL, apiBaseUrl: API_URL, stepTimeoutMs: 5000 },
      );
      followUpVerdictB = fResB.verdict;
      followUpMsB = fResB.totalDurationMs;
    }

    proof4B = {
      impactedSkills: impactB.affectedSkills.map((a) => a.skillId),
      initialVerdict: driftB.verdict,
      healStatus: healB.status,
      healLlmCalls: healB.llmCallsUsed,
      healExplanation: healB.explanation,
      addedInputKeys: healB.patchedSkill ? Object.keys(healB.patchedSkill.inputs) : [],
      followUpZeroLlmVerdict: followUpVerdictB,
      followUpZeroLlmDurationMs: followUpMsB,
    };
    console.log("Proof #4B:", proof4B);

    restoreSandbox();
    await waitHmr();

    // =========================================================================
    // PROOF #4C + CHẶNG 3: Commit BUG-C (Real Regression Bug) -> REFUSE HEALING + Bug Draft!
    // =========================================================================
    console.log("=== PROOF #4C & CHẶNG 3: Commit BUG-C -> Refuse Heal + Defect Knowledge Draft ===");
    const txDetailPath = path.join(SANDBOX, "src/components/TransactionDetail.tsx");
    const origTxDetail = fs.readFileSync(txDetailPath, "utf8");
    fs.writeFileSync(
      txDetailPath,
      origTxDetail.replace(
        /onClick=\{\(\) =>\s*transactionUpdate\(\{\s*id: transaction\.id,\s*requestStatus: TransactionRequestStatus\.accepted,\s*\}\)\s*\}/m,
        "onClick={() => { /* regression: swallowed click */ }}",
      ),
    );
    await waitHmr();
    await resetDb();

    const impactC = selectImpactedSkills(loaded.skills, SANDBOX, "HEAD");
    const txGoal = {
      name: "tx.resolved",
      params: {
        sender: "Heath93",
        receiver: "Arvilla_Hegmann",
        note: "Bug C Regression Proof",
        decisionLabel: "Accept Request",
      },
    };
    const txPlan = planToReach({
      skills: existingSkills,
      goal: txGoal,
      bindings: { receiverName: "Kristian Bradtke", amount: "55" },
      actorBindings: {
        Heath93: { password: "s3cret" },
        Arvilla_Hegmann: { password: "s3cret" },
      },
    });
    const bugExec = await executePlan(txPlan, skillsById, {
      baseUrl: BASE_URL,
      apiBaseUrl: API_URL,
      stepTimeoutMs: 4000,
      evidenceDir: EVIDENCE_DIR,
    });
    const failedTxReport = bugExec.skillReports.at(-1)!;
    const healAttemptOnBug = await healSkillFromDrift({
      skill: skillsById.get("tx.respond_request")!,
      allSkills: existingSkills,
      failedReport: failedTxReport,
      scopedGitDiff: impactC.scopedDiffBySkill["tx.respond_request"] ?? "",
      llm,
      executorOptions: { baseUrl: BASE_URL, apiBaseUrl: API_URL },
      verifyGoal: txGoal,
      schemaPath: SCHEMA_PATH,
    });

    const bugDraft = buildBugDraftFromEvidence("cypress-rwa", failedTxReport.bug!, {
      gitBaseRef: "HEAD",
    });
    const draftPath = writeBugDraft(bugDraft, DRAFT_DIR);

    proof4C = {
      impactedSkills: impactC.affectedSkills.map((a) => a.skillId),
      verdict: bugExec.verdict,
      healAttemptStatus: healAttemptOnBug.status,
      healAttemptLlmCalls: healAttemptOnBug.llmCallsUsed,
      bugDraftId: bugDraft.draftId,
      bugDraftStatus: bugDraft.status,
      bugDraftOrigin: bugDraft.origin,
      bugDraftPath: path.relative(ROOT, draftPath).replace(/\\/g, "/"),
      bugSymptom: bugDraft.symptom,
    };
    console.log("Proof #4C & Chặng 3:", proof4C);
  } finally {
    restoreSandbox();
    await resetDb();
  }

  const receipt = {
    version: 1,
    stage: "PHASE_2_AND_3_LIVE_PROOF_CYPRESS_RWA",
    targetApp: "cypress-io/cypress-realworld-app",
    timestamp: new Date().toISOString(),
    llmStats: llm.getStats(),
    proof3Authoring: {
      skillId: authorRes.skillId,
      status: authorRes.status,
      authorLlmCalls: authorRes.llmCallsUsed,
      replayLlmCalls: authorRes.replayLlmCallsUsed,
      replayVerdict: authorRes.replayVerdict,
      discoveredSourceFiles: authorRes.discoveredSourceFiles,
      wroteFile: authorRes.wroteFile ? path.relative(ROOT, authorRes.wroteFile).replace(/\\/g, "/") : null,
      reason: authorRes.reason,
    },
    proof4A_uiRenameHeal: proof4A,
    proof4B_newRequiredFieldHeal: proof4B,
    proof4C_productBugRefusalAndDraft: proof4C,
  };

  const outPath = path.join(EVIDENCE_DIR, "phase2-3-rwa-live-receipt.json");
  fs.writeFileSync(outPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  console.log("\n=== PHASE 2 & 3 LIVE RECEIPT ===");
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
