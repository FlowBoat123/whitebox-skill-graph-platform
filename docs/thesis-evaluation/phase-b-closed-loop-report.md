# Phase B Evaluation Report — Unified Skill Graph ↔ Defect Knowledge Graph Closed Loop & Local MCP Server

Evaluates the deterministic (`0-LLM`, `$0.00`) closed-loop unification between the **White-Box Composable Skill Graph** and the **Defect Knowledge Graph**, exposed to AI coding agents over a zero-dependency **MCP JSON-RPC 2.0 stdio server** (`packages/mcp-server/`), while preserving all original `EvoBench-24` and Phase A reports untouched.

## 1. Defect-Aware Risk Prioritization & Sibling Propagation Ablation (`0-LLM`)

| Scenario | App | Setup | Plain File-Overlap Order | Defect-Aware Order | Plain Top-1 | Defect-Aware Top-1 |
|---|---|---|---|---|---:|---:|
| `PB-S1` | `cypress-rwa` | Multi-skill diff (BankAccountForm.tsx + transaction-routes.ts); high-risk P1 + ACTIVE guardrail on tx.create_payment | `bank.create, tx.create_payment, tx.create_request, tx.respond_request` | `tx.create_payment, tx.create_request, tx.respond_request, bank.create` | **No** | **Yes** |
| `PB-S2` | `horilla` | Multi-skill diff (login.html + department.py); P1 bug + ACTIVE guardrail on department.create | `auth.login, department.create, department.search` | `department.create, department.search, employee_type.create, auth.login` | **No** | **Yes** |
| `PB-S3` | `horilla` | Sibling propagation (department.py modified -> unmodified employee_type.py SIBLING_CANDIDATE) | `department.create, department.search` | `department.create, department.search, employee_type.create` | Yes | **Yes** |
| `PB-S4` | `horilla` | NO_IMPACT change (README.md) must trigger 0 skills | `(none)` | `(none)` | Yes | **Yes** |
| **Summary** | **2 Stacks** | **Top-1 Risk Accuracy / Sibling Catch Rate** | Top-1: 2/4, Sibling: 0/2 | **Top-1: 4/4 (100%), Sibling: 2/2 (100%)** | 2/4 | **4/4** |

## 2. End-to-End Live MCP Stdio Closed-Loop Verification (`0-LLM`, `$0.00`)

Each trial spawns the real `packages/mcp-server/src/cli.ts` child process over `stdio`, injects a live product bug into the target application, calls `plan_impacted_skills` -> `run_skill_verification` (auto-emitting a `bug.schema.json`-validated `DRAFT` YAML) -> compiles the updated Defect Knowledge Graph -> re-queries `query_defect_knowledge` & `plan_impacted_skills` over MCP:

| App & Bug | Top-1 Impacted Skill | Active Guardrail | MCP Verify Verdict | Emitted Registry Bug | Risk Score (Before -> After) | Provenance & Loop Check |
|---|---|---|---|---|---|---|
| `cypress-rwa` (`RWA-B1`) | `tx.respond_request` | `-` | `PRODUCT_BUG` (`0` LLM) | `BUG:cypress-rwa:170917871` (`DRAFT`, valid=true) | `22 -> 27` | **PASS (Provenance Isolated)** |
| `horilla` (`HOR-B1`) | `department.create` | `GRD-HOR-DEPT-001` | `PRODUCT_BUG` (`0` LLM) | `BUG:horilla:58040835` (`DRAFT`, valid=true) | `47 -> 52` | **PASS (Provenance Isolated)** |

## 3. Overleaf IEEE `booktabs` LaTeX Snippet

```latex
\begin{table*}[t]
\centering
\caption{Phase B Closed-Loop Evaluation: Defect-Aware Prioritization, Sibling Propagation, and Live MCP Verification (0-LLM)}
\label{tab:phase-b-closed-loop}
\begin{tabular}{llrrll}
\toprule
Impact Strategy & Top-1 Risk Acc. & Sibling Recall & NO\_IMPACT Prec. & MCP Closed Loop & Provenance Gate \\
\midrule
Plain File-Overlap & 2/4 (50.0\%) & 0/2 (0.0\%) & 100.0\% & N/A & N/A \\
\textbf{Defect-Aware Unified Graph} & \textbf{4/4 (100.0\%)} & \textbf{2/2 (100.0\%)} & \textbf{100.0\%} & \textbf{2/2 PASS (0-LLM)} & \textbf{100\% DRAFT Isolated} \\
\bottomrule
\end{tabular}
\end{table*}
```

## 4. IDE / Coding Agent MCP Configuration Snippet

```json
{
  "mcpServers": {
    "defect-intelligence": {
      "command": "npm",
      "args": ["run", "mcp", "--silent"],
      "cwd": "<path-to-defect-intelligence-platform>"
    }
  }
}
```
