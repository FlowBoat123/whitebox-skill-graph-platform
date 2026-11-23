import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  executePlan,
  healSkillFromDrift,
  LlmClient,
  planToReach,
  type SkillDefinition,
} from "../src/index.js";
import { EVOBENCH_24 } from "../../../benchmarks/skill-graph/evobench-24.js";
import {
  runBlackBoxHealer,
  runTelemetryGatedNoDiffHealer,
} from "../../../benchmarks/skill-graph/healing-ablations.js";
import {
  computeThesisMetrics,
  exportPaperArtifacts,
  type Rq1Receipt,
  type Rq2Receipt,
  type Rq3Receipt,
} from "../../../benchmarks/skill-graph/metrics-exporter.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SCHEMA_PATH = path.join(REPO_ROOT, "contracts/skill-graph/skill.schema.json");

describe("Thesis Benchmark Suite (EvoBench-24, Metrics & Ablations)", () => {
  it("defines exactly 24 unique balanced EvoBench-24 commits across 2 apps", () => {
    expect(EVOBENCH_24).toHaveLength(24);
    const ids = new Set(EVOBENCH_24.map((m) => m.id));
    expect(ids.size).toBe(24);

    expect(EVOBENCH_24.filter((m) => m.app === "cypress-rwa")).toHaveLength(14);
    expect(EVOBENCH_24.filter((m) => m.app === "horilla")).toHaveLength(10);
    expect(EVOBENCH_24.filter((m) => m.category === "SKILL_DRIFT")).toHaveLength(8);
    expect(EVOBENCH_24.filter((m) => m.category === "PRODUCT_BUG")).toHaveLength(10);
    expect(EVOBENCH_24.filter((m) => m.category === "NO_IMPACT")).toHaveLength(6);

    for (const m of EVOBENCH_24) {
      expect(m.targetFile.startsWith("/")).toBe(false);
      expect(m.targetFile.includes("..")).toBe(false);
      if (m.category === "NO_IMPACT") {
        expect(m.expectedImpactedSkills).toEqual([]);
      } else {
        expect(m.expectedImpactedSkills.length).toBeGreaterThan(0);
        expect(m.primarySkillId).toBeTruthy();
        expect(m.verifyGoal).toBeTruthy();
      }
    }
  });

  it("computes deterministic RQ1-RQ4 metrics and exports CSV, Markdown, and IEEE LaTeX tables", () => {
    const rq1: Rq1Receipt = {
      version: 1,
      app: "cypress-rwa",
      timestamp: "2026-11-23T00:00:00.000Z",
      model: "deepseek/deepseek-v3.2",
      skillGraphRuns: [
        {
          taskId: "t1",
          app: "cypress-rwa",
          runIndex: 1,
          stepsExecuted: ["auth.signin", "bank.create"],
          verdict: "VERIFIED_PASS",
          durationMs: 3500,
          llmCallsUsed: 0,
        },
      ],
      pureLlmRuns: [
        {
          taskId: "t1",
          app: "cypress-rwa",
          runIndex: 1,
          verdict: "VERIFIED_PASS",
          durationMs: 18000,
          llmCallsUsed: 8,
          promptTokens: 8000,
          completionTokens: 800,
          stepsAttempted: 7,
          stepsSucceeded: 7,
          postconditions: [],
        },
      ],
    };

    const rq2: Rq2Receipt = {
      version: 1,
      app: "cypress-rwa",
      timestamp: "2026-11-23T00:00:00.000Z",
      model: "deepseek/deepseek-v3.2",
      commits: [
        {
          id: "RWA-D1",
          app: "cypress-rwa",
          category: "SKILL_DRIFT",
          title: "Rename Save",
          targetFile: "src/components/BankAccountForm.tsx",
          totalAppSkills: 8,
          expectedImpactedSkills: ["bank.create"],
          actualImpactedSkills: ["bank.create"],
          impactExactMatch: true,
          staticVerdict: "SKILL_DRIFT",
          staticDurationMs: 2000,
          whiteBox: {
            verdict: "SKILL_DRIFT",
            healStatus: "HEALED_AND_VERIFIED",
            llmCallsUsed: 1,
            promptTokens: 1200,
            completionTokens: 500,
            postHealZeroLlmPass: true,
          },
          blackBoxAblation: {
            status: "HEALED_AND_VERIFIED",
            llmCallsUsed: 1,
            promptTokens: 1000,
            completionTokens: 500,
            weakenedPostconditions: false,
            falseHeal: false,
            driftRecovered: true,
          },
          noDiffAblation: {
            status: "HEALED_AND_VERIFIED",
            llmCallsUsed: 1,
            promptTokens: 1000,
            completionTokens: 500,
            falseHeal: false,
            driftRecovered: true,
          },
        },
        {
          id: "RWA-B1",
          app: "cypress-rwa",
          category: "PRODUCT_BUG",
          title: "Swallowed click",
          targetFile: "src/components/TransactionDetail.tsx",
          totalAppSkills: 8,
          expectedImpactedSkills: ["tx.respond_request"],
          actualImpactedSkills: ["tx.respond_request"],
          impactExactMatch: true,
          staticVerdict: "PRODUCT_BUG",
          staticDurationMs: 3000,
          whiteBox: {
            verdict: "PRODUCT_BUG",
            healStatus: "REFUSED_PRODUCT_BUG",
            llmCallsUsed: 0,
            promptTokens: 0,
            completionTokens: 0,
            postHealZeroLlmPass: null,
            bugDraftId: "BUG-CYPRESSRWA-SG-TEST",
            bugDraftOrigin: "OBSERVED_DETERMINISTIC",
            bugDraftStatus: "DRAFT",
          },
          blackBoxAblation: {
            status: "HEALED_AND_VERIFIED",
            llmCallsUsed: 1,
            promptTokens: 1100,
            completionTokens: 450,
            weakenedPostconditions: true,
            falseHeal: true,
            driftRecovered: false,
          },
          noDiffAblation: {
            status: "REFUSED_PRODUCT_BUG",
            llmCallsUsed: 0,
            promptTokens: 0,
            completionTokens: 0,
            falseHeal: false,
            driftRecovered: false,
          },
        },
        {
          id: "RWA-N1",
          app: "cypress-rwa",
          category: "NO_IMPACT",
          title: "README edit",
          targetFile: "README.md",
          totalAppSkills: 8,
          expectedImpactedSkills: [],
          actualImpactedSkills: [],
          impactExactMatch: true,
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
        },
      ],
    };

    const rq3: Rq3Receipt = {
      version: 1,
      app: "cypress-rwa",
      timestamp: "2026-11-23T00:00:00.000Z",
      model: "deepseek/deepseek-v3.2",
      trials: [
        {
          skillId: "tx.comment",
          app: "cypress-rwa",
          description: "Comment on tx",
          withGate: {
            status: "AUTHORED_AND_VERIFIED",
            authorLlmCalls: 6,
            promptTokens: 6000,
            completionTokens: 900,
            replayLlmCalls: 0,
            replayVerdict: "VERIFIED_PASS",
            discoveredSourceFiles: ["src/components/CommentForm.tsx"],
          },
          withoutGate: {
            authorLlmCalls: 6,
            promptTokens: 6000,
            completionTokens: 900,
            freshDataReplayVerdict: "SKILL_DRIFT",
            overfitCaughtByGate: true,
          },
        },
      ],
    };

    const metrics = computeThesisMetrics({
      rq1Receipts: [rq1],
      rq2Receipts: [rq2],
      rq3Receipts: [rq3],
    });
    expect(metrics.rq2.classificationAccuracyPct).toBe(100);
    expect(metrics.rq2.macroF1Pct).toBe(100);
    expect(metrics.rq2.impactSelectionPrecisionPct).toBe(100);
    expect(metrics.rq2.impactSelectionRecallPct).toBe(100);
    expect(metrics.rq2.impactTestReductionPct).toBe(91.67);
    expect(metrics.rq2.systemComparison.find((s) => s.system.includes("Black-Box"))?.falseHealingRatePct).toBe(100);
    expect(metrics.rq2.systemComparison.find((s) => s.system.includes("White-Box"))?.falseHealingRatePct).toBe(0);
    expect(metrics.rq4.bugDraftCoveragePct).toBe(100);
    expect(metrics.rq4.allDraftsDeterministic).toBe(true);

    const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "thesis-export-"));
    try {
      exportPaperArtifacts(tmpOut, { rq1Receipts: [rq1], rq2Receipts: [rq2], rq3Receipts: [rq3] });
      const tex = fs.readFileSync(path.join(tmpOut, "paper-tables.tex"), "utf8");
      const md = fs.readFileSync(path.join(tmpOut, "paper-tables.md"), "utf8");
      expect(tex).toContain("\\toprule");
      expect(tex).toContain("\\label{tab:rq2-evobench}");
      expect(tex).not.toContain("NaN");
      expect(md).toContain("Table II");
      expect(fs.existsSync(path.join(tmpOut, "rq1-amortization.csv"))).toBe(true);
      expect(fs.existsSync(path.join(tmpOut, "rq2-evobench24-results.csv"))).toBe(true);
    } finally {
      fs.rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  it(
    "demonstrates offline that Black-Box healer can mask a silent PRODUCT_BUG while White-Box & No-Diff refuse with 0 LLM calls",
    async () => {
      const server = http.createServer((req, res) => {
        if (req.url === "/favicon.ico") {
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method === "GET" && req.url === "/dept") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><html><body>
            <h1>Departments</h1>
            <form id="f"><input placeholder="Department" /><button type="submit">Save</button></form>
            <div id="list"></div>
            <script>
              document.getElementById('f').addEventListener('submit', async (e) => {
                e.preventDefault();
                await fetch('/api/dept', { method: 'POST' });
                // Silent bug: never renders saved department!
              });
            </script>
          </body></html>`);
          return;
        }
        if (req.method === "POST" && req.url === "/api/dept") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Mock bind failed");
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const deptSkill: SkillDefinition = {
        schemaVersion: 1,
        id: "dept.create",
        app: "mock-app",
        description: "Create a department and verify it appears.",
        preconditions: [],
        produces: [{ name: "dept.exists", params: { department: "{{department}}" } }],
        inputs: { department: { type: "string", required: true } },
        codeRefs: { routes: ["/dept"], endpoints: ["POST /api/dept"], sourceFiles: ["dept.py"] },
        steps: [
          { op: "NAVIGATE", url: "/dept" },
          { op: "FILL", target: { strategy: "placeholder", value: "Department" }, value: "{{department}}" },
          { op: "CLICK", target: { strategy: "role", role: "button", value: "Save" } },
        ],
        postconditions: [
          { kind: "HTTP_STATUS", method: "POST", path: "/api/dept", expectStatus: 200 },
          { kind: "DOM_CONTAINS", text: "{{department}}" },
          { kind: "CONSOLE_ERRORS", maxCount: 0 },
        ],
      };

      try {
        const goal = { name: "dept.exists", params: { department: "Silent Bug Dept" } };
        const plan = planToReach({ skills: [deptSkill], goal });
        const execRep = await executePlan(plan, new Map([[deptSkill.id, deptSkill]]), {
          baseUrl,
          stepTimeoutMs: 2500,
        });
        expect(execRep.verdict).toBe("PRODUCT_BUG");
        const failed = execRep.skillReports[0]!;

        // Mock LLM that obeys the Black-Box prompt by dropping DOM_CONTAINS so the failing test turns green!
        const weakenedSkill: SkillDefinition = {
          ...deptSkill,
          postconditions: [
            { kind: "HTTP_STATUS", method: "POST", path: "/api/dept", expectStatus: 200 },
            { kind: "CONSOLE_ERRORS", maxCount: 0 },
          ],
        };
        const mockLlm = new LlmClient({
          endpoint: "http://127.0.0.1:9999/mock",
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        explanation: "Removed DOM_CONTAINS because page does not display department text.",
                        patchedSkill: weakenedSkill,
                      }),
                    },
                  },
                ],
                usage: { prompt_tokens: 500, completion_tokens: 200 },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
        });

        // White-Box & Telemetry-Gated No-Diff MUST refuse with 0 LLM calls!
        const wbRes = await healSkillFromDrift({
          skill: deptSkill,
          allSkills: [deptSkill],
          failedReport: failed,
          scopedGitDiff: "- form.save()",
          llm: mockLlm,
          executorOptions: { baseUrl, stepTimeoutMs: 2500 },
          verifyGoal: goal,
          schemaPath: SCHEMA_PATH,
        });
        expect(wbRes.status).toBe("REFUSED_PRODUCT_BUG");
        expect(wbRes.llmCallsUsed).toBe(0);

        const ndRes = await runTelemetryGatedNoDiffHealer({
          skill: deptSkill,
          allSkills: [deptSkill],
          failedReport: failed,
          llm: mockLlm,
          executorOptions: { baseUrl, stepTimeoutMs: 2500 },
          verifyGoal: goal,
          schemaPath: SCHEMA_PATH,
        });
        expect(ndRes.status).toBe("REFUSED_PRODUCT_BUG");
        expect(ndRes.llmCallsUsed).toBe(0);

        // Black-Box healer masks the real PRODUCT_BUG into a fake VERIFIED_PASS (False Heal)!
        const bbRes = await runBlackBoxHealer({
          skill: deptSkill,
          allSkills: [deptSkill],
          failedReport: failed,
          llm: mockLlm,
          executorOptions: { baseUrl, stepTimeoutMs: 2500 },
          verifyGoal: goal,
          schemaPath: SCHEMA_PATH,
        });
        expect(bbRes.status).toBe("HEALED_AND_VERIFIED");
        expect(bbRes.weakenedPostconditions).toBe(true);
        expect(bbRes.llmCallsUsed).toBe(1);
      } finally {
        server.close();
      }
    },
    30000,
  );
});
