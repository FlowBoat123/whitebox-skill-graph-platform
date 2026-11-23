# Paper-Ready Evaluation Tables (`EvoBench-24`)

## Table I — RQ1: Cost & Latency Amortization (Pure-LLM Baseline vs. White-Box Skill Graph)

| Runs ($N$) | Basis | Pure-LLM Calls | Pure-LLM Cost (\$) | Pure-LLM Time (s) | Skill Graph Calls | Skill Graph Cost (\$) | Skill Graph Time (s) | Cost Reduction |
|---:|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | Measured | 14.4 | \$0.00544 | 102.3s | 7 | \$0.00322 | 5.1s | **40.81%** |
| 5 | Measured | 72 | \$0.02722 | 511.7s | 7 | \$0.00322 | 25.4s | **88.17%** |
| 10 | Projected | 144 | \$0.05443 | 1023.4s | 7 | \$0.00322 | 50.7s | **94.08%** |
| 25 | Projected | 360 | \$0.13608 | 2558.6s | 8 | \$0.00443 | 126.9s | **96.74%** |
| 50 | Projected | 720 | \$0.27215 | 5117.2s | 9 | \$0.00564 | 253.7s | **97.93%** |
| 100 | Projected | 1440 | \$0.54430 | 10234.3s | 11 | \$0.00807 | 507.4s | **98.52%** |

- Observed Pass Rate: Skill Graph **100%** (25 runs, avg 5074 ms, `0` LLM calls) vs. Pure-LLM Baseline **73.33%** (15 runs, avg 102343 ms, avg 14.4 calls/run).

## Table II — RQ2: Evolution Benchmark (`EvoBench-24`) System & Ablation Comparison

| System Variant | Drift Recovery (DRR ↑) | Attempted Weakening (↓) | False Healing (FHR ↓) | Bug Detection (↑) | Heal LLM Calls | Test Reduction |
|---|---:|---:|---:|---:|---:|---:|
| Static Semantic Script (No Heal) | 0/8 (0%) | 0/10 (0%) | 0/10 (0%) | 10/10 (100%) | 0 | 0% |
| Black-Box Self-Healer (Ablation A) | 5/8 (62.5%) | 5/10 (50%) | 0/10 (0%) | 10/10 (100%) | 18 | 0% |
| Telemetry-Gated No-Diff (Ablation B) | 6/8 (75%) | 0/10 (0%) | 0/10 (0%) | 10/10 (100%) | 8 | 83.55% |
| White-Box Skill Graph (Ours) | 7/8 (87.5%) | 0/10 (0%) | 0/10 (0%) | 10/10 (100%) | 8 | 83.55% |

- White-Box Fault Classification Accuracy: **100%** (Macro-F1: **100%**; Impact Selection Precision **100%**, Recall **100%**).

## Table III — RQ3: Cross-Stack Skill Authoring & Generalization Gate Ablation

| Skill ID | App | With Gate (Status / Replay) | Author Calls | Without Gate (Fresh Replay) | Overfit Caught? |
|---|---|---|---:|---|---|
| `tx.comment` | `cypress-rwa` | AUTHORED_AND_VERIFIED (`VERIFIED_PASS`) | 4 | `SKILL_DRIFT` | Yes |
| `user.settings_update` | `cypress-rwa` | AUTHORED_AND_VERIFIED (`VERIFIED_PASS`) | 4 | `PRODUCT_BUG` | Yes |
| `work_type.create` | `horilla` | AUTHORED_AND_VERIFIED (`VERIFIED_PASS`) | 10 | `PRODUCT_BUG` | Yes |
| `department.delete` | `horilla` | AUTHOR_FAILED (`PRODUCT_BUG`) | 10 | `SKILL_DRIFT` | No |

## Table IV — RQ4: Cross-Stack Portability & Deterministic Defect Provenance

- App-specific core engine LOC in `packages/skill-graph/src/`: **0**
- Deterministic `DRAFT` bug records exported for Category B regressions: **10/10 (100%)**
- All exported bug drafts strictly labeled `status="DRAFT"` & `origin="OBSERVED_DETERMINISTIC"`: **true**
