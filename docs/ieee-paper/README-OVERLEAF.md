# Overleaf Compilation Guide — IEEE Research Paper Package

This directory is a self-contained, upload-ready Overleaf project formatted in standard two-column IEEE Conference style (`\documentclass[conference]{IEEEtran}`).

## Contents

- `main.tex` — Complete manuscript (Abstract, Sections I–VIII, Tables I–V, Figures 1–5, exact Wilson 95% CIs & non-parametric statistical tests).
- `references.bib` — Verified BibTeX citations (`IEEEtran` bibliography style).
- `figures/` — All 5 data-driven publication figures in 3 formats:
  - `*.pdf` — Crisp vector PDFs included directly by `main.tex` (`\includegraphics[width=\textwidth]{figures/fig*.pdf}`).
  - `*.png` — 300-DPI PNGs for Word, Google Docs, and presentation slides.
  - `*.svg` — Editable deterministic SVG sources compiled from verified CSV/JSON artifacts.

## 1-Minute Upload to Overleaf

1. Zip the entire `docs/ieee-paper/` directory (preserving `main.tex`, `references.bib`, and `figures/*.pdf`).
2. Open [Overleaf](https://www.overleaf.com/) → **New Project → Upload Project** → select the zip file.
3. In Overleaf **Menu**:
   - **Compiler:** `pdfLaTeX`
   - **Main document:** `main.tex`
4. Update the `\author{...}` block in `main.tex` (`[Author Name]`, `[Department]`, `[University Name]`, email) and click **Recompile**.

## Regenerating Figures Deterministically (`0-LLM`)

If any CSV under `docs/thesis-evaluation/` is updated in future work, regenerate all 5 figures (`SVG`, `PDF`, `PNG`) deterministically with:

```powershell
.\node_modules\.bin\tsx.cmd scripts\skill-graph-export-figures.ts
```
