# Phase A Ablation Report — White-Box Core Upgrades (Before vs. After)

Compares the **Phase 0–4 Baseline** (keyword-grep `codeRefs`, single-shot `k = 1` healer, flat 55-element DOM snapshot) against **Phase A** (plugin-based Static Route-to-Code Grounder, bounded `k ≤ 2` verifier-feedback healer, active `[MODAL]`-prioritized DOM snapshot + full path/HTMX telemetry), while keeping original `EvoBench-24` artifacts preserved intact.

## 1. Static Route-to-Code Grounding & Multi-Stage Authoring (Before vs. After)

| Skill ID | App | Authoring (Before) | Authoring (After — Phase A) | `codeRefs` Precision (Before) | `codeRefs` Precision (After) |
|---|---|---|---|---:|---:|
| `tx.comment` | `cypress-rwa` | AUTHORED_AND_VERIFIED | **AUTHORED_AND_VERIFIED** (`VERIFIED_PASS`) | 3/6 (50%) | **4/6 (66.7%)** |
| `user.settings_update` | `cypress-rwa` | AUTHORED_AND_VERIFIED | **AUTHORED_AND_VERIFIED** (`VERIFIED_PASS`) | 1/6 (16.7%) | **3/3 (100%)** |
| `work_type.create` | `horilla` | AUTHORED_AND_VERIFIED | **AUTHORED_AND_VERIFIED** (`VERIFIED_PASS`) | 2/6 (33.3%) | **5/6 (83.3%)** |
| `department.delete` | `horilla` | AUTHOR_FAILED | **AUTHORED_AND_VERIFIED** (`VERIFIED_PASS`) | 0/6 (0%) | **5/6 (83.3%)** |
| **Overall Micro-Average** | **2 Stacks** | **3/4 (75.0%)** | **4/4 (100.0%)** | **6/24 (25%)** | **17/21 (81%)** |

### Grounded Source Files Discovered in Phase A
- `tx.comment` (TsWebRouteGrounder): `src/components/CommentForm.tsx`, `backend/comment-routes.ts`, `src/components/TransactionPersonalList.tsx`, `src/containers/TransactionDetailContainer.tsx`, `src/components/TransactionContactsList.tsx`, `src/components/TransactionDetail.tsx`
- `user.settings_update` (TsWebRouteGrounder): `src/components/UserSettingsForm.tsx`, `backend/user-routes.ts`, `src/containers/UserSettingsContainer.tsx`
- `work_type.create` (DjangoRouteGrounder): `base/cbv/work_type_request.py`, `base/templates/base/work_type/work_type.html`, `horilla_theme/templates/generic/form.html`, `horilla_theme/templates/generic/horilla_nav.html`, `horilla_theme/templates/generic/inline_nav.html`, `horilla_views/templates/generic/messages.html`
- `department.delete` (DjangoRouteGrounder): `base/cbv/department.py`, `base/views.py`, `horilla_views/views.py`, `base/templates/base/department/department.html`, `horilla_theme/templates/generic/delete_confirmation.html`, `horilla_views/templates/generic/messages.html`

## 2. Bounded Feedback-Driven Self-Healing (`k ≤ 2`) on `HOR-D1` & `HOR-B1` Safety Check

| Case | Before (`k = 1`) | After (`k ≤ 2` Phase A) | Safety / Verification Outcome |
|---|---|---|---|
| `HOR-D1` (`SKILL_DRIFT`, `login.html` button rename) | `HEAL_REJECTED_BY_VERIFIER` (`1` call) | **`HEALED_AND_VERIFIED`** (`attempts=1`, `calls=1`) | Post-heal 3-skill `0-LLM` replay: **VERIFIED_PASS (6944ms)** |
| `HOR-B1` (`PRODUCT_BUG`, silent `form.save()` omission) | `REFUSED_PRODUCT_BUG` (`0` calls) | **`REFUSED_PRODUCT_BUG`** (`attempts=0`, `calls=0`) | Hard refusal invariant preserved (**0 LLM calls, 0% FHR**) |

## 3. Overleaf IEEE `booktabs` LaTeX Table Snippet

```latex
\begin{table*}[t]
\centering
\caption{Phase A Ablation: Static Route-to-Code Grounding Precision and Multi-Stage Authoring (Before vs. After)}
\label{tab:phase-a-ablation}
\begin{tabular}{llrrll}
\toprule
Skill ID & Stack & Grounding Prec. (Before) & Grounding Prec. (After) & Author (Before) & Author (After) \\
\midrule
\texttt{tx.comment} & React & 50\% (3/6) & 66.7\% (4/6) & AUTHORED\_AND\_VERIFIED & AUTHORED\_AND\_VERIFIED \\
\texttt{user.settings\_update} & React & 16.7\% (1/6) & 100\% (3/3) & AUTHORED\_AND\_VERIFIED & AUTHORED\_AND\_VERIFIED \\
\texttt{work\_type.create} & Django & 33.3\% (2/6) & 83.3\% (5/6) & AUTHORED\_AND\_VERIFIED & AUTHORED\_AND\_VERIFIED \\
\texttt{department.delete} & Django & 0\% (0/6) & 83.3\% (5/6) & AUTHOR\_FAILED & AUTHORED\_AND\_VERIFIED \\
\midrule
\textbf{Overall} & 2 Stacks & 25\% (6/24) & \textbf{81\% (17/21)} & 75.0\% (3/4) & \textbf{100.0\% (4/4)} \\
\bottomrule
\end{tabular}
\end{table*}
```
