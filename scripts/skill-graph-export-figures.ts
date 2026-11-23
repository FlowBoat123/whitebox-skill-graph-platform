import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { generateAllPhaseDFigures } from "../benchmarks/skill-graph/figure-generator.js";

const REPO_ROOT = process.cwd();
const EVAL_DIR = path.join(REPO_ROOT, "docs", "thesis-evaluation");
const RAW_DIR = path.join(REPO_ROOT, "runtime", "thesis-benchmark");
const OUT_DIR = path.join(REPO_ROOT, "docs", "ieee-paper", "figures");

async function launchBrowser() {
  for (const channel of ["msedge", "chrome", undefined] as const) {
    try {
      return await chromium.launch({
        headless: true,
        ...(channel ? { channel } : {}),
      });
    } catch {
      // Try next channel
    }
  }
  throw new Error("Unable to launch headless Chromium/Edge via playwright-core.");
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const figures = generateAllPhaseDFigures({ evalDir: EVAL_DIR, rawDir: RAW_DIR });
  const browser = await launchBrowser();
  try {
    const written: Array<{ id: string; svgBytes: number; pdfBytes: number; pngBytes: number }> = [];
    for (const fig of figures) {
      const svgPath = path.join(OUT_DIR, `${fig.id}.svg`);
      const pdfPath = path.join(OUT_DIR, `${fig.id}.pdf`);
      const pngPath = path.join(OUT_DIR, `${fig.id}.png`);

      fs.writeFileSync(svgPath, fig.svg, "utf8");

      const context = await browser.newContext({
        viewport: { width: fig.widthPx, height: fig.heightPx },
        deviceScaleFactor: 3, // Crisp ~300 DPI raster export
      });
      const page = await context.newPage();
      const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    @page { size: ${fig.widthPx}px ${fig.heightPx}px; margin: 0; }
    html, body { margin: 0; padding: 0; width: ${fig.widthPx}px; height: ${fig.heightPx}px; overflow: hidden; background: #ffffff; }
    svg { display: block; width: ${fig.widthPx}px; height: ${fig.heightPx}px; }
  </style>
</head>
<body>${fig.svg}</body>
</html>`;
      await page.setContent(html, { waitUntil: "load" });
      await page.screenshot({ path: pngPath, type: "png" });
      await page.pdf({
        path: pdfPath,
        width: `${fig.widthPx}px`,
        height: `${fig.heightPx}px`,
        printBackground: true,
        preferCSSPageSize: true,
        margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
      });
      await context.close();

      written.push({
        id: fig.id,
        svgBytes: fs.statSync(svgPath).size,
        pdfBytes: fs.statSync(pdfPath).size,
        pngBytes: fs.statSync(pngPath).size,
      });
    }
    console.log("Exported IEEE publication figures to:", OUT_DIR);
    for (const w of written) {
      console.log(`  - ${w.id}: svg=${w.svgBytes}B pdf=${w.pdfBytes}B png=${w.pngBytes}B`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
