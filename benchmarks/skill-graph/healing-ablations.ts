import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  createSkillValidator,
  executePlan,
  healSkillFromDrift,
  LlmClient,
  planToReach,
  resolveDefaultSchemaPath,
  type ConcreteFact,
  type ExecutorOptions,
  type HealingResult,
  type SkillDefinition,
  type SkillExecutionReport,
} from "../../packages/skill-graph/src/index.js";

export interface AblationHealRequest {
  skill: SkillDefinition;
  allSkills: SkillDefinition[];
  failedReport: SkillExecutionReport;
  llm: LlmClient;
  executorOptions: ExecutorOptions;
  verifyGoal: { name: string; params?: Record<string, string> };
  bindings?: Record<string, string>;
  actorBindings?: Record<string, Record<string, string>>;
  initialFacts?: ConcreteFact[];
  schemaPath?: string;
  beforeVerify?: () => Promise<void>;
}

export interface BlackBoxHealOutcome {
  skillId: string;
  status:
    | "HEALED_AND_VERIFIED"
    | "HEAL_FAILED_VERIFICATION"
    | "HEAL_INVALID_SCHEMA"
    | "NOT_APPLICABLE";
  llmCallsUsed: number;
  promptTokens: number;
  completionTokens: number;
  weakenedPostconditions: boolean;
  explanation: string;
  patchedSkill?: SkillDefinition;
}

interface BlackBoxPayload {
  explanation?: string;
  patchedSkill?: SkillDefinition;
}

/**
 * Simulates conventional Black-Box AI Self-Healing tools:
 * - Has NO access to repository git diff (black-box DOM/error only).
 * - Has NO deterministic PRODUCT_BUG refusal gate: attempts to repair ANY failing test
 *   so the test suite turns green again (including adjusting/relaxing failing checks/steps).
 * Used strictly as an empirical ablation baseline in RQ2 to measure False Healing (Silent Bug Masking).
 */
const BLACK_BOX_HEALER_PROMPT = `You are a Black-Box Web Test Self-Healer.
A UI test skill failed during execution. You do NOT have access to the application's source code.
Your goal is to repair the skill definition JSON so that the test executes cleanly and passes on the current live page.

You receive:
- The failing SkillDefinition JSON.
- The failure summary, failed step or postcondition details, current URL, and interactive DOM snapshot (if available).

INSTRUCTIONS:
- Update selectors, steps, URL expectations, or postconditions as needed so the test matches the current behavior of the page and passes cleanly.
- Preserve schemaVersion=1, id, app, description, preconditions, produces, inputs, codeRefs.
- Keep at least 1 step and at least 1 postcondition (e.g. {"kind": "CONSOLE_ERRORS", "maxCount": 0}) so the YAML remains schema-valid.
- Do NOT add extra properties outside the exact keys present in currentSkill (e.g., never add "note", "reason", or "timeout" inside postconditions or targets).
- Valid ops: NAVIGATE, CLICK, FILL, PRESS, SELECT, WAIT_URL, ASSERT_TEXT.
- Valid semantic strategies: role, label, placeholder, text, testid, title.
- Valid roles: button, link, textbox, checkbox, radio, combobox, listitem, tab, menuitem, heading.
- Every {{variable}} used anywhere in patchedSkill MUST be declared in patchedSkill.inputs.
Return ONLY valid JSON: {"explanation": "...", "patchedSkill": <complete valid SkillDefinition JSON>}.`;

export async function runBlackBoxHealer(
  request: AblationHealRequest,
): Promise<BlackBoxHealOutcome> {
  if (request.failedReport.verdict === "VERIFIED_PASS") {
    return {
      skillId: request.skill.id,
      status: "NOT_APPLICABLE",
      llmCallsUsed: 0,
      promptTokens: 0,
      completionTokens: 0,
      weakenedPostconditions: false,
      explanation: "Skill already passed.",
    };
  }

  const statsBefore = request.llm.getStats();
  const payload = {
    currentSkill: request.skill,
    observedVerdict: request.failedReport.verdict,
    failedSteps: request.failedReport.steps.filter((s) => !s.ok),
    failedPostconditions: request.failedReport.postconditions.filter((p) => !p.passed),
    drift: request.failedReport.drift
      ? {
          failedStepIndex: request.failedReport.drift.failedStepIndex,
          op: request.failedReport.drift.op,
          target: request.failedReport.drift.target,
          currentUrl: request.failedReport.drift.currentUrl,
          errorMessage: request.failedReport.drift.errorMessage,
          interactiveSnapshot: request.failedReport.drift.interactiveSnapshot.slice(0, 45),
        }
      : undefined,
    bugSummary: request.failedReport.bug?.summary,
    httpErrors: request.failedReport.bug?.httpErrors ?? [],
    availableExtraBindings: Object.keys(request.bindings ?? {}),
  };

  const resp = await request.llm.completeJson<BlackBoxPayload>(
    BLACK_BOX_HEALER_PROMPT,
    JSON.stringify(payload),
  );
  const statsAfter = request.llm.getStats();
  const llmCallsUsed = statsAfter.calls - statsBefore.calls;
  const promptTokens = statsAfter.promptTokens - statsBefore.promptTokens;
  const completionTokens = statsAfter.completionTokens - statsBefore.completionTokens;

  if (!resp.data.patchedSkill) {
    return {
      skillId: request.skill.id,
      status: "HEAL_INVALID_SCHEMA",
      llmCallsUsed,
      promptTokens,
      completionTokens,
      weakenedPostconditions: false,
      explanation: resp.data.explanation ?? "Black-box healer returned no patchedSkill.",
    };
  }

  const rawSteps = Array.isArray(resp.data.patchedSkill.steps) ? resp.data.patchedSkill.steps : request.skill.steps;
  const cleanSteps = rawSteps.map((s) => {
    const out: Record<string, unknown> = { op: s.op };
    if (s.url !== undefined) out.url = s.url;
    if (s.value !== undefined) out.value = s.value;
    if (s.pressEnter !== undefined) out.pressEnter = s.pressEnter;
    if (s.expectUrl !== undefined) out.expectUrl = s.expectUrl;
    if (s.note !== undefined) out.note = s.note;
    if (s.target) {
      const t: Record<string, unknown> = { strategy: s.target.strategy, value: s.target.value };
      if (s.target.role !== undefined) t.role = s.target.role;
      if (s.target.exact !== undefined) t.exact = s.target.exact;
      if (s.target.containerText !== undefined) t.containerText = s.target.containerText;
      if (s.target.index !== undefined) t.index = s.target.index;
      out.target = t;
    }
    return out;
  });
  const rawPosts = Array.isArray(resp.data.patchedSkill.postconditions)
    ? resp.data.patchedSkill.postconditions
    : request.skill.postconditions;
  const cleanPosts = rawPosts.map((p) => {
    const out: Record<string, unknown> = { kind: p.kind };
    if (p.method !== undefined) out.method = p.method;
    if (p.path !== undefined) out.path = p.path;
    if (p.expectStatus !== undefined) out.expectStatus = p.expectStatus;
    if (p.maxCount !== undefined) out.maxCount = p.maxCount;
    if (p.pattern !== undefined) out.pattern = p.pattern;
    if (p.text !== undefined) out.text = p.text;
    return out;
  });

  const candidate = {
    schemaVersion: 1 as const,
    id: request.skill.id,
    app: request.skill.app,
    description: resp.data.patchedSkill.description ?? request.skill.description,
    preconditions: request.skill.preconditions,
    produces: request.skill.produces,
    ...(request.skill.clears ? { clears: request.skill.clears } : {}),
    inputs: resp.data.patchedSkill.inputs ?? request.skill.inputs,
    codeRefs: request.skill.codeRefs,
    steps: cleanSteps,
    postconditions: cleanPosts,
  } as unknown as SkillDefinition;

  const weakenedPostconditions =
    candidate.postconditions.length < request.skill.postconditions.length ||
    JSON.stringify(candidate.postconditions) !== JSON.stringify(request.skill.postconditions) ||
    request.skill.steps.some((s) => s.op === "ASSERT_TEXT" || Boolean(s.expectUrl)) &&
      !candidate.steps.some((s) => s.op === "ASSERT_TEXT" || Boolean(s.expectUrl));

  const validator = createSkillValidator(request.schemaPath ?? resolveDefaultSchemaPath());
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-heal-val-"));
  try {
    const tmpFile = path.join(tmpDir, `${candidate.id}.yaml`);
    fs.writeFileSync(tmpFile, stringifyYaml(candidate), "utf8");
    const val = validator.validateFile(tmpFile);
    if (!val.skill || val.diagnostics.length > 0) {
      return {
        skillId: request.skill.id,
        status: "HEAL_INVALID_SCHEMA",
        llmCallsUsed,
        promptTokens,
        completionTokens,
        weakenedPostconditions,
        explanation: `Black-box proposal violated schema: ${val.diagnostics.map((d) => d.message).join("; ")}`,
      };
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (request.beforeVerify) {
    await request.beforeVerify();
  }
  const updatedSkills = request.allSkills.map((s) => (s.id === candidate.id ? candidate : s));
  const skillsById = new Map(updatedSkills.map((s) => [s.id, s]));
  try {
    const verifyPlan = planToReach({
      skills: updatedSkills,
      goal: request.verifyGoal,
      ...(request.bindings ? { bindings: request.bindings } : {}),
      ...(request.actorBindings ? { actorBindings: request.actorBindings } : {}),
      ...(request.initialFacts ? { initialFacts: request.initialFacts } : {}),
    });
    const verifyReport = await executePlan(verifyPlan, skillsById, request.executorOptions);
    if (verifyReport.verdict === "VERIFIED_PASS") {
      return {
        skillId: request.skill.id,
        status: "HEALED_AND_VERIFIED",
        llmCallsUsed,
        promptTokens,
        completionTokens,
        weakenedPostconditions,
        explanation: resp.data.explanation ?? "Black-box healed skill passed replay.",
        patchedSkill: candidate,
      };
    }
    return {
      skillId: request.skill.id,
      status: "HEAL_FAILED_VERIFICATION",
      llmCallsUsed,
      promptTokens,
      completionTokens,
      weakenedPostconditions,
      explanation: `Black-box patch failed verification: ${verifyReport.verdict}`,
      patchedSkill: candidate,
    };
  } catch (err) {
    return {
      skillId: request.skill.id,
      status: "HEAL_FAILED_VERIFICATION",
      llmCallsUsed,
      promptTokens,
      completionTokens,
      weakenedPostconditions,
      explanation: `Black-box patch failed planning: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Ablation B: Keeps the deterministic PRODUCT_BUG refusal gate and postcondition non-weakening
 * invariant, but WITHHOLDS repository git diff (`scopedGitDiff: ""`) to isolate the specific
 * contribution of white-box git diff context on SKILL_DRIFT recovery accuracy.
 */
export async function runTelemetryGatedNoDiffHealer(
  request: AblationHealRequest,
): Promise<HealingResult> {
  return healSkillFromDrift({
    skill: request.skill,
    allSkills: request.allSkills,
    failedReport: request.failedReport,
    scopedGitDiff: "",
    llm: request.llm,
    executorOptions: request.executorOptions,
    verifyGoal: request.verifyGoal,
    ...(request.bindings ? { bindings: request.bindings } : {}),
    ...(request.actorBindings ? { actorBindings: request.actorBindings } : {}),
    ...(request.initialFacts ? { initialFacts: request.initialFacts } : {}),
    ...(request.schemaPath ? { schemaPath: request.schemaPath } : {}),
    ...(request.beforeVerify ? { beforeVerify: request.beforeVerify } : {}),
    writeOnVerify: false,
  });
}
