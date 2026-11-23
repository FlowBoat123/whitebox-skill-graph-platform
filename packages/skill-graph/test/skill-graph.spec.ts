import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createSkillValidator,
  executePlan,
  planToReach,
  PlanningError,
  selectImpactedSkills,
  type SkillDefinition,
} from "../src/index.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SCHEMA_PATH = path.join(REPO_ROOT, "contracts/skill-graph/skill.schema.json");
const FIXTURES_DIR = path.join(REPO_ROOT, "contracts/skill-graph/fixtures");
const CYPRESS_SKILLS_DIR = path.join(REPO_ROOT, "skills/cypress-rwa");
const HORILLA_SKILLS_DIR = path.join(REPO_ROOT, "skills/horilla");

describe("White-Box Skill Graph Schema & Validator", () => {
  const validator = createSkillValidator(SCHEMA_PATH);

  it("accepts positive fixture and all 12 project skills (cypress-rwa + horilla) deterministically", () => {
    const pos = validator.validateFile(path.join(FIXTURES_DIR, "positive/valid-skill.yaml"));
    expect(pos.diagnostics).toEqual([]);
    expect(pos.skill?.id).toBe("bank.create");

    const posTitle = validator.validateFile(
      path.join(FIXTURES_DIR, "positive/valid-title-skill.yaml"),
    );
    expect(posTitle.diagnostics).toEqual([]);
    expect(posTitle.skill?.id).toBe("department.delete");

    const dirRes1 = validator.validateDirectory(CYPRESS_SKILLS_DIR);
    const dirRes2 = validator.validateDirectory(CYPRESS_SKILLS_DIR);
    expect(dirRes1.valid).toBe(true);
    expect(dirRes1.skills.map((s) => s.skill.id)).toEqual([
      "auth.signin",
      "auth.signout",
      "bank.create",
      "bank.delete",
      "tx.comment",
      "tx.create_payment",
      "tx.create_request",
      "tx.respond_request",
    ]);
    expect(dirRes1).toEqual(dirRes2);

    const horillaRes1 = validator.validateDirectory(HORILLA_SKILLS_DIR);
    const horillaRes2 = validator.validateDirectory(HORILLA_SKILLS_DIR);
    expect(horillaRes1.valid).toBe(true);
    expect(horillaRes1.skills.map((s) => s.skill.id)).toEqual([
      "auth.login",
      "department.create",
      "department.search",
      "employee_type.create",
    ]);
    expect(horillaRes1).toEqual(horillaRes2);
  });

  it("rejects all negative fixtures (missing postconditions, invalid op enum, undeclared template var)", () => {
    const missingPost = validator.validateFile(
      path.join(FIXTURES_DIR, "negative/missing-postconditions.yaml"),
    );
    expect(missingPost.skill).toBeUndefined();
    expect(missingPost.diagnostics.some((d) => d.path === "/postconditions")).toBe(true);

    const badOp = validator.validateFile(
      path.join(FIXTURES_DIR, "negative/invalid-op-enum.yaml"),
    );
    expect(badOp.skill).toBeUndefined();
    expect(badOp.diagnostics.some((d) => d.code === "SCHEMA_ENUM")).toBe(true);

    const undeclared = validator.validateFile(
      path.join(FIXTURES_DIR, "negative/undeclared-template-var.yaml"),
    );
    expect(undeclared.skill).toBeUndefined();
    expect(undeclared.diagnostics.some((d) => d.code === "UNDECLARED_TEMPLATE_VARIABLE")).toBe(
      true,
    );

    const emptyTitle = validator.validateFile(
      path.join(FIXTURES_DIR, "negative/invalid-title-empty.yaml"),
    );
    expect(emptyTitle.skill).toBeUndefined();
    expect(emptyTitle.diagnostics.some((d) => d.code === "SCHEMA_MINLENGTH")).toBe(true);
  });
});

describe("Symbolic Precondition SkillPlanner (0-LLM)", () => {
  const validator = createSkillValidator(SCHEMA_PATH);
  const loaded = validator.validateDirectory(CYPRESS_SKILLS_DIR);
  const skills = loaded.skills.map((s) => s.skill);

  it("auto-composes a 3-skill single-user chain (signin -> bank.create -> bank.delete)", () => {
    const plan = planToReach({
      skills,
      goal: {
        name: "bank.deleted",
        params: { user: "Heath93", bankName: "Atlas Test Bank" },
      },
      bindings: {
        password: "demo-password",
        routingNumber: "987654321",
        accountNumber: "1234567890",
      },
    });

    expect(plan.llmCallsUsed).toBe(0);
    expect(plan.steps.map((s) => s.skillId)).toEqual([
      "auth.signin",
      "bank.create",
      "bank.delete",
    ]);
    expect(plan.steps[0]!.params.username).toBe("Heath93");
    expect(plan.steps[1]!.params.bankName).toBe("Atlas Test Bank");
  });

  it("auto-composes a 5-skill multi-user workflow with automatic auth.signout user switch", () => {
    const plan = planToReach({
      skills,
      goal: {
        name: "tx.resolved",
        params: {
          sender: "Heath93",
          receiver: "Arvilla_Hegmann",
          note: "Sprint lunch split",
          decisionLabel: "Accept Request",
        },
      },
      bindings: {
        receiverName: "Kristian Bradtke",
        amount: "45",
      },
      actorBindings: {
        Heath93: { password: "pw-a" },
        Arvilla_Hegmann: { password: "pw-b" },
      },
    });

    expect(plan.llmCallsUsed).toBe(0);
    expect(plan.steps.map((s) => s.skillId)).toEqual([
      "auth.signin",
      "tx.create_request",
      "auth.signout",
      "auth.signin",
      "tx.respond_request",
    ]);
    expect(plan.steps[0]!.params).toEqual({ username: "Heath93", password: "pw-a" });
    expect(plan.steps[3]!.params).toEqual({ username: "Arvilla_Hegmann", password: "pw-b" });
    expect(plan.steps[4]!.params.decisionLabel).toBe("Accept Request");
  });

  it("auto-composes a 3-skill Horilla HRMS workflow with 0 LLM calls", () => {
    const horillaLoaded = validator.validateDirectory(HORILLA_SKILLS_DIR);
    const horillaSkills = horillaLoaded.skills.map((s) => s.skill);
    const plan = planToReach({
      skills: horillaSkills,
      goal: {
        name: "department.filtered",
        params: { department: "Platform QA Ops" },
      },
      bindings: {
        user: "hr_admin",
        username: "hr_admin",
        password: "demo-password",
      },
    });

    expect(plan.llmCallsUsed).toBe(0);
    expect(plan.steps.map((s) => s.skillId)).toEqual([
      "auth.login",
      "department.create",
      "department.search",
    ]);
    expect(plan.steps[0]!.params.username).toBe("hr_admin");
    expect(plan.steps[1]!.params.department).toBe("Platform QA Ops");
    expect(plan.steps[2]!.params.department).toBe("Platform QA Ops");
  });

  it("rejects unachievable goals or missing required inputs deterministically", () => {
    expect(() =>
      planToReach({
        skills,
        goal: { name: "tx.resolved", params: { note: "Missing params" } },
      }),
    ).toThrow(PlanningError);
  });
});

describe("White-Box git-diff Impact Selector", () => {
  const validator = createSkillValidator(SCHEMA_PATH);
  const loaded = validator.validateDirectory(CYPRESS_SKILLS_DIR);

  it("selects only skills touching modified sourceFiles and extracts scoped diff hunks", () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "skill-impact-test-"));
    try {
      const run = (args: string[]) => execFileSync("git", ["-C", tmpRepo, ...args], { stdio: "pipe" });
      run(["init"]);
      run(["config", "user.email", "test@example.local"]);
      run(["config", "user.name", "Test User"]);

      fs.mkdirSync(path.join(tmpRepo, "src/components"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpRepo, "src/components/BankAccountForm.tsx"),
        "export const label = 'Save';\n",
      );
      fs.writeFileSync(path.join(tmpRepo, "README.md"), "# Demo\n");
      run(["add", "."]);
      run(["commit", "-m", "initial"]);

      // Unrelated README edit selects 0 skills
      fs.writeFileSync(path.join(tmpRepo, "README.md"), "# Demo updated\n");
      const noneAffected = selectImpactedSkills(loaded.skills, tmpRepo, "HEAD");
      expect(noneAffected.changedFiles).toEqual(["README.md"]);
      expect(noneAffected.affectedSkills).toEqual([]);

      // UI change in BankAccountForm.tsx selects ONLY bank.create with exact diff hunk
      fs.writeFileSync(
        path.join(tmpRepo, "src/components/BankAccountForm.tsx"),
        "export const label = 'Save Bank Account';\n",
      );
      const impacted = selectImpactedSkills(loaded.skills, tmpRepo, "HEAD");
      expect(impacted.affectedSkills.map((a) => a.skillId)).toEqual(["bank.create"]);
      expect(impacted.scopedDiffBySkill["bank.create"]).toContain("Save Bank Account");
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});

describe("Playwright SkillExecutor & TelemetryVerifier (VERIFIED_PASS vs SKILL_DRIFT vs PRODUCT_BUG)", () => {
  it(
    "classifies VERIFIED_PASS, SKILL_DRIFT, PRODUCT_BUG (500 / missing DOM / crash hiding control) accurately",
    async () => {
      let mode: "OK" | "UI_DRIFT" | "SERVER_500" | "SILENT_BUG" | "CRASH_HIDES_NEXT" = "OK";
      const items: string[] = [];

      const server = http.createServer((req, res) => {
        if (req.url === "/favicon.ico") {
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method === "GET" && req.url === "/items") {
          const btnLabel = mode === "UI_DRIFT" ? "Create Record" : "Save";
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><html><body>
            <h1>Items</h1>
            <form id="f">
              <input placeholder="Item Name" id="name" />
              <button type="submit">${btnLabel}</button>
            </form>
            <ul id="list">${items.map((x) => `<li>${x}</li>`).join("")}</ul>
            <div id="after"></div>
            <script>
              document.getElementById('f').addEventListener('submit', async (e) => {
                e.preventDefault();
                const name = document.getElementById('name').value;
                const r = await fetch('/api/items', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
                if (r.ok) {
                  const data = await r.json();
                  if (data.rendered) {
                    const li = document.createElement('li'); li.textContent = name;
                    document.getElementById('list').appendChild(li);
                  }
                  const next = document.createElement('button'); next.textContent = 'Continue';
                  document.getElementById('after').appendChild(next);
                }
              });
            </script>
          </body></html>`);
          return;
        }
        if (req.method === "POST" && req.url === "/api/items") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            if (mode === "SERVER_500" || mode === "CRASH_HIDES_NEXT") {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Database write failed" }));
              return;
            }
            const parsed = JSON.parse(body || "{}") as { name?: string };
            if (mode === "OK" && parsed.name) {
              items.push(parsed.name);
            }
            res.writeHead(201, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, rendered: mode === "OK" }));
          });
          return;
        }
        res.writeHead(404);
        res.end("Not found");
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Failed to bind mock server");
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const createItemSkill: SkillDefinition = {
        schemaVersion: 1,
        id: "item.create",
        app: "mock-app",
        description: "Create an item via form and verify 201 + DOM.",
        preconditions: [],
        produces: [{ name: "item.exists", params: { name: "{{name}}" } }],
        inputs: { name: { type: "string", required: true } },
        codeRefs: {
          routes: ["/items"],
          endpoints: ["POST /api/items"],
          sourceFiles: ["src/items.tsx"],
        },
        steps: [
          { op: "NAVIGATE", url: "/items" },
          { op: "FILL", target: { strategy: "placeholder", value: "Item Name" }, value: "{{name}}" },
          { op: "CLICK", target: { strategy: "role", role: "button", value: "Save" } },
          { op: "CLICK", target: { strategy: "role", role: "button", value: "Continue" } },
        ],
        postconditions: [
          { kind: "HTTP_STATUS", method: "POST", path: "/api/items", expectStatus: 201 },
          { kind: "CONSOLE_ERRORS", maxCount: 0 },
          { kind: "PAGE_ERRORS", maxCount: 0 },
          { kind: "DOM_CONTAINS", text: "{{name}}" },
        ],
      };

      const skillsById = new Map([[createItemSkill.id, createItemSkill]]);
      const plan = planToReach({
        skills: [createItemSkill],
        goal: { name: "item.exists", params: { name: "Alpha Widget" } },
      });

      try {
        // 1. Clean run -> VERIFIED_PASS
        mode = "OK";
        const passRes = await executePlan(plan, skillsById, { baseUrl, stepTimeoutMs: 2500 });
        expect(passRes.verdict).toBe("VERIFIED_PASS");
        expect(passRes.llmCallsUsed).toBe(0);

        // 2. UI renamed "Save" -> "Create Record" (no server crash) -> SKILL_DRIFT
        mode = "UI_DRIFT";
        const driftRes = await executePlan(plan, skillsById, { baseUrl, stepTimeoutMs: 1800 });
        expect(driftRes.verdict).toBe("SKILL_DRIFT");
        expect(driftRes.skillReports[0]?.drift?.failedStepIndex).toBe(2);
        expect(
          driftRes.skillReports[0]?.drift?.interactiveSnapshot.some((line) =>
            line.includes("Create Record"),
          ),
        ).toBe(true);

        // 3. Server 500 prevents "Continue" button from rendering -> MUST be PRODUCT_BUG, NOT SKILL_DRIFT!
        mode = "CRASH_HIDES_NEXT";
        const crashRes = await executePlan(plan, skillsById, { baseUrl, stepTimeoutMs: 1800 });
        expect(crashRes.verdict).toBe("PRODUCT_BUG");
        expect(crashRes.skillReports[0]?.bug?.httpErrors.some((e) => e.status === 500)).toBe(true);

        // 4. Silent UI logic bug (HTTP 201 ok, button Continue appears, but item never rendered) -> PRODUCT_BUG
        mode = "SILENT_BUG";
        items.length = 0;
        const silentRes = await executePlan(plan, skillsById, { baseUrl, stepTimeoutMs: 2500 });
        expect(silentRes.verdict).toBe("PRODUCT_BUG");
        expect(
          silentRes.skillReports[0]?.bug?.failedPostconditions.some(
            (p) => p.kind === "DOM_CONTAINS",
          ),
        ).toBe(true);

        // 5. Action succeeds (Save button clicked) but expectUrl never transitions -> MUST be PRODUCT_BUG, NOT SKILL_DRIFT
        mode = "OK";
        const expectUrlSkill: SkillDefinition = {
          ...createItemSkill,
          id: "item.create_redirect",
          steps: [
            { op: "NAVIGATE", url: "/items" },
            { op: "FILL", target: { strategy: "placeholder", value: "Item Name" }, value: "{{name}}" },
            {
              op: "CLICK",
              target: { strategy: "role", role: "button", value: "Save" },
              expectUrl: "/items/created$",
            },
          ],
        };
        const redirectPlan = planToReach({
          skills: [expectUrlSkill],
          goal: { name: "item.exists", params: { name: "Beta Widget" } },
        });
        const stuckRes = await executePlan(
          redirectPlan,
          new Map([[expectUrlSkill.id, expectUrlSkill]]),
          { baseUrl, stepTimeoutMs: 1200 },
        );
        expect(stuckRes.verdict).toBe("PRODUCT_BUG");
        expect(stuckRes.skillReports[0]?.bug?.summary).toContain("Post-action expectation failed");
      } finally {
        server.close();
      }
    },
    60000,
  );

  it(
    "executes icon-only controls using strategy='title' scoped by containerText",
    async () => {
      let deletedRow = "";
      const server = http.createServer((req, res) => {
        if (req.url === "/favicon.ico") {
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method === "GET" && req.url === "/rows") {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><html><body>
            <table>
              <tr id="r1"><td>Alpha Dept</td><td><a title="Delete" style="cursor:pointer" onclick="del('Alpha Dept')"><span>X</span></a></td></tr>
              <tr id="r2"><td>Beta Dept</td><td><a title="Delete" style="cursor:pointer" onclick="del('Beta Dept')"><span>X</span></a></td></tr>
            </table>
            <div id="status"></div>
            <script>
              async function del(name) {
                const r = await fetch('/api/delete', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
                if (r.ok) {
                  document.getElementById('status').textContent = 'Deleted ' + name;
                }
              }
            </script>
          </body></html>`);
          return;
        }
        if (req.method === "POST" && req.url === "/api/delete") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => {
            deletedRow = (JSON.parse(body || "{}") as { name?: string }).name ?? "";
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ deleted: deletedRow }));
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Failed to bind mock server");
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const delSkill: SkillDefinition = {
        schemaVersion: 1,
        id: "row.delete",
        app: "mock-app",
        description: "Delete a specific row via title locator.",
        preconditions: [],
        produces: [{ name: "row.deleted", params: { rowName: "{{rowName}}" } }],
        inputs: { rowName: { type: "string", required: true } },
        codeRefs: { routes: ["/rows"], endpoints: ["POST /api/delete"], sourceFiles: ["rows.html"] },
        steps: [
          { op: "NAVIGATE", url: "/rows" },
          {
            op: "CLICK",
            target: {
              strategy: "title",
              value: "Delete",
              exact: true,
              containerText: "{{rowName}}",
            },
          },
          {
            op: "ASSERT_TEXT",
            target: { strategy: "text", value: "Deleted {{rowName}}" },
            value: "Deleted {{rowName}}",
          },
        ],
        postconditions: [
          { kind: "HTTP_STATUS", method: "POST", path: "/api/delete", expectStatus: 200 },
          { kind: "DOM_CONTAINS", text: "Deleted {{rowName}}" },
          { kind: "CONSOLE_ERRORS", maxCount: 0 },
          { kind: "PAGE_ERRORS", maxCount: 0 },
        ],
      };

      try {
        const plan = planToReach({
          skills: [delSkill],
          goal: { name: "row.deleted", params: { rowName: "Beta Dept" } },
        });
        const rep = await executePlan(plan, new Map([[delSkill.id, delSkill]]), {
          baseUrl,
          stepTimeoutMs: 2500,
        });
        expect(rep.verdict).toBe("VERIFIED_PASS");
        expect(deletedRow).toBe("Beta Dept");
      } finally {
        server.close();
      }
    },
    20000,
  );
});
