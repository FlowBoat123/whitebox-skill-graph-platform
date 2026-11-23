import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachRegressionPostcondition,
  authorNewSkill,
  buildBugDraftFromEvidence,
  executePlan,
  healSkillFromDrift,
  LlmClient,
  planToReach,
  writeBugDraft,
  type SkillDefinition,
  type SkillExecutionReport,
} from "../src/index.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SCHEMA_PATH = path.join(REPO_ROOT, "contracts/skill-graph/skill.schema.json");

function createMockLlm(replies: Array<Record<string, unknown>>): {
  llm: LlmClient;
  receivedPrompts: string[];
} {
  let idx = 0;
  const receivedPrompts: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<{ content?: string }>;
    };
    receivedPrompts.push(body.messages?.[1]?.content ?? "");
    const reply = replies[Math.min(idx++, replies.length - 1)]!;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(reply) } }],
        usage: { prompt_tokens: 120, completion_tokens: 60 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  return {
    llm: new LlmClient({
      endpoint: "http://127.0.0.1:9999/v1/chat/completions",
      model: "mock-teacher",
      fetchImpl,
    }),
    receivedPrompts,
  };
}

describe("Chặng 2 & 3: White-Box Healer, Author & Knowledge Graph Bridge", () => {
  const baseSkill: SkillDefinition = {
    schemaVersion: 1,
    id: "item.create",
    app: "mock-app",
    description: "Create an item in the mock app.",
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
    ],
    postconditions: [
      { kind: "HTTP_STATUS", method: "POST", path: "/api/items", expectStatus: 201 },
      { kind: "CONSOLE_ERRORS", maxCount: 0 },
      { kind: "DOM_CONTAINS", text: "{{name}}" },
    ],
  };

  it("hard-refuses healing on PRODUCT_BUG with 0 LLM calls and exports deterministic DRAFT bug record", () => {
    const { llm } = createMockLlm([]);
    const bugReport: SkillExecutionReport = {
      skillId: "item.create",
      verdict: "PRODUCT_BUG",
      durationMs: 500,
      llmCallsUsed: 0,
      steps: [],
      postconditions: [
        { kind: "HTTP_STATUS", passed: false, detail: "Expected POST /api/items -> 201, observed 500" },
      ],
      httpEvents: [{ method: "POST", path: "/api/items", status: 500, timestampMs: 100 }],
      consoleErrors: [],
      bug: {
        skillId: "item.create",
        summary: "Expected POST /api/items -> 201, observed 500",
        failedPostconditions: [
          { kind: "HTTP_STATUS", passed: false, detail: "Expected POST /api/items -> 201, observed 500" },
        ],
        httpErrors: [{ method: "POST", path: "/api/items", status: 500, timestampMs: 100 }],
        consoleErrors: [],
        currentUrl: "http://127.0.0.1:4000/items",
        codeRefs: baseSkill.codeRefs,
        origin: "OBSERVED_DETERMINISTIC",
      },
    };

    return healSkillFromDrift({
      skill: baseSkill,
      allSkills: [baseSkill],
      failedReport: bugReport,
      scopedGitDiff: "",
      llm,
      executorOptions: { baseUrl: "http://127.0.0.1:4000" },
      verifyGoal: { name: "item.exists", params: { name: "X" } },
      schemaPath: SCHEMA_PATH,
    }).then((res) => {
      expect(res.status).toBe("REFUSED_PRODUCT_BUG");
      expect(res.llmCallsUsed).toBe(0);
      expect(llm.getStats().calls).toBe(0);

      // Verify Knowledge Graph Draft Bridge
      const draft1 = buildBugDraftFromEvidence("mock-app", bugReport.bug!, {
        detectedAt: "2026-11-22T00:00:00.000Z",
      });
      const draft2 = buildBugDraftFromEvidence("mock-app", bugReport.bug!, {
        detectedAt: "2026-11-22T00:00:00.000Z",
      });
      expect(draft1).toEqual(draft2);
      expect(draft1.status).toBe("DRAFT");
      expect(draft1.origin).toBe("OBSERVED_DETERMINISTIC");
      expect(draft1.draftId).toMatch(/^BUG-MOCKAPP-SG-[A-F0-9]{8}$/);

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bug-draft-"));
      try {
        const written = writeBugDraft(draft1, tmpDir);
        expect(fs.existsSync(written)).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }

      // Attach regression postcondition idempotently
      const withGuard = attachRegressionPostcondition(baseSkill, {
        kind: "PAGE_ERRORS",
        maxCount: 0,
      });
      const withGuardAgain = attachRegressionPostcondition(withGuard, {
        kind: "PAGE_ERRORS",
        maxCount: 0,
      });
      expect(withGuard.postconditions.length).toBe(baseSkill.postconditions.length + 1);
      expect(withGuardAgain.postconditions.length).toBe(withGuard.postconditions.length);
    });
  });

  it("heals SKILL_DRIFT using git diff + live Playwright re-verification, and rejects postcondition weakening", async () => {
    const items: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.url === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && req.url === "/items") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body>
          <form id="f">
            <input placeholder="Item Name" id="name" />
            <input placeholder="Category Code" id="cat" required />
            <button type="submit">Confirm Item</button>
          </form>
          <ul id="list">${items.map((x) => `<li>${x}</li>`).join("")}</ul>
          <script>
            document.getElementById('f').addEventListener('submit', async (e) => {
              e.preventDefault();
              const name = document.getElementById('name').value;
              const cat = document.getElementById('cat').value;
              if (!cat) return;
              const r = await fetch('/api/items', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, cat }) });
              if (r.ok) {
                const li = document.createElement('li'); li.textContent = name + ' (' + cat + ')';
                document.getElementById('list').appendChild(li);
              }
            });
          </script>
        </body></html>`);
        return;
      }
      if (req.method === "POST" && req.url === "/api/items") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const parsed = JSON.parse(body || "{}") as { name?: string; cat?: string };
          if (parsed.name && parsed.cat) items.push(`${parsed.name} (${parsed.cat})`);
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No addr");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      // 1. Original skill hits SKILL_DRIFT on renamed button "Confirm Item"
      const origPlan = planToReach({
        skills: [baseSkill],
        goal: { name: "item.exists", params: { name: "Alpha" } },
      });
      const driftExec = await executePlan(origPlan, new Map([[baseSkill.id, baseSkill]]), {
        baseUrl,
        stepTimeoutMs: 1500,
      });
      expect(driftExec.verdict).toBe("SKILL_DRIFT");

      // 2. Reject LLM patch that tries to weaken/delete postconditions!
      const weakenedSkill = { ...baseSkill, postconditions: [baseSkill.postconditions[0]!] };
      const { llm: badLlm } = createMockLlm([
        { classification: "SKILL_DRIFT", explanation: "Weakened", patchedSkill: weakenedSkill },
      ]);
      const badHeal = await healSkillFromDrift({
        skill: baseSkill,
        allSkills: [baseSkill],
        failedReport: driftExec.skillReports[0]!,
        scopedGitDiff: "- Save\n+ Confirm Item",
        llm: badLlm,
        executorOptions: { baseUrl, stepTimeoutMs: 2500 },
        verifyGoal: { name: "item.exists", params: { name: "Alpha" } },
        schemaPath: SCHEMA_PATH,
      });
      expect(badHeal.status).toBe("HEAL_INVALID_SCHEMA");

      // 3. Valid white-box healed patch (adds Category Code fill + updates Confirm Item button)
      const healedSkill: SkillDefinition = {
        ...baseSkill,
        inputs: {
          name: { type: "string", required: true },
          categoryCode: { type: "string", required: true, default: "CAT-01" },
        },
        steps: [
          { op: "NAVIGATE", url: "/items" },
          { op: "FILL", target: { strategy: "placeholder", value: "Item Name" }, value: "{{name}}" },
          {
            op: "FILL",
            target: { strategy: "placeholder", value: "Category Code" },
            value: "{{categoryCode}}",
          },
          { op: "CLICK", target: { strategy: "role", role: "button", value: "Confirm Item" } },
        ],
      };
      const { llm: goodLlm, receivedPrompts } = createMockLlm([
        {
          classification: "SKILL_DRIFT",
          explanation: "Button renamed to Confirm Item and required Category Code input added.",
          patchedSkill: healedSkill,
        },
      ]);
      const goodHeal = await healSkillFromDrift({
        skill: baseSkill,
        allSkills: [baseSkill],
        failedReport: driftExec.skillReports[0]!,
        scopedGitDiff: "+ <input placeholder=\"Category Code\" required />\n- Save\n+ Confirm Item",
        llm: goodLlm,
        executorOptions: { baseUrl, stepTimeoutMs: 2500 },
        verifyGoal: { name: "item.exists", params: { name: "Alpha" } },
        schemaPath: SCHEMA_PATH,
      });
      expect(goodHeal.status).toBe("HEALED_AND_VERIFIED");
      expect(goodHeal.llmCallsUsed).toBe(1);
      expect(goodHeal.verificationVerdict).toBe("VERIFIED_PASS");
      expect(receivedPrompts[0]).toContain("Confirm Item");
      expect(receivedPrompts[0]).toContain("Category Code");
    } finally {
      server.close();
    }
  }, 60000);

  it("authors a brand-new skill with LLM once, auto-discovers codeRefs, and proves 0-LLM replay on fresh data", async () => {
    const comments: string[] = [];
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "author-repo-"));
    fs.mkdirSync(path.join(tmpRepo, "src/components"), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, "backend"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, "src/components/CommentBox.tsx"),
      '<input placeholder="Write a comment..." />',
    );
    fs.writeFileSync(
      path.join(tmpRepo, "backend/comment-routes.ts"),
      'router.post("/comments", () => {});',
    );

    const server = http.createServer((req, res) => {
      if (req.url === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && req.url === "/post") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body>
          <h1>Post</h1>
          <form id="cf"><input placeholder="Write a comment..." id="c" /></form>
          <ul id="comments">${comments.map((x) => `<li>${x}</li>`).join("")}</ul>
          <script>
            document.getElementById('cf').addEventListener('submit', async (e) => {
              e.preventDefault();
              const text = document.getElementById('c').value;
              const r = await fetch('/comments', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ text }) });
              if (r.ok) {
                const li = document.createElement('li'); li.textContent = text;
                document.getElementById('comments').appendChild(li);
              }
            });
          </script>
        </body></html>`);
        return;
      }
      if (req.method === "POST" && req.url === "/comments") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const parsed = JSON.parse(body || "{}") as { text?: string };
          if (parsed.text) comments.push(parsed.text);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No addr");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const { llm } = createMockLlm([
        { done: false, step: { op: "NAVIGATE", url: "/post" }, reason: "Open post page" },
        {
          done: false,
          step: {
            op: "FILL",
            target: { strategy: "placeholder", value: "Write a comment..." },
            value: "Authoring sample note",
            pressEnter: true,
          },
          reason: "Type comment and press Enter",
        },
        { done: true, reason: "Comment posted" },
      ]);

      const outYaml = path.join(tmpRepo, "skills/post.comment.yaml");
      const authored = await authorNewSkill({
        skillId: "post.comment",
        app: "mock-app",
        description: "Add a comment on a post.",
        goalPrompt: "Open /post and add comment 'Authoring sample note'",
        preconditions: [],
        produces: [{ name: "post.commented", params: { commentText: "{{commentText}}" } }],
        inputs: { commentText: { type: "string", required: true } },
        expectedPostconditions: [
          { kind: "HTTP_STATUS", method: "POST", path: "/comments", expectStatus: 200 },
          { kind: "CONSOLE_ERRORS", maxCount: 0 },
          { kind: "DOM_CONTAINS", text: "{{commentText}}" },
        ],
        authorBindings: { commentText: "Authoring sample note" },
        replayBindings: { commentText: "Brand new 0-LLM replay note" },
        existingSkills: [],
        repoPath: tmpRepo,
        executorOptions: { baseUrl, stepTimeoutMs: 2500 },
        llm,
        schemaPath: SCHEMA_PATH,
        beforeRun: async () => {
          comments.length = 0;
        },
        outputFilePath: outYaml,
      });

      expect(authored.status).toBe("AUTHORED_AND_VERIFIED");
      expect(authored.replayLlmCallsUsed).toBe(0);
      expect(authored.replayVerdict).toBe("VERIFIED_PASS");
      expect(authored.authoredSkill?.steps[1]?.value).toBe("{{commentText}}");
      expect(authored.discoveredSourceFiles).toContain("src/components/CommentBox.tsx");
      expect(authored.discoveredSourceFiles).toContain("backend/comment-routes.ts");
      expect(fs.existsSync(outYaml)).toBe(true);
    } finally {
      server.close();
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  }, 60000);

  it("recovers on Attempt 2 via bounded k<=2 verifier feedback when Attempt 1 fails live replay", async () => {
    const items: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.url === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && req.url === "/items") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body>
          <form id="f">
            <input placeholder="Item Name" id="name" />
            <button type="submit">Commit Record</button>
          </form>
          <ul id="list">${items.map((x) => `<li>${x}</li>`).join("")}</ul>
          <script>
            document.getElementById('f').addEventListener('submit', async (e) => {
              e.preventDefault();
              const name = document.getElementById('name').value;
              const r = await fetch('/api/items', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
              if (r.ok) {
                const li = document.createElement('li'); li.textContent = name;
                document.getElementById('list').appendChild(li);
              }
            });
          </script>
        </body></html>`);
        return;
      }
      if (req.method === "POST" && req.url === "/api/items") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const parsed = JSON.parse(body || "{}") as { name?: string };
          if (parsed.name) items.push(parsed.name);
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No addr");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const plan = planToReach({
        skills: [baseSkill],
        goal: { name: "item.exists", params: { name: "RetryAlpha" } },
      });
      const driftExec = await executePlan(plan, new Map([[baseSkill.id, baseSkill]]), {
        baseUrl,
        stepTimeoutMs: 1500,
      });
      expect(driftExec.verdict).toBe("SKILL_DRIFT");

      const wrongAttempt1: SkillDefinition = {
        ...baseSkill,
        steps: [
          { op: "NAVIGATE", url: "/items" },
          { op: "FILL", target: { strategy: "placeholder", value: "Item Name" }, value: "{{name}}" },
          { op: "CLICK", target: { strategy: "role", role: "button", value: "Wrong Label" } },
        ],
      };
      const fixedAttempt2: SkillDefinition = {
        ...baseSkill,
        steps: [
          { op: "NAVIGATE", url: "/items" },
          { op: "FILL", target: { strategy: "placeholder", value: "Item Name" }, value: "{{name}}" },
          { op: "CLICK", target: { strategy: "role", role: "button", value: "Commit Record" } },
        ],
      };

      const { llm, receivedPrompts } = createMockLlm([
        { classification: "SKILL_DRIFT", explanation: "Guess 1", patchedSkill: wrongAttempt1 },
        { classification: "SKILL_DRIFT", explanation: "Fixed using replay feedback", patchedSkill: fixedAttempt2 },
      ]);

      const healRes = await healSkillFromDrift({
        skill: baseSkill,
        allSkills: [baseSkill],
        failedReport: driftExec.skillReports[0]!,
        scopedGitDiff: "- <button>Save</button>\n+ <button>Commit Record</button>",
        llm,
        executorOptions: { baseUrl, stepTimeoutMs: 2000 },
        verifyGoal: { name: "item.exists", params: { name: "RetryAlpha" } },
        schemaPath: SCHEMA_PATH,
        maxAttempts: 2,
      });

      expect(healRes.status).toBe("HEALED_AND_VERIFIED");
      expect(healRes.llmCallsUsed).toBe(2);
      expect(healRes.attemptsUsed).toBe(2);
      expect(healRes.attemptHistory?.map((a) => a.status)).toEqual([
        "HEAL_REJECTED_BY_VERIFIER",
        "HEALED_AND_VERIFIED",
      ]);
      expect(receivedPrompts[1]).toContain("previousAttemptFeedback");
      expect(receivedPrompts[1]).toContain("Wrong Label");
    } finally {
      server.close();
    }
  }, 60000);

  it("prioritizes active modal controls above 60 sidebar links during multi-stage authoring", async () => {
    let rows = ["Alpha Row", "Beta Row"];
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "modal-author-repo-"));
    fs.writeFileSync(path.join(tmpRepo, "delete.html"), "Confirm Delete");

    const server = http.createServer((req, res) => {
      if (req.url === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && req.url === "/depts") {
        const navLinks = Array.from({ length: 60 }, (_, idx) => `<a href="/nav/${idx}">Sidebar Item ${idx}</a>`).join("");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body>
          <div id="tourBackdrop" class="driver-overlay" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.2)">
            <div class="driver-popover"><button class="driver-popover-close-btn" onclick="document.getElementById('tourBackdrop').remove()">×</button></div>
          </div>
          <button style="display:none">Confirm Delete</button>
          <nav>${navLinks}</nav>
          <div id="toast" style="visibility:hidden"></div>
          <ul id="rows">${rows.map((r) => `<li><span>${r}</span> <a title="Delete" style="cursor:pointer" onclick="openModal('${r}')">X</a></li>`).join("")}</ul>
          <div id="delModal" class="oh-modal" role="dialog" aria-labelledby="delModal" aria-hidden="true" style="display:none">
            <div id="delModalBody"></div>
          </div>
          <script>
            let target = '';
            function openModal(name) {
              target = name;
              const m = document.getElementById('delModal');
              m.classList.add('oh-modal--show');
              m.style.display = 'block';
              // Simulate async HTMX fragment hydration (empty modal body for 350ms)
              document.getElementById('delModalBody').innerHTML = '';
              setTimeout(() => {
                document.getElementById('delModalBody').innerHTML =
                  '<input type="checkbox" id="c1" onchange="syncBtn()" /><label for="c1">Acknowledge step 1</label>' +
                  '<input type="checkbox" id="c2" onchange="syncBtn()" /><label for="c2">Acknowledge step 2</label>' +
                  '<button id="confirmDel" disabled onclick="doDel()">Confirm Delete</button>';
              }, 350);
            }
            function syncBtn() {
              document.getElementById('confirmDel').disabled = !(document.getElementById('c1').checked && document.getElementById('c2').checked);
            }
            async function doDel() {
              const r = await fetch('/api/delete', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name: target }) });
              if (r.ok) {
                document.getElementById('delModal').style.display = 'none';
                document.getElementById('delModal').classList.remove('oh-modal--show');
                const toast = document.getElementById('toast');
                toast.textContent = 'Deleted ' + target;
                toast.style.visibility = 'visible';
                // Simulate async list reload + transient toast fade-out
                setTimeout(() => {
                  Array.from(document.querySelectorAll('#rows li')).forEach((li) => { if (li.textContent.includes(target)) li.remove(); });
                  toast.style.visibility = 'hidden';
                }, 600);
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
          const parsed = JSON.parse(body || "{}") as { name?: string };
          rows = rows.filter((x) => x !== parsed.name);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("No addr");
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const { llm, receivedPrompts } = createMockLlm([
        { done: false, step: { op: "NAVIGATE", url: "/depts", value: null, target: null } },
        { done: false, step: { op: "CLICK", value: null, url: null, target: { strategy: "title", value: "Delete", role: null, exact: true, containerText: "Alpha Row" } } },
        { done: false, step: { op: "CLICK", target: { strategy: "label", value: "Acknowledge step 1" } } },
        { done: false, step: { op: "CLICK", target: { strategy: "label", value: "Acknowledge step 2" } } },
        { done: false, step: { op: "CLICK", target: { strategy: "text", value: "Confirm Delete", exact: true } } },
        { done: true, reason: "Row deleted" },
      ]);

      const authored = await authorNewSkill({
        skillId: "dept.delete_modal",
        app: "mock-app",
        description: "Delete a row via multi-checkbox modal.",
        goalPrompt: "Delete Alpha Row via modal checkboxes.",
        preconditions: [],
        produces: [{ name: "dept.deleted", params: { rowName: "{{rowName}}" } }],
        inputs: { rowName: { type: "string", required: true } },
        expectedPostconditions: [
          { kind: "HTTP_STATUS", method: "POST", path: "/api/delete", expectStatus: 200 },
          { kind: "DOM_NOT_CONTAINS", text: "{{rowName}}" },
          { kind: "CONSOLE_ERRORS", maxCount: 0 },
        ],
        authorBindings: { rowName: "Alpha Row" },
        replayBindings: { rowName: "Beta Row" },
        existingSkills: [],
        repoPath: tmpRepo,
        executorOptions: { baseUrl, stepTimeoutMs: 2500 },
        llm,
        schemaPath: SCHEMA_PATH,
        beforeRun: async () => {
          rows = ["Alpha Row", "Beta Row"];
        },
      });

      expect(authored.status).toBe("AUTHORED_AND_VERIFIED");
      expect(authored.replayLlmCallsUsed).toBe(0);
      expect(authored.replayVerdict).toBe("VERIFIED_PASS");
      expect(authored.explorationHistory?.length).toBeGreaterThanOrEqual(5);
      // Prompt right after clicking Delete MUST contain [MODAL] checkboxes despite 60 sidebar links and async hydration!
      expect(receivedPrompts[2]).toContain("[MODAL] checkbox");
      expect(receivedPrompts[2]).toContain("Acknowledge step 1");
      expect(receivedPrompts[2]).toContain("Confirm Delete");
    } finally {
      server.close();
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  }, 60000);
});
