# Phase C Scientific & Statistical Evaluation Summary

Compiles the expanded **`EvoBench-48`** benchmark (`48` commits), **3-Model Cross-Family Generalization Panel**, **Real-World Upstream Git Commit Replay (`RealGit`, `99` real commits, `0-LLM`)**, and exact **Non-Parametric & Binomial Statistical Tests**, while keeping all prior `EvoBench-24`, Phase A, and Phase B artifacts untouched.

## 1. `EvoBench-48` System Comparison (with Wilson 95% CIs & Exact Significance Tests)

- **Benchmark Composition:** `48` commits (`16` `SKILL_DRIFT`, `20` `PRODUCT_BUG`, `12` `NO_IMPACT`).
- **Fault Classification Accuracy:** **48/48 (100.00%)**.
- **Impact Selection Exact Match:** **48/48 (100.00%)** with **80.74% Test Reduction** (`57/296` skill executions).

| System | DRR (Wilson 95% CI) | Attempted Weakening (95% CI) | False Healing Rate (95% CI) | Bug Detection | Heal LLM Calls | Est. Heal Cost |
|---|---:|---:|---:|---:|---:|---:|
| Static Playwright (`0-LLM`) | 0.0% [0.0, 19.4] | 0.0% | 0.0% | 100.0% | 0 | $0.0000 |
| Black-Box Healer (No Diff / No Gate) | 50.0% [28.0, 72.0] | 60.0% [38.7, 78.1] | 5.0% [0.9, 23.6] | 95.0% (19/20) | 36 | $0.0432 |
| Telemetry-Gated (No Diff) | 81.3% [57.0, 93.4] | 0.0% [0.0, 16.1] | 0.0% [0.0, 16.1] | 100.0% (20/20) | 17 | $0.0198 |
| **White-Box Skill Graph (`k <= 2`)** | **100.0% [80.6, 100.0]** | **0.0% [0.0, 16.1]** | **0.0% [0.0, 16.1]** | **100.0% (20/20)** | **16** | **$0.0191** |

### Exact Statistical Significance Tests (`EvoBench-48` & `RQ1`)
- **DRR — White-Box vs. Static (Exact McNemar, paired):** `b=16, c=0`, **`p < 0.001`**
- **DRR — White-Box vs. Black-Box (Exact McNemar, paired):** `b=8, c=0`, **`p = 0.0078`**
- **DRR — White-Box vs. Telemetry-Gated No-Diff (Exact McNemar, paired):** `b=3, c=0`, **`p = 0.250`**
- **Safety (Attempted Weakening) — White-Box vs. Black-Box (Fisher's Exact, two-sided):** `0/20` vs `12/20`, **`p < 0.001`**
- **Safety (False Healing Rate) — White-Box vs. Black-Box (Fisher's Exact, two-sided):** `0/20` vs `1/20`, **`p = 1.000`**
- **RQ1 Pass Rate — Skill Graph vs. Pure-LLM (Fisher's Exact):** 100.0% [86.7, 100.0] vs 73.3% [48.0, 89.1], **`p = 0.015`**
- **RQ1 Latency — Skill Graph vs. Pure-LLM (Mann-Whitney U + Cliff's Delta):** median `4.47s` vs `113.25s`, `U = 0`, **`p < 0.001`**, **`delta = -1 (large)`**

## 2. Cross-Model Generalization Panel (3 LLM Families)

| Model Family | WB DRR (95% CI) | BB DRR | WB Bug Calls / FHR | BB Weakening / FHR | Cross-Stack Authoring | WB Calls (USD) | BB Calls (USD) |
|---|---:|---:|---:|---:|---:|---:|---:|
| **DeepSeek-V3.2** (`deepseek/deepseek-v3.2`) | 8/8 (100.0% [67.6, 100.0]) | 4/8 (50.0%) | **0 / 0/4 (0%)** | 0/4 / 0/4 | 2/2 | 8 (`$0.0099`) | 12 (`$0.0146`) |
| **Gemini-2.5-Flash** (`google/gemini-2.5-flash`) | 8/8 (100.0% [67.6, 100.0]) | 7/8 (87.5%) | **0 / 0/4 (0%)** | 1/4 / 1/4 | 1/2 | 9 (`$0.0212`) | 12 (`$0.0285`) |
| **GPT-4o-mini** (`openai/gpt-4o-mini`) | 8/8 (100.0% [67.6, 100.0]) | 6/8 (75.0%) | **0 / 0/4 (0%)** | 1/4 / 0/4 | 2/2 | 8 (`$0.0038`) | 12 (`$0.0050`) |

## 3. Real-World Upstream Git Commit Replay (`RealGit`, `0-LLM`)

| Repository | Real Commits Replayed | `NO_IMPACT` Skipped | Test Reduction Rate | Median Latency | P95 Latency | Docs/CI/Deps | Tests Only | Unrelated Code | Grounded App Code |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `cypress-rwa` | 49 | 48/49 (98.0%) | **99.7%** | 0.21 ms | 0.39 ms | 28 | 7 | 13 | 1 |
| `horilla` | 50 | 44/50 (88.0%) | **96.0%** | 0.17 ms | 0.33 ms | 2 | 2 | 40 | 6 |
| **Combined** | **99** | **92/99 (92.9%)** | **98.5%** | --- | --- | --- | --- | --- | --- |
