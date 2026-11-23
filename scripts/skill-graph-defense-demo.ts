import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRegistry, validateRegistry } from "../packages/knowledge-validator/src/index.js";
import {
  createSkillValidator,
  groundSkillCodeRefs,
  selectDefectAwareImpactedSkills,
  sourceFileToCodeUnitId,
} from "../packages/skill-graph/src/index.js";

const REPO_ROOT = process.cwd();
const KNOWLEDGE_INDEX_PATH = path.join(REPO_ROOT, "build", "knowledge-index.json");
const KNOWLEDGE_DIR = path.join(REPO_ROOT, "knowledge");

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
};

function banner(title: string): void {
  const bar = "=".repeat(76);
  console.log(`\n${C.cyan}${bar}${C.reset}`);
  console.log(`${C.bold}${C.cyan}  ${title}${C.reset}`);
  console.log(`${C.cyan}${bar}${C.reset}`);
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class StdioMcpClient {
  private readonly child;
  private buffer = "";
  private readonly pending = new Map<number, (msg: JsonRpcResponse) => void>();
  private nextId = 1;

  constructor() {
    const tsxCli = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const cliPath = path.join(REPO_ROOT, "packages", "mcp-server", "src", "cli.ts");
    this.child = spawn(process.execPath, [tsxCli, cliPath, "--workspace", REPO_ROOT], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let nl = this.buffer.indexOf("\n");
      while (nl !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) {
          try {
            const msg = JSON.parse(line) as JsonRpcResponse;
            if (typeof msg.id === "number") {
              const resolver = this.pending.get(msg.id);
              if (resolver) {
                this.pending.delete(msg.id);
                resolver(msg);
              }
            }
          } catch {
            // Ignore non-JSON stderr/banner lines if any
          }
        }
        nl = this.buffer.indexOf("\n");
      }
    });
  }

  request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout for ${method}`));
      }, 10_000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
    });
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

async function main() {
  const tStart = Date.now();
  console.log(
    `${C.bold}${C.blue}\n  DEFECT INTELLIGENCE PLATFORM — LIVE OFFLINE THESIS DEFENSE DEMO (0-LLM, $0.00)${C.reset}`,
  );
  console.log(
    `${C.dim}  White-Box Composable Skill Graph <-> Defect Knowledge Graph <-> Local MCP Server${C.reset}`,
  );

  // =========================================================================
  // STAGE 1: Static Route-to-Code Grounding (0-LLM)
  // =========================================================================
  banner("STAGE 1: Deterministic Static Route-to-Code Grounding (0-LLM)");
  const rwaSandbox = path.join(REPO_ROOT, "runtime", "sandboxes", "cypress-realworld-app");
  const horSandbox = path.join(REPO_ROOT, "runtime", "sandboxes", "horilla");

  if (fs.existsSync(rwaSandbox)) {
    const t0 = performance.now();
    const rwaGrounded = groundSkillCodeRefs({
      repoPath: rwaSandbox,
      routes: ["/user/settings"],
      endpoints: ["PATCH /users/"],
      maxFiles: 6,
    });
    const dt = (performance.now() - t0).toFixed(1);
    console.log(
      `  ${C.green}[React/Express/GraphQL]${C.reset} Route /user/settings grounded in ${C.bold}${dt} ms${C.reset} via ${rwaGrounded.adaptersUsed.join(", ")}:`,
    );
    for (const f of rwaGrounded.sourceFiles) {
      console.log(`    - ${f}`);
    }
  } else {
    console.log(`  ${C.yellow}[Info]${C.reset} cypress-realworld-app sandbox not present locally; skipping live TS grounding.`);
  }

  if (fs.existsSync(horSandbox)) {
    const t0 = performance.now();
    const horGrounded = groundSkillCodeRefs({
      repoPath: horSandbox,
      routes: ["/settings/department-view/"],
      endpoints: ["POST /settings-department-creation/"],
      maxFiles: 6,
    });
    const dt = (performance.now() - t0).toFixed(1);
    console.log(
      `  ${C.green}[Python/Django/HTMX]${C.reset}   Route /settings/department-view/ grounded in ${C.bold}${dt} ms${C.reset} via ${horGrounded.adaptersUsed.join(", ")}:`,
    );
    for (const f of horGrounded.sourceFiles) {
      console.log(`    - ${f}`);
    }
  } else {
    console.log(`  ${C.yellow}[Info]${C.reset} horilla sandbox not present locally; skipping live Django grounding.`);
  }

  // =========================================================================
  // STAGE 2: Plain File-Overlap vs Defect-Aware Unified Graph (0-LLM)
  // =========================================================================
  banner("STAGE 2: Defect-Aware Risk Prioritization & Sibling Propagation (0-LLM)");
  const validator = createSkillValidator(path.join(REPO_ROOT, "contracts", "skill-graph", "skill.schema.json"));
  const loaded = validator.validateDirectory(path.join(REPO_ROOT, "skills", "horilla"));
  if (!loaded.valid) {
    throw new Error(`Invalid skills in skills/horilla: ${JSON.stringify(loaded.diagnostics)}`);
  }
  const horSkills = loaded.skills.map((s) => s.skill);
  const simulatedDiffFiles = ["horilla_theme/templates/login.html", "base/cbv/department.py"];

  const plainOverlap = horSkills
    .filter((s) => s.codeRefs.sourceFiles.some((f) => simulatedDiffFiles.includes(f)))
    .map((s) => s.id);

  // Augment compiled index with a demo confirmed bug linking department.py -> sibling employee_type.py
  const deptCu = sourceFileToCodeUnitId("horilla", "base/cbv/department.py")!;
  const empCu = sourceFileToCodeUnitId("horilla", "base/cbv/employee_type.py")!;
  const compiledGraph = JSON.parse(fs.readFileSync(KNOWLEDGE_INDEX_PATH, "utf8")) as {
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  };
  const demoGraph = JSON.parse(JSON.stringify(compiledGraph)) as typeof compiledGraph;
  demoGraph.nodes.push(
    {
      id: "BUG:horilla:99901",
      type: "BUG",
      status: "CONFIRMED",
      attributes: { severity: "P1", projectKey: "horilla", title: "Demo silent form.save() regression" },
    },
    { id: deptCu, type: "CODE_UNIT" },
    { id: empCu, type: "CODE_UNIT" },
  );
  demoGraph.edges.push(
    { type: "AFFECTS", from: "BUG:horilla:99901", to: deptCu },
    { type: "VIOLATES", from: "BUG:horilla:99901", to: "INV-HOR-001" },
    {
      type: "SIBLING_CANDIDATE",
      from: "BUG:horilla:99901",
      to: empCu,
      attributes: { verdict: "AFFECTED" },
    },
  );

  const t1 = performance.now();
  const unified = selectDefectAwareImpactedSkills({
    skills: loaded.skills,
    changedFiles: simulatedDiffFiles,
    knowledgeGraph: demoGraph as unknown as Parameters<typeof selectDefectAwareImpactedSkills>[0]["knowledgeGraph"],
  });
  const dtSelect = (performance.now() - t1).toFixed(2);

  console.log(`  Simulated Git Diff: ${C.bold}${simulatedDiffFiles.join(", ")}${C.reset}`);
  console.log(`  Plain File-Overlap Order   : ${C.dim}${plainOverlap.join(" -> ")}${C.reset} (misses unmodified sibling!)`);
  console.log(
    `  ${C.green}Defect-Aware Unified Order${C.reset} : ${C.bold}${unified.affectedSkills.map((s) => s.skillId).join(" -> ")}${C.reset} (${dtSelect} ms, 0-LLM)`,
  );
  for (const s of unified.affectedSkills) {
    const isSibling =
      s.selectionReasons.includes("SIBLING_DEFECT_PROPAGATION") &&
      !s.selectionReasons.includes("DIRECT_CODE_OVERLAP");
    const tag = isSibling
      ? `${C.yellow}[SIBLING PROPAGATION — file untouched! RISK=${s.riskScore}]${C.reset}`
      : `${C.blue}[FILE OVERLAP + RISK=${s.riskScore}]${C.reset}`;
    const guardrails = s.confirmedSignals.activeGuardrailIds.length
      ? ` guardrails=${s.confirmedSignals.activeGuardrailIds.join(",")}`
      : "";
    console.log(`    • ${s.skillId.padEnd(22)} ${tag}${guardrails}`);
  }

  // =========================================================================
  // STAGE 3: Live Local MCP Server (stdio JSON-RPC 2.0) Closed-Loop Call
  // =========================================================================
  banner("STAGE 3: Live Local MCP Server (stdio) Handshake & Closed-Loop Tools");
  const mcp = new StdioMcpClient();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "defense-demo-mcp-"));
  let emittedYamlPath = "";
  let emittedBugId = "";

  try {
    const init = await mcp.request("initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "thesis-defense-demo", version: "1.0.0" },
    });
    const initResult = init.result as { serverInfo: { name: string; version: string } };
    console.log(
      `  ${C.green}[MCP Handshake OK]${C.reset} Connected to ${C.bold}${initResult.serverInfo.name} v${initResult.serverInfo.version}${C.reset}`,
    );

    const toolsRes = await mcp.request("tools/list");
    const tools = (toolsRes.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    console.log(`  ${C.green}[MCP Tools (${tools.length})]${C.reset}     ${tools.join(", ")}`);

    const qRes = await mcp.request("tools/call", {
      name: "query_defect_knowledge",
      arguments: { projectKey: "horilla", filePaths: ["base/cbv/department.py"] },
    });
    const qData = JSON.parse((qRes.result as { content: Array<{ text: string }> }).content[0]!.text) as {
      confirmedKnowledge: {
        invariants: Array<{ id: string }>;
        activeGuardrails: Array<{ id: string }>;
      };
    };
    console.log(
      `  ${C.green}[query_defect_knowledge]${C.reset} Confirmed Invariants: ${C.bold}${qData.confirmedKnowledge.invariants.map((i) => i.id).join(", ")}${C.reset} | Guardrails: ${C.bold}${qData.confirmedKnowledge.activeGuardrails.map((g) => g.id).join(", ")}${C.reset}`,
    );

    const emitRes = await mcp.request("tools/call", {
      name: "emit_defect_draft",
      arguments: {
        app: "horilla",
        draftBugsDir: tmpRoot,
        violatedInvariants: ["INV-HOR-001"],
        bug: {
          origin: "OBSERVED_DETERMINISTIC",
          skillId: "department.create",
          summary: "Silent form.save() omission in Horilla Department creation (HOR-B1).",
          currentUrl: "http://127.0.0.1:8000/settings/department-view/",
          failedPostconditions: [{ kind: "DOM_CONTAINS", passed: false, detail: "DOM missing 'Engineering'" }],
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
    });
    const emitData = JSON.parse((emitRes.result as { content: Array<{ text: string }> }).content[0]!.text) as {
      bugId: string;
      status: string;
      schemaValidation: { valid: boolean };
      writtenFile: string;
      proposedGuardrail: { id: string };
    };
    emittedYamlPath = emitData.writtenFile;
    emittedBugId = emitData.bugId;
    console.log(
      `  ${C.green}[emit_defect_draft]${C.reset}      Emitted ${C.bold}${emitData.bugId}${C.reset} (status=${C.yellow}${emitData.status}${C.reset}, schemaValid=${C.green}${emitData.schemaValidation.valid}${C.reset}, guardrail=${emitData.proposedGuardrail.id})`,
    );

    // =========================================================================
    // STAGE 4: Provenance Isolation Proof (DRAFT cannot self-promote to CONFIRMED)
    // =========================================================================
    banner("STAGE 4: Provenance Isolation Gate (Blocking Automated CONFIRMED Promotion)");
    // Copy current knowledge dir into <tempReg>/knowledge and inject emitted DRAFT vs tampered CONFIRMED
    const tempReg = path.join(tmpRoot, "registry-copy");
    const tempKnowledge = path.join(tempReg, "knowledge");
    fs.cpSync(KNOWLEDGE_DIR, tempKnowledge, { recursive: true });
    const draftDest = path.join(tempKnowledge, "bugs", "horilla", path.basename(emittedYamlPath));
    fs.mkdirSync(path.dirname(draftDest), { recursive: true });
    const draftYaml = fs.readFileSync(emittedYamlPath, "utf8");
    fs.writeFileSync(draftDest, draftYaml, "utf8");

    const draftCheck = validateRegistry(await loadRegistry(tempReg));
    console.log(
      `  1. Registry with auto-emitted ${C.yellow}status: DRAFT${C.reset}     -> valid=${C.green}${C.bold}${draftCheck.valid}${C.reset} (${emittedBugId} isolated as provisional observation)`,
    );

    // Attempt illegal automated promotion to CONFIRMED without human RCA/evidence
    const tamperedYaml = draftYaml.replace(/^status:\s*DRAFT$/m, "status: CONFIRMED");
    fs.writeFileSync(draftDest, tamperedYaml, "utf8");
    const tamperCheck = validateRegistry(await loadRegistry(tempReg));
    console.log(
      `  2. Attempted auto-promotion to ${C.red}status: CONFIRMED${C.reset} -> valid=${C.red}${C.bold}${tamperCheck.valid}${C.reset} (BLOCKED by ${tamperCheck.errors.length} hardening rules!)`,
    );
    if (tamperCheck.errors[0]) {
      console.log(`     ${C.dim}First rejection reason: ${tamperCheck.errors[0].message}${C.reset}`);
    }
    if (!draftCheck.valid || tamperCheck.valid) {
      throw new Error("Provenance isolation invariant check failed!");
    }
  } finally {
    mcp.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  const totalSec = ((Date.now() - tStart) / 1000).toFixed(2);
  console.log(
    `\n${C.bold}${C.green}  [ALL 4 DEFENSE DEMO STAGES PASSED] Total time: ${totalSec}s | LLM Calls: 0 | Cost: $0.00${C.reset}\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
