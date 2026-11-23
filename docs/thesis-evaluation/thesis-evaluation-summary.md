# Empirical Evaluation Summary — White-Box Composable Skill Graph (`EvoBench-24`)

This document consolidates the reproducible experimental evaluation designed for an **Undergraduate Capstone Thesis (Khóa luận Tốt nghiệp)** and an accompanying **IEEE-format research paper**.

- **Paper-ready Markdown tables:** [paper-tables.md](file:///c:/Users/ADMIN/Music/defect-intelligence-platform/docs/thesis-evaluation/paper-tables.md)
- **Overleaf-ready IEEE `booktabs` LaTeX tables:** [paper-tables.tex](file:///c:/Users/ADMIN/Music/defect-intelligence-platform/docs/thesis-evaluation/paper-tables.tex)
- **Raw CSV datasets (for Python/matplotlib/PGFPlots charts):**
  - [rq1-amortization.csv](file:///c:/Users/ADMIN/Music/defect-intelligence-platform/docs/thesis-evaluation/rq1-amortization.csv)
  - [rq2-evobench24-results.csv](file:///c:/Users/ADMIN/Music/defect-intelligence-platform/docs/thesis-evaluation/rq2-evobench24-results.csv)
  - [rq2-system-comparison.csv](file:///c:/Users/ADMIN/Music/defect-intelligence-platform/docs/thesis-evaluation/rq2-system-comparison.csv)
  - [rq3-authoring-results.csv](file:///c:/Users/ADMIN/Music/defect-intelligence-platform/docs/thesis-evaluation/rq3-authoring-results.csv)

---

## 1. Experimental Setup

- **Target Open-Source Applications (2 Contrasting Web Stacks, 0 Docker, Unmodified Upstream Code):**
  1. `cypress-io/cypress-realworld-app` (TypeScript + React 18 + MUI + XState + Express + GraphQL + `lowdb`), `8` validated atomic skills (`skills/cypress-rwa/`).
  2. `horilla-opensource/horilla` (Python 3.12 + Django 5.2 + HTMX + SQLite), `4` validated atomic skills (`skills/horilla/`).
- **Cloud LLM (Identical Across All Baselines & Ablations):** `deepseek/deepseek-v3.2` (`temperature = 0`, JSON mode, OpenRouter reference pricing `\$0.27 / 1M` prompt tokens, `\$1.10 / 1M` completion tokens).
- **Browser Runtime:** Playwright (`playwright-core`) driving headless Chromium/Edge (`1280×800`), strict same-origin boundary enforcement, fresh database reset before every timed trial.
- **Fairness Controls:** Baseline 2 (Pure-LLM Agent) and Ablations A/B share the exact same LLM, DOM snapshotter (including resolved `<label for>` and `title` attributes), semantic action executor, and deterministic postcondition verifier.

---

## 2. Quantitative Findings by Research Question

### RQ1 — Cost & Latency Amortization (`0-LLM` Skill Graph vs. Pure-LLM Browser Agent)

Across **5 multi-step workflows** (3 on `cypress-rwa` including a 2-user, 5-skill payment-request approval chain; 2 on `horilla` including a 3-skill login→create→search chain):

- **Reliability:** Composable Skill Graph achieved **25 / 25 (`100.00%`) `VERIFIED_PASS`** with **`0` LLM calls**, compared to **11 / 15 (`73.33%`)** for the stateless Pure-LLM Baseline. Importantly, the Pure-LLM baseline succeeded on **6 / 6 (`100%`)** Horilla runs and **3 / 3 (`100%`)** of the hardest 2-user RWA workflow runs — confirming the baseline is strong and unhandicapped, yet still suffers stochastic step loops on `rwa_tx_payment` (0/3) and `rwa_bank_create` (2/3).
- **Latency Speedup:** Skill Graph averaged **5.07 s/run** vs. **102.34 s/run** for Pure-LLM (**20.2× faster**).
- **Cost Amortization:** Including measured one-time authoring cost (`7.0` calls, `\$0.00322`) and a 4% periodic UI drift rate (`1` white-box heal every 25 runs at `\$0.00121`), cumulative cost drops by **88.17%** at `N = 5` measured runs (`\$0.00322` vs `\$0.02722`) and **98.52%** at `N = 100` runs (`11` total LLM calls = `\$0.00807` vs. `1,440` LLM calls = `\$0.54430`).

### RQ2 — White-Box Fault Discrimination & Safe Self-Healing on `EvoBench-24`

Across **24 deterministic repository mutations** (`8` `SKILL_DRIFT`, `10` `PRODUCT_BUG`, `6` `NO_IMPACT`; `14` React/Express + `10` Django/HTMX):

- **3-Way Fault Classification (`VERIFIED_PASS` / `SKILL_DRIFT` / `PRODUCT_BUG` / `NO_IMPACT`):** **24 / 24 (`100.00%` Accuracy, `100.00%` Macro-F1)**. Every silent regression — including `RWA-B1` (swallowed click), `RWA-B6` (backend returns HTTP 200 without saving comment), `HOR-B1` & `HOR-B3` (Django views skip `form.save()` while returning HTTP 200 and 0 JS errors) — was classified strictly as `PRODUCT_BUG`.
- **White-Box Impact Selection:** **100.00% Precision**, **100.00% Recall**, and **83.55% Test Reduction** across all 24 commits (skipping 83.55% of unaffected skill executions without missing a single impacted skill).
- **Monotonic Ablation Improvement:**
  - *Static Semantic Script (No Heal):* `0.0%` (0/8) Drift Recovery Rate (DRR), `0` heal calls, `0%` test reduction.
  - *Black-Box Self-Healer (Ablation A — no `git diff`, no `PRODUCT_BUG` refusal gate):* **`62.5%` (5/8)** DRR, spent **`18` LLM calls (`2.25×` more)** attempting to repair real bugs, and **attempted to weaken or remove postconditions on `50.0%` (5/10) of real product bugs** (`RWA-B1`, `RWA-B3`, `RWA-B4`, `RWA-B5`, `HOR-B4`). Notably, our strict `skill.schema.json` validator intercepted the malformed weakened patches (`0%` verified FHR), demonstrating defense-in-depth between the deterministic refusal gate and strict schema validation.
  - *Telemetry-Gated No-Diff (Ablation B — keeps deterministic `PRODUCT_BUG` refusal gate, withholds `git diff`):* **`75.0%` (6/8)** DRR, **`0.0%` (0/10)** Attempted Weakening & FHR, `8` heal calls.
  - *Full White-Box Skill Graph (Ours):* **`87.5%` (7/8)** DRR, **`0.0%` (0/10)** Attempted Weakening & FHR, **`100.0%` (10/10)** Bug Detection, **`8` heal calls (`\$0.0097`)**, **`83.55%` test reduction**. On Django HTMX template drifts (`HOR-D2` and `HOR-D3`), **only** the `git diff`-guided White-Box healer succeeded while both Black-Box and No-Diff failed.

### RQ3 — Cross-Stack Authoring & Generalization Gate Ablation

Across **4 brand-new skills** authored live (`tx.comment` and `user.settings_update` on React/Express; `work_type.create` and `department.delete` on Django/HTMX):

- **With Parameterization + Mandatory `0-LLM` Fresh-Data Replay Gate:** **3 / 4 (`75.0%`)** achieved `AUTHORED_AND_VERIFIED` (`4` calls each on React/Express, `10` calls on Horilla `work_type.create`) and replayed cleanly on unseen fresh data with **`0` LLM calls**.
- **Without Gate (Naive Raw Step Recording):** **0 / 4 (`0.0%`)** passed fresh-data replay — every single authored skill (`3/3` successful ones) would have silently overfit hardcoded sample values or ephemeral selectors without our parameterization and `0-LLM` verification gate.

### RQ4 — Stack Portability & Deterministic Defect Provenance

- **Zero App-Specific Engine Code:** Expanding from TypeScript/React/Express/GraphQL to Python/Django/HTMX required **`0` app-specific LOC** inside `packages/skill-graph/src/`. (Two domain-general improvements were added during the study: closed semantic `title` strategy in schema/executor for icon-only buttons, and `waitUntil: "domcontentloaded"` on `waitForURL` so third-party CDN assets cannot stall URL transition checks.)
- **Defect Knowledge Bridge Coverage:** **10 / 10 (`100.00%`)** Category B product regressions automatically produced deterministic `DRAFT` bug records (`status: "DRAFT"`, `origin: "OBSERVED_DETERMINISTIC"`) linking exact `codeRefs.sourceFiles`, endpoints, telemetry, and screenshots for human review prior to `CONFIRMED` promotion.

---

## 3. Honest Error Analysis

Two real failure cases occurred during live evaluation and are retained transparently without cherry-picking:

1. **`HOR-D1` Single-Shot White-Box Healing Rejection (`1/8` drift failure):** On `horilla_theme/templates/login.html` (`Sign In` → `Access Workspace`), White-Box correctly detected `SKILL_DRIFT` and called the LLM once, but the proposed single-shot patch failed live replay verification (`HEAL_REJECTED_BY_VERIFIER`). Allowing up to `k = 2` bounded repair retries fed with the verifier diagnostic would directly address this edge case while keeping LLM cost bounded.
2. **`department.delete` Authoring Budget Exhaustion (`1/4` authoring failure):** Horilla's protected-record delete workflow requires opening an icon-only `<a title="Delete">` button followed by checking 3 mandatory safety checkboxes before enabling `#deleteConfirmBtn`. Within the strict `maxSteps = 10` authoring budget, exploration exhausted its step limit before confirming deletion. Increasing `maxSteps` for multi-stage confirmation modals (or supporting macro preconditions) is a clear next engineering step.

---

## 4. Threats to Validity

- **Internal Validity:** `EvoBench-24` uses synthetic, developer-realistic mutations injected into real upstream repositories rather than historical git commits from issue trackers. We mitigated bias by spanning 6 distinct regression classes (HTTP 500, GraphQL crash, JS submit crash, swallowed UI click, silent HTTP 200 DB drop, broken auth) and 2 drift classes (label/placeholder renames and structural Yup-validated required fields).
- **External Validity:** Experiments cover two contrasting web stacks (React/Express SPA and Django/HTMX MPA) on local servers without external SSO/OAuth or third-party payment gateways. Generalization to canvas-heavy apps, shadow DOM components, or flaky microservice environments remains future work.
- **Construct Validity:** Cost projections at `N = 10..100` in Table I rely on an analytical drift-frequency model (1 UI drift per 25 runs) parameterized by our directly measured authoring, replay, and healing costs; measured (`N = 1, 5`) and projected (`N = 10..100`) rows are explicitly labeled in all tables.

---

## 5. Reproduction Commands

```powershell
# Offline unit tests & schema validation (0 LLM calls, 0 live servers needed)
npm run typecheck
npm test

# Live benchmark (requires local target server + transient OPENROUTER_API_KEY)
$env:OPENROUTER_API_KEY = "<your-key>"
.\node_modules\.bin\tsx.cmd scripts\skill-graph-thesis-benchmark.ts --rq all --app cypress-rwa
.\node_modules\.bin\tsx.cmd scripts\skill-graph-thesis-benchmark.ts --rq all --app horilla

# Re-export IEEE LaTeX tables, Markdown tables, and CSV datasets from raw receipts
.\node_modules\.bin\tsx.cmd scripts\skill-graph-thesis-benchmark.ts --export
```
