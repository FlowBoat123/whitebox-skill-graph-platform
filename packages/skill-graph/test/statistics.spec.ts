import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  cliffsDelta,
  fisherExactTwoSided,
  formatPValue,
  mannWhitneyU,
  mcnemarExactTwoSided,
  wilsonCI95,
} from "../../../benchmarks/skill-graph/statistics.js";
import { EVOBENCH_48 } from "../../../benchmarks/skill-graph/evobench-48.js";
import { evaluateRealGitHistory } from "../../../benchmarks/skill-graph/real-git-benchmark.js";
import { createSkillValidator, planToReach } from "../src/index.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const RWA_SANDBOX = path.join(REPO_ROOT, "runtime/sandboxes/cypress-realworld-app");
const HORILLA_SANDBOX = path.join(REPO_ROOT, "runtime/sandboxes/horilla");

describe("Phase C pure-TS statistical engine & EvoBench-48 integrity", () => {
  it("computes accurate Wilson 95% CIs, Fisher exact, Exact McNemar, Mann-Whitney U, and Cliff's delta", () => {
    // Wilson 95% CI on 25/25 (100%): lower bound ~86.68%, upper 100%
    const ci100 = wilsonCI95(25, 25);
    expect(ci100.ratePct).toBe(100);
    expect(ci100.lowerPct).toBeGreaterThan(86);
    expect(ci100.lowerPct).toBeLessThan(88);
    expect(ci100.upperPct).toBe(100);

    // Wilson 95% CI on 0/20 (0%): upper bound ~16.11%
    const ci0 = wilsonCI95(0, 20);
    expect(ci0.ratePct).toBe(0);
    expect(ci0.lowerPct).toBe(0);
    expect(ci0.upperPct).toBeGreaterThan(15);
    expect(ci0.upperPct).toBeLessThan(17.5);

    // Fisher exact: RQ1 25/25 vs 11/15 -> a=25, b=0, c=11, d=4 -> p = C(15,4)/C(40,4) ≈ 0.0149
    const pRq1 = fisherExactTwoSided(25, 0, 11, 4);
    expect(pRq1).toBeGreaterThan(0.01);
    expect(pRq1).toBeLessThan(0.02);

    // Fisher exact: 0/20 vs 10/20 -> highly significant p < 0.001
    const pSafety = fisherExactTwoSided(0, 20, 10, 10);
    expect(pSafety).toBeLessThan(0.001);
    expect(formatPValue(pSafety)).toBe("< 0.001");

    // Exact McNemar: b=8, c=0 -> 2 * (0.5^8) = 0.0078125
    expect(mcnemarExactTwoSided(8, 0)).toBeCloseTo(0.0078125, 6);
    // Exact McNemar: b=16, c=0 -> 2 * (0.5^16) ≈ 0.00003052
    expect(mcnemarExactTwoSided(16, 0)).toBeLessThan(0.0001);
    expect(mcnemarExactTwoSided(0, 0)).toBe(1);

    // Mann-Whitney U + Cliff's delta on strictly separated latency distributions
    const fast = [4.1, 4.5, 4.9, 5.0, 5.2, 5.4, 5.8, 6.0];
    const slow = [80.0, 92.5, 98.1, 102.3, 110.0, 115.4, 120.2, 130.0];
    const mw = mannWhitneyU(fast, slow);
    expect(mw.u).toBe(0);
    expect(mw.pValue).toBeLessThan(0.002);
    const cd = cliffsDelta(fast, slow);
    expect(cd.delta).toBe(-1);
    expect(cd.magnitude).toBe("large");
  });

  it("verifies all 48 EvoBench-48 mutations have unique IDs, valid source anchors, and valid skill plans offline", () => {
    expect(EVOBENCH_48.length).toBe(48);
    const ids = new Set(EVOBENCH_48.map((m) => m.id));
    expect(ids.size).toBe(48);
    expect(EVOBENCH_48.filter((m) => m.category === "SKILL_DRIFT").length).toBe(16);
    expect(EVOBENCH_48.filter((m) => m.category === "PRODUCT_BUG").length).toBe(20);
    expect(EVOBENCH_48.filter((m) => m.category === "NO_IMPACT").length).toBe(12);

    const validator = createSkillValidator();
    const rwaSkills = validator.validateDirectory(path.join(REPO_ROOT, "skills/cypress-rwa")).skills.map((s) => s.skill);
    const horSkills = validator.validateDirectory(path.join(REPO_ROOT, "skills/horilla")).skills.map((s) => s.skill);

    const rwaActors = { Heath93: { password: "s3cret" }, Arvilla_Hegmann: { password: "s3cret" } };
    const horActors = { hr_admin: { password: "demo" } };

    for (const spec of EVOBENCH_48) {
      // Check verifyGoal resolves via planToReach for all Category A & B mutations
      if (spec.category !== "NO_IMPACT") {
        expect(spec.verifyGoal).toBeDefined();
        const skills = spec.app === "cypress-rwa" ? rwaSkills : horSkills;
        const plan = planToReach({
          skills,
          goal: spec.verifyGoal!,
          bindings:
            spec.app === "cypress-rwa"
              ? {
                  user: "Heath93",
                  sender: "Heath93",
                  receiver: "Arvilla_Hegmann",
                  receiverName: "Kristian Bradtke",
                  amount: "25",
                  note: "Check",
                  bankName: "Bank",
                  routingNumber: "123456789",
                  accountNumber: "123456789",
                  commentText: "Note",
                  decisionLabel: "Accept Request",
                  ...(spec.extraBindings ?? {}),
                }
              : {
                  user: "hr_admin",
                  username: "hr_admin",
                  department: "Dept",
                  employeeType: "Full",
                  ...(spec.extraBindings ?? {}),
                },
          actorBindings: spec.app === "cypress-rwa" ? rwaActors : horActors,
        });
        expect(plan.steps.length).toBeGreaterThan(0);
      }

      // Check exact source file mutation anchor matches cleanly in-memory without touching disk
      const sandbox = spec.app === "cypress-rwa" ? RWA_SANDBOX : HORILLA_SANDBOX;
      if (fs.existsSync(sandbox)) {
        const full = path.join(sandbox, spec.targetFile);
        expect(fs.existsSync(full), `Missing targetFile for ${spec.id}: ${spec.targetFile}`).toBe(true);
        const orig = fs.readFileSync(full, "utf8");
        const mutated = spec.mutate(orig);
        expect(mutated, `Mutation ${spec.id} did not change ${spec.targetFile}`).not.toBe(orig);
      }
    }
  });

  it("replays real upstream git commits read-only deterministically when sandbox is present", () => {
    if (!fs.existsSync(RWA_SANDBOX)) return;
    const rwaSkills = createSkillValidator().validateDirectory(path.join(REPO_ROOT, "skills/cypress-rwa")).skills;
    const rep1 = evaluateRealGitHistory({
      app: "cypress-rwa",
      repoPath: RWA_SANDBOX,
      skills: rwaSkills,
      maxCommits: 10,
    });
    const rep2 = evaluateRealGitHistory({
      app: "cypress-rwa",
      repoPath: RWA_SANDBOX,
      skills: rwaSkills,
      maxCommits: 10,
    });
    expect(rep1.commitsAnalyzed).toBeGreaterThan(0);
    expect(rep1.testReductionRatePct).toBeGreaterThanOrEqual(0);
    expect(rep1.testReductionRatePct).toBeLessThanOrEqual(100);
    expect(rep1.commits.map((c) => c.sha)).toEqual(rep2.commits.map((c) => c.sha));
    expect(rep1.commits.map((c) => c.impactedSkillIds)).toEqual(rep2.commits.map((c) => c.impactedSkillIds));
  });
});
