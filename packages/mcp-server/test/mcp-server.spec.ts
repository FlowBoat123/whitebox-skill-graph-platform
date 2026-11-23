import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { McpServer, startStdioTransport } from "../src/index.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

describe("Local Unified MCP Server (JSON-RPC 2.0 stdio)", () => {
  it("handles MCP handshake, tools/list, resources/list, resources/read, and offline tools in-memory", async () => {
    const server = new McpServer({ workspaceRoot: REPO_ROOT });

    const init = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", clientInfo: { name: "vitest", version: "1.0" } },
    });
    expect(init?.result).toEqual(
      expect.objectContaining({
        protocolVersion: "2024-11-05",
        serverInfo: { name: "defect-intelligence-mcp", version: "0.1.0" },
      }),
    );

    // Notification returns null
    const notif = await server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notif).toBeNull();

    // tools/list returns all 6 tools
    const toolsRes = await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const toolNames = ((toolsRes?.result as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
    expect(toolNames).toEqual([
      "query_defect_knowledge",
      "plan_impacted_skills",
      "compose_skill_plan",
      "ground_code_refs",
      "run_skill_verification",
      "emit_defect_draft",
    ]);

    // resources/list & resources/read
    const resList = await server.handleMessage({ jsonrpc: "2.0", id: 3, method: "resources/list" });
    expect((resList?.result as { resources: unknown[] }).resources.length).toBe(2);

    const summaryRes = await server.handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "resources/read",
      params: { uri: "defect-intelligence://graph/summary" },
    });
    const summaryText = (summaryRes?.result as { contents: Array<{ text: string }> }).contents[0]!.text;
    const summary = JSON.parse(summaryText) as { activeInvariants: string[]; activeGuardrails: string[] };
    expect(summary.activeInvariants).toContain("INV-RWA-001");
    expect(summary.activeInvariants).toContain("INV-HOR-001");
    expect(summary.activeGuardrails).toContain("GRD-RWA-TX-001");
    expect(summary.activeGuardrails).toContain("GRD-HOR-DEPT-001");

    const catalogRes = await server.handleMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "resources/read",
      params: { uri: "defect-intelligence://skills/catalog" },
    });
    const catalog = JSON.parse(
      (catalogRes?.result as { contents: Array<{ text: string }> }).contents[0]!.text,
    ) as { totalSkills: number };
    expect(catalog.totalSkills).toBeGreaterThanOrEqual(12);

    // Tool: query_defect_knowledge
    const qRes = await server.handleMessage({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "query_defect_knowledge",
        arguments: { projectKey: "horilla", filePaths: ["base/cbv/department.py"] },
      },
    });
    const qData = JSON.parse(
      (qRes?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { confirmedKnowledge: { invariants: Array<{ id: string }>; activeGuardrails: Array<{ id: string }> } };
    expect(qData.confirmedKnowledge.invariants.map((i) => i.id)).toContain("INV-HOR-001");
    expect(qData.confirmedKnowledge.activeGuardrails.map((g) => g.id)).toContain("GRD-HOR-DEPT-001");

    // Tool: plan_impacted_skills (defect-aware prioritization!)
    const impRes = await server.handleMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "plan_impacted_skills",
        arguments: {
          skillsDir: "skills/horilla",
          changedFiles: ["base/cbv/department.py", "horilla_theme/templates/login.html"],
        },
      },
    });
    const impData = JSON.parse(
      (impRes?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { affectedSkills: Array<{ skillId: string; riskScore: number; confirmedSignals: { activeGuardrailIds: string[] } }> };
    // department.create (ACTIVE guardrail GRD-HOR-DEPT-001 + ACTIVE invariant INV-HOR-001) MUST rank #1 ahead of auth.login!
    expect(impData.affectedSkills[0]?.skillId).toBe("department.create");
    expect(impData.affectedSkills[0]?.confirmedSignals.activeGuardrailIds).toContain("GRD-HOR-DEPT-001");

    // Tool: compose_skill_plan
    const planRes = await server.handleMessage({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "compose_skill_plan",
        arguments: {
          skillsDir: "skills/horilla",
          goalFact: "department.exists",
          goalParams: { department: "Engineering" },
          bindings: { user: "hr_admin", department: "Engineering" },
          actorBindings: { hr_admin: { password: "demo" } },
        },
      },
    });
    const planData = JSON.parse(
      (planRes?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { steps: Array<{ skillId: string }> };
    expect(planData.steps.map((s) => s.skillId)).toEqual(["auth.login", "department.create"]);

    // Tool: emit_defect_draft (validates offline against real contracts/knowledge/!)
    const tmpDraftDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-emit-test-"));
    try {
      const emitRes = await server.handleMessage({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "emit_defect_draft",
          arguments: {
            app: "horilla",
            draftBugsDir: tmpDraftDir,
            violatedInvariants: ["INV-HOR-001"],
            bug: {
              origin: "OBSERVED_DETERMINISTIC",
              skillId: "department.create",
              summary: "Silent form.save() omission in department creation.",
              currentUrl: "http://127.0.0.1:8000/settings/department-view/",
              failedPostconditions: [
                { kind: "DOM_CONTAINS", passed: false, detail: "DOM missing 'Engineering'" },
              ],
              httpErrors: [],
              consoleErrors: [],
              codeRefs: {
                routes: ["/settings/department-view/"],
                endpoints: ["POST /settings-department-creation/"],
                sourceFiles: ["base/cbv/department.py", "horilla_theme/templates/generic/form.html"],
              },
            },
            proposeGuardrail: {
              skillsDir: "skills/horilla",
              skillId: "department.create",
              enforces: ["INV-HOR-001"],
            },
          },
        },
      });
      const emitData = JSON.parse(
        (emitRes?.result as { content: Array<{ text: string }> }).content[0]!.text,
      ) as {
        status: string;
        schemaValidation: { valid: boolean; errors: unknown[] };
        writtenFile: string;
        proposedGuardrail: { id: string; yaml: string };
      };
      expect(emitData.status).toBe("DRAFT");
      expect(emitData.schemaValidation.valid).toBe(true);
      expect(fs.existsSync(emitData.writtenFile)).toBe(true);
      expect(emitData.proposedGuardrail.yaml).toContain("type: SKILL_GRAPH_VERIFIER");
    } finally {
      fs.rmSync(tmpDraftDir, { recursive: true, force: true });
    }

    // Error handling: unknown method & unknown tool
    const unknownMethod = await server.handleMessage({ jsonrpc: "2.0", id: 10, method: "nope/method" });
    expect(unknownMethod?.error?.code).toBe(-32601);
    const unknownTool = await server.handleMessage({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "nonexistent_tool", arguments: {} },
    });
    expect(unknownTool?.error?.code).toBe(-32602);
  });

  it("supports Content-Length framed JSON-RPC over streams cleanly", async () => {
    const server = new McpServer({ workspaceRoot: REPO_ROOT });
    const inp = new PassThrough();
    const out = new PassThrough();
    const chunks: string[] = [];
    out.on("data", (d) => chunks.push(d.toString("utf8")));

    const transport = startStdioTransport(server, inp, out);
    try {
      const msg = JSON.stringify({ jsonrpc: "2.0", id: 42, method: "ping" });
      inp.write(`Content-Length: ${Buffer.byteLength(msg, "utf8")}\r\n\r\n${msg}`);
      await new Promise((r) => setTimeout(r, 80));
      const full = chunks.join("");
      expect(full).toContain("Content-Length:");
      expect(full).toContain('"id":42');
      expect(full).toContain('"result":{}');
    } finally {
      transport.stop();
    }
  });

  it("communicates end-to-end over a real child-process stdio transport", async () => {
    const tsxBin = path.join(REPO_ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
    const cliScript = path.join(REPO_ROOT, "packages", "mcp-server", "src", "cli.ts");

    const child = spawn(tsxBin, [cliScript, "--workspace", REPO_ROOT], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    const responses: Array<Record<string, unknown>> = [];
    let outBuf = "";
    const waitForCount = (expected: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${expected} MCP responses; got ${responses.length}`)), 15000);
        const onData = (chunk: Buffer) => {
          outBuf += chunk.toString("utf8");
          let nl = outBuf.indexOf("\n");
          while (nl !== -1) {
            const line = outBuf.slice(0, nl).trim();
            outBuf = outBuf.slice(nl + 1);
            if (line) responses.push(JSON.parse(line) as Record<string, unknown>);
            nl = outBuf.indexOf("\n");
          }
          if (responses.length >= expected) {
            clearTimeout(timer);
            child.stdout.off("data", onData);
            resolve();
          }
        };
        child.stdout.on("data", onData);
      });

    try {
      const done = waitForCount(2);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
      await done;

      expect(responses[0]?.id).toBe(1);
      expect((responses[0]?.result as { serverInfo: { name: string } }).serverInfo.name).toBe(
        "defect-intelligence-mcp",
      );
      expect(responses[1]?.id).toBe(2);
      expect((responses[1]?.result as { tools: unknown[] }).tools.length).toBe(6);
    } finally {
      child.kill();
    }
  }, 30000);
});
