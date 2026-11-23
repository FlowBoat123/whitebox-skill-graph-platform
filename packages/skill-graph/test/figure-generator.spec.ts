import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateAllPhaseDFigures } from "../../../benchmarks/skill-graph/figure-generator.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const EVAL_DIR = path.join(REPO_ROOT, "docs", "thesis-evaluation");
const RAW_DIR = path.join(REPO_ROOT, "runtime", "thesis-benchmark");

describe("Phase D IEEE publication figure compiler", () => {
  it("generates all 5 deterministic, well-formed SVGs with zero NaN/Infinity tokens", () => {
    const run1 = generateAllPhaseDFigures({ evalDir: EVAL_DIR, rawDir: RAW_DIR });
    const run2 = generateAllPhaseDFigures({ evalDir: EVAL_DIR, rawDir: RAW_DIR });

    expect(run1).toHaveLength(5);
    expect(run1.map((f) => f.id)).toEqual([
      "fig1-architecture",
      "fig2-rq1-amortization",
      "fig3-evobench48-ablation",
      "fig4-multimodel-panel",
      "fig5-realgit-and-grounding",
    ]);

    for (let i = 0; i < run1.length; i++) {
      const f = run1[i]!;
      const f2 = run2[i]!;
      expect(f.svg).toBe(f2.svg);
      expect(f.svg).toContain("<svg ");
      expect(f.svg).toContain("</svg>");
      expect(f.svg).not.toMatch(/\bNaN\b|\bInfinity\b|\bundefined\b/);
      expect(f.widthPx).toBe(720);
      expect(f.heightPx).toBeGreaterThanOrEqual(250);
    }
  });

  it("embeds exact verified empirical metrics from CSV/JSON evaluation artifacts", () => {
    const figs = new Map(generateAllPhaseDFigures({ evalDir: EVAL_DIR, rawDir: RAW_DIR }).map((f) => [f.id, f.svg]));

    expect(figs.get("fig1-architecture")).toContain("CLOSED LOOP");
    expect(figs.get("fig2-rq1-amortization")).toContain("-98.5% cost at N=100");
    expect(figs.get("fig2-rq1-amortization")).toContain("p &lt; 0.001");
    expect(figs.get("fig3-evobench48-ablation")).toContain("100.0%");
    expect(figs.get("fig3-evobench48-ablation")).toContain("p = 0.0078");
    expect(figs.get("fig3-evobench48-ablation")).toContain("60% (12/20)");
    expect(figs.get("fig4-multimodel-panel")).toContain("DeepSeek-V3.2");
    expect(figs.get("fig4-multimodel-panel")).toContain("Gemini-2.5-Flash");
    expect(figs.get("fig4-multimodel-panel")).toContain("GPT-4o-mini");
    expect(figs.get("fig4-multimodel-panel")).toContain("$0.0038");
    expect(figs.get("fig5-realgit-and-grounding")).toContain("98.5% Reduction");
    expect(figs.get("fig5-realgit-and-grounding")).toContain("81%");
  });
});
