import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { interpolateTemplate } from "./validator.js";
import type {
  BugEvidenceBundle,
  ConsoleTelemetryEvent,
  DriftEvidence,
  ExecutionVerdict,
  HttpTelemetryEvent,
  PlanExecutionReport,
  Postcondition,
  PostconditionReceipt,
  SemanticTarget,
  SkillDefinition,
  SkillExecutionReport,
  SkillPlan,
  SkillStep,
  StepExecutionReceipt,
} from "./types.js";

export interface ExecutorOptions {
  baseUrl: string;
  /** Optional separate API origin allowed in network telemetry (e.g. http://localhost:3001). */
  apiBaseUrl?: string;
  headless?: boolean;
  channel?: "msedge" | "chrome" | "chromium";
  stepTimeoutMs?: number;
  evidenceDir?: string;
}

const INTERACTIVE_LABELED_SELECTOR =
  "input, textarea, select, button, a, [role='checkbox'], [role='radio'], [role='textbox'], [role='combobox'], [role='switch'], [role='button'], [role='link'], [contenteditable='true']";

const TOUR_OVERLAY_CLOSE_SELECTOR =
  ".driver-popover-close-btn, .introjs-skipbutton, .shepherd-cancel-icon";

/**
 * Dismiss unsolicited third-party onboarding tour overlays (Driver.js, Intro.js, Shepherd.js)
 * that asynchronously inject full-screen pointer-blocking backdrops over active forms/modals.
 */
export async function dismissBlockingTourOverlay(page: Page): Promise<boolean> {
  try {
    const closeBtn = page.locator(TOUR_OVERLAY_CLOSE_SELECTOR).first();
    if (await closeBtn.isVisible({ timeout: 50 }).catch(() => false)) {
      await closeBtn.click({ timeout: 1500 }).catch(() => undefined);
      await page.waitForTimeout(150);
      return true;
    }
  } catch {
    // Ignore transient navigation races
  }
  return false;
}

function buildLocator(
  root: Page | Locator,
  target: SemanticTarget,
  params: Record<string, string>,
): Locator {
  const val = interpolateTemplate(target.value, params);
  switch (target.strategy) {
    case "role": {
      if (!target.role) {
        throw new Error("Target with strategy='role' requires role.");
      }
      return root.getByRole(target.role, {
        name: val,
        exact: target.exact ?? false,
      });
    }
    case "label":
      // Intersect with interactive/form controls so container wrappers with self-referential
      // aria-labelledby (e.g. <div role="dialog" aria-labelledby="selfId">) never shadow inner inputs.
      return root
        .getByLabel(val, { exact: target.exact ?? false })
        .and(root.locator(INTERACTIVE_LABELED_SELECTOR));
    case "placeholder":
      return root.getByPlaceholder(val, { exact: target.exact ?? false });
    case "text":
      return root.getByText(val, { exact: target.exact ?? false });
    case "testid":
      return root.locator(`[data-test="${val}"], [data-testid="${val}"]`);
    case "title":
      return root.getByTitle(val, { exact: target.exact ?? false });
  }
}

export function resolveTarget(
  page: Page,
  target: SemanticTarget,
  params: Record<string, string>,
): Locator {
  const scope: Page | Locator = target.containerText
    ? page
        .locator("li, tr, article, section, [role='listitem'], [role='row'], div")
        .filter({ hasText: interpolateTemplate(target.containerText, params) })
        .filter({ has: buildLocator(page, target, params) })
        .last()
    : page;

  const loc = buildLocator(scope, target, params);
  return target.index !== undefined ? loc.nth(target.index) : loc.filter({ visible: true }).first();
}

async function captureInteractiveSnapshot(page: Page): Promise<string[]> {
  try {
    return await page.evaluate(() => {
      const selector =
        "a, button, input, textarea, select, [role='button'], [role='link'], [role='tab'], [role='listitem'], h1, h2, h3";
      const modalCandidates = Array.from(
        document.querySelectorAll(
          ".oh-modal--show, .modal.show, dialog[open], [role='dialog'][aria-modal='true'], [data-state='open'][role='dialog']",
        ),
      ).filter((m) => {
        const r = m.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const activeModal = modalCandidates.at(-1) ?? null;

      const pairs: Array<[Element, string]> = [];
      const seen = new Set<Element>();
      if (activeModal) {
        for (const el of Array.from(activeModal.querySelectorAll(selector))) {
          seen.add(el);
          pairs.push([el, "[MODAL] "]);
        }
      }
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (!seen.has(el)) pairs.push([el, ""]);
      }

      const out: string[] = [];
      for (const [el, prefix] of pairs) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const tag = el.tagName.toLowerCase();
        const inputType = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : "";
        const role =
          el.getAttribute("role") ||
          (inputType === "checkbox" ? "checkbox" : inputType === "radio" ? "radio" : tag);
        const id = el.getAttribute("id") || "";
        let assocLabel = "";
        if (id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lbl) assocLabel = (lbl.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
        }
        const label =
          el.getAttribute("aria-label") ||
          assocLabel ||
          el.getAttribute("placeholder") ||
          (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
        const title = el.getAttribute("title") || "";
        const testId = el.getAttribute("data-test") || el.getAttribute("data-testid") || "";
        const disabled = (el as HTMLButtonElement).disabled ? " [disabled]" : "";
        if (!label && !title && !testId) continue;
        out.push(
          `${prefix}${role} | "${label}"${title ? ` | title="${title}"` : ""}${testId ? ` | data-test=${testId}` : ""}${disabled}`,
        );
        if (out.length >= 60) break;
      }
      return out;
    });
  } catch {
    return [];
  }
}

function sameOriginAllowed(currentUrl: string, baseUrl: string): boolean {
  try {
    return new URL(currentUrl).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

export async function evaluatePostcondition(
  page: Page,
  post: Postcondition,
  params: Record<string, string>,
  httpEvents: HttpTelemetryEvent[],
  consoleErrors: ConsoleTelemetryEvent[],
): Promise<PostconditionReceipt> {
  switch (post.kind) {
    case "HTTP_STATUS": {
      const expectedPath = interpolateTemplate(post.path!, params);
      const matching = httpEvents.filter(
        (ev) => ev.method === post.method && ev.path.startsWith(expectedPath),
      );
      const hit = matching.some((ev) => ev.status === post.expectStatus);
      return {
        kind: post.kind,
        passed: hit,
        detail: hit
          ? `Observed ${post.method} ${expectedPath} -> ${post.expectStatus}`
          : `Expected ${post.method} ${expectedPath} -> ${post.expectStatus}, observed statuses: [${matching.map((m) => `${m.path}:${m.status}`).join(", ")}]`,
      };
    }
    case "CONSOLE_ERRORS": {
      const count = consoleErrors.filter((e) => e.type === "console.error").length;
      const passed = count <= (post.maxCount ?? 0);
      return {
        kind: post.kind,
        passed,
        detail: `console.error count=${count} (max=${post.maxCount ?? 0})`,
      };
    }
    case "PAGE_ERRORS": {
      const count = consoleErrors.filter((e) => e.type === "pageerror").length;
      const passed = count <= (post.maxCount ?? 0);
      return {
        kind: post.kind,
        passed,
        detail: `pageerror count=${count} (max=${post.maxCount ?? 0})`,
      };
    }
    case "URL_MATCH": {
      const pattern = interpolateTemplate(post.pattern!, params);
      const current = page.url();
      const passed = new RegExp(pattern).test(current);
      return {
        kind: post.kind,
        passed,
        detail: `url='${current}' matches /${pattern}/ => ${passed}`,
      };
    }
    case "DOM_CONTAINS": {
      const needle = interpolateTemplate(post.text!, params);
      let passed = false;
      try {
        await page.getByText(needle, { exact: false }).first().waitFor({ state: "visible", timeout: 4000 });
        passed = true;
      } catch {
        const bodyText = await page.locator("body").innerText().catch(() => "");
        passed = bodyText.includes(needle);
      }
      return {
        kind: post.kind,
        passed,
        detail: passed ? `DOM contains '${needle}'` : `DOM missing expected text '${needle}'`,
      };
    }
    case "DOM_NOT_CONTAINS": {
      const needle = interpolateTemplate(post.text!, params);
      const deadline = Date.now() + 5000;
      let passed = false;
      while (Date.now() < deadline) {
        const bodyText = await page.locator("body").innerText().catch(() => "");
        if (!bodyText.includes(needle)) {
          passed = true;
          break;
        }
        await page.waitForTimeout(150);
      }
      return {
        kind: post.kind,
        passed,
        detail: passed ? `DOM does not contain '${needle}'` : `DOM unexpectedly contains '${needle}'`,
      };
    }
  }
}

async function launchBrowser(options: ExecutorOptions): Promise<Browser> {
  const headless = options.headless ?? true;
  if (options.channel === "chromium") {
    return chromium.launch({ headless });
  }
  const preferred = options.channel ?? (process.platform === "win32" ? "msedge" : "chrome");
  try {
    return await chromium.launch({ channel: preferred, headless });
  } catch {
    return chromium.launch({ headless });
  }
}

export async function executeSkillOnPage(
  page: Page,
  skill: SkillDefinition,
  params: Record<string, string>,
  options: ExecutorOptions,
): Promise<SkillExecutionReport> {
  const started = Date.now();
  const timeoutMs = options.stepTimeoutMs ?? 8000;
  const httpEvents: HttpTelemetryEvent[] = [];
  const consoleErrors: ConsoleTelemetryEvent[] = [];
  const stepReceipts: StepExecutionReceipt[] = [];

  const allowedOrigins = new Set<string>([new URL(options.baseUrl).origin]);
  if (options.apiBaseUrl) {
    allowedOrigins.add(new URL(options.apiBaseUrl).origin);
  }

  const onResponse = async (resp: import("playwright-core").Response) => {
    try {
      const u = new URL(resp.url());
      if (!allowedOrigins.has(u.origin)) return;
      // Skip Vite/HMR dev module asset fetches from HTTP telemetry noise (still keep 4xx/5xx!)
      if (
        resp.status() < 400 &&
        (u.pathname.startsWith("/node_modules/") ||
          u.pathname.startsWith("/@") ||
          u.pathname.startsWith("/src/") ||
          /\.(css|js|ts|tsx|svg|png|ico|woff2?|map)$/i.test(u.pathname))
      ) {
        return;
      }
      const ev: HttpTelemetryEvent = {
        method: resp.request().method(),
        path: u.pathname + u.search,
        status: resp.status(),
        timestampMs: Date.now() - started,
      };
      if (resp.status() >= 400) {
        const body = await resp.text().catch(() => "");
        ev.responseSnippet = body.slice(0, 300);
      }
      httpEvents.push(ev);
    } catch {
      // Ignore non-HTTP or aborted responses
    }
  };

  const onConsole = (msg: import("playwright-core").ConsoleMessage) => {
    if (msg.type() === "error") {
      const text = msg.text().trim();
      // React dev mode logs non-fatal deprecation/prop warnings via console.error("Warning: ...")
      if (text.startsWith("Warning:")) {
        return;
      }
      consoleErrors.push({
        type: "console.error",
        text: text.slice(0, 400),
        timestampMs: Date.now() - started,
      });
    }
  };

  const onPageError = (err: Error) => {
    consoleErrors.push({
      type: "pageerror",
      text: (err.stack || err.message).slice(0, 400),
      timestampMs: Date.now() - started,
    });
  };

  page.on("response", onResponse);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  let failedStep: {
    index: number;
    step: SkillStep;
    error: string;
    phase: "ACTION" | "EXPECTATION";
  } | null = null;

  try {
    for (let i = 0; i < skill.steps.length; i++) {
      const step = skill.steps[i]!;
      const stepStart = Date.now();
      const beforeUrl = page.url();
      let phase: "ACTION" | "EXPECTATION" = "ACTION";
      try {
        switch (step.op) {
          case "NAVIGATE": {
            const rel = interpolateTemplate(step.url!, params);
            const fullUrl = new URL(rel, options.baseUrl).toString();
            await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
            break;
          }
          case "CLICK": {
            await dismissBlockingTourOverlay(page);
            const loc = resolveTarget(page, step.target!, params);
            await loc.waitFor({ state: "visible", timeout: timeoutMs });
            try {
              await loc.click({ timeout: Math.min(timeoutMs, 4000) });
            } catch (clickErr) {
              // If an async onboarding tour overlay appeared mid-action, dismiss it and retry once
              if (await dismissBlockingTourOverlay(page)) {
                await loc.click({ timeout: timeoutMs });
              } else {
                throw clickErr;
              }
            }
            break;
          }
          case "FILL": {
            await dismissBlockingTourOverlay(page);
            const loc = resolveTarget(page, step.target!, params);
            const value = interpolateTemplate(step.value!, params);
            await loc.waitFor({ state: "visible", timeout: timeoutMs });
            await loc.fill(value, { timeout: timeoutMs });
            if (step.pressEnter) {
              await loc.press("Enter", { timeout: timeoutMs });
            }
            break;
          }
          case "PRESS": {
            const key = interpolateTemplate(step.value!, params);
            if (step.target) {
              const loc = resolveTarget(page, step.target, params);
              await loc.waitFor({ state: "visible", timeout: timeoutMs });
              await loc.press(key, { timeout: timeoutMs });
            } else {
              await page.keyboard.press(key);
            }
            break;
          }
          case "SELECT": {
            const loc = resolveTarget(page, step.target!, params);
            const value = interpolateTemplate(step.value!, params);
            await loc.waitFor({ state: "visible", timeout: timeoutMs });
            await loc.selectOption(value, { timeout: timeoutMs });
            break;
          }
          case "WAIT_URL": {
            phase = "EXPECTATION";
            const expectPattern = interpolateTemplate(step.expectUrl!, params);
            await page.waitForURL(new RegExp(expectPattern), {
              waitUntil: "domcontentloaded",
              timeout: timeoutMs,
            });
            break;
          }
          case "ASSERT_TEXT": {
            phase = "EXPECTATION";
            const loc = resolveTarget(page, step.target!, params);
            const expected = interpolateTemplate(step.value!, params);
            await loc.waitFor({ state: "visible", timeout: timeoutMs });
            const txt = await loc.innerText({ timeout: timeoutMs });
            if (!txt.includes(expected)) {
              throw new Error(`Expected text '${expected}' in target, got '${txt.slice(0, 120)}'`);
            }
            break;
          }
        }

        if (step.expectUrl && step.op !== "WAIT_URL") {
          phase = "EXPECTATION";
          const expectPattern = interpolateTemplate(step.expectUrl, params);
          await page.waitForURL(new RegExp(expectPattern), {
            waitUntil: "domcontentloaded",
            timeout: timeoutMs,
          });
        }

        // Enforce same-origin boundary so execution never drifts to external web origins
        const afterUrl = page.url();
        if (afterUrl !== "about:blank" && !sameOriginAllowed(afterUrl, options.baseUrl)) {
          throw new Error(`Navigation escaped allowed origin ${options.baseUrl}: landed on ${afterUrl}`);
        }

        stepReceipts.push({
          stepIndex: i,
          op: step.op,
          ok: true,
          durationMs: Date.now() - stepStart,
          beforeUrl,
          afterUrl,
          detail: step.note ?? `${step.op} succeeded`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        stepReceipts.push({
          stepIndex: i,
          op: step.op,
          ok: false,
          durationMs: Date.now() - stepStart,
          beforeUrl,
          afterUrl: page.url(),
          detail: message.slice(0, 300),
        });
        failedStep = { index: i, step, error: message, phase };
        break;
      }
    }

    // Small settle delay for async network responses & React state updates
    await page.waitForTimeout(350);

    const server5xx = httpEvents.filter((e) => e.status >= 500);
    const uncaughtPageErrors = consoleErrors.filter((e) => e.type === "pageerror");

    const saveScreenshot = async (suffix: string): Promise<string | undefined> => {
      if (!options.evidenceDir) return undefined;
      fs.mkdirSync(options.evidenceDir, { recursive: true });
      const file = path.join(options.evidenceDir, `${skill.id}-${suffix}-${Date.now()}.png`);
      await page.screenshot({ path: file, fullPage: true }).catch(() => undefined);
      return file.replace(/\\/g, "/");
    };

    if (failedStep) {
      // CRITICAL WHITE-BOX RULE:
      // 1. If a 5xx server crash or uncaught JS exception occurred -> PRODUCT_BUG.
      // 2. If the UI action itself succeeded (e.g. Save button clicked) and only the post-action
      //    expectation (expectUrl / ASSERT_TEXT) failed -> PRODUCT_BUG (the app failed to respond!),
      //    NEVER misclassify a broken submit/transition handler as SKILL_DRIFT!
      if (
        server5xx.length > 0 ||
        uncaughtPageErrors.length > 0 ||
        failedStep.phase === "EXPECTATION"
      ) {
        const screenshotPath = await saveScreenshot("bug");
        const bug: BugEvidenceBundle = {
          skillId: skill.id,
          summary:
            failedStep.phase === "EXPECTATION" && server5xx.length === 0 && uncaughtPageErrors.length === 0
              ? `Post-action expectation failed at step ${failedStep.index} (${failedStep.step.op}): ${failedStep.error.slice(0, 220)}`
              : `Runtime crash during step ${failedStep.index} (${failedStep.step.op}): ${server5xx.length} HTTP 5xx, ${uncaughtPageErrors.length} uncaught JS errors.`,
          failedPostconditions: [],
          httpErrors: httpEvents.filter((e) => e.status >= 400),
          consoleErrors: [...consoleErrors],
          currentUrl: page.url(),
          codeRefs: skill.codeRefs,
          ...(screenshotPath ? { screenshotPath } : {}),
          origin: "OBSERVED_DETERMINISTIC",
        };
        return {
          skillId: skill.id,
          verdict: "PRODUCT_BUG",
          durationMs: Date.now() - started,
          llmCallsUsed: 0,
          steps: stepReceipts,
          postconditions: [],
          httpEvents,
          consoleErrors,
          bug,
        };
      }

      const screenshotPath = await saveScreenshot("drift");
      const interactiveSnapshot = await captureInteractiveSnapshot(page);
      const drift: DriftEvidence = {
        skillId: skill.id,
        failedStepIndex: failedStep.index,
        op: failedStep.step.op,
        ...(failedStep.step.target ? { target: failedStep.step.target } : {}),
        currentUrl: page.url(),
        errorMessage: failedStep.error.slice(0, 400),
        interactiveSnapshot,
        codeRefs: skill.codeRefs,
        ...(screenshotPath ? { screenshotPath } : {}),
      };
      return {
        skillId: skill.id,
        verdict: "SKILL_DRIFT",
        durationMs: Date.now() - started,
        llmCallsUsed: 0,
        steps: stepReceipts,
        postconditions: [],
        httpEvents,
        consoleErrors,
        drift,
      };
    }

    // Evaluate deterministic postconditions
    const postReceipts: PostconditionReceipt[] = [];
    for (const post of skill.postconditions) {
      postReceipts.push(
        await evaluatePostcondition(page, post, params, httpEvents, consoleErrors),
      );
    }

    const failedPosts = postReceipts.filter((p) => !p.passed);
    const hasUnexpected5xx = server5xx.length > 0;
    const verdict: ExecutionVerdict =
      failedPosts.length === 0 && !hasUnexpected5xx ? "VERIFIED_PASS" : "PRODUCT_BUG";

    if (verdict === "PRODUCT_BUG") {
      const screenshotPath = await saveScreenshot("bug");
      const bug: BugEvidenceBundle = {
        skillId: skill.id,
        summary:
          failedPosts.length > 0
            ? `Postcondition failure on '${skill.id}': ${failedPosts.map((p) => p.detail).join("; ")}`
            : `Unexpected HTTP 5xx observed on '${skill.id}': ${server5xx.map((e) => `${e.method} ${e.path}=${e.status}`).join(", ")}`,
        failedPostconditions: failedPosts,
        httpErrors: httpEvents.filter((e) => e.status >= 400),
        consoleErrors: [...consoleErrors],
        currentUrl: page.url(),
        codeRefs: skill.codeRefs,
        ...(screenshotPath ? { screenshotPath } : {}),
        origin: "OBSERVED_DETERMINISTIC",
      };
      return {
        skillId: skill.id,
        verdict,
        durationMs: Date.now() - started,
        llmCallsUsed: 0,
        steps: stepReceipts,
        postconditions: postReceipts,
        httpEvents,
        consoleErrors,
        bug,
      };
    }

    return {
      skillId: skill.id,
      verdict: "VERIFIED_PASS",
      durationMs: Date.now() - started,
      llmCallsUsed: 0,
      steps: stepReceipts,
      postconditions: postReceipts,
      httpEvents,
      consoleErrors,
    };
  } finally {
    page.off("response", onResponse);
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  }
}

export async function executePlan(
  plan: SkillPlan,
  skillsById: Map<string, SkillDefinition>,
  options: ExecutorOptions,
): Promise<PlanExecutionReport> {
  const started = Date.now();
  const browser = await launchBrowser(options);
  const reports: SkillExecutionReport[] = [];
  let verdict: ExecutionVerdict = "VERIFIED_PASS";
  let failedSkillId: string | undefined;

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    for (const call of plan.steps) {
      const skill = skillsById.get(call.skillId);
      if (!skill) {
        verdict = "INFRA_ERROR";
        failedSkillId = call.skillId;
        break;
      }
      const report = await executeSkillOnPage(page, skill, call.params, options);
      reports.push(report);
      if (report.verdict !== "VERIFIED_PASS") {
        verdict = report.verdict;
        failedSkillId = call.skillId;
        break;
      }
    }
    await context.close();
  } finally {
    await browser.close();
  }

  return {
    goal: plan.goal,
    verdict,
    totalDurationMs: Date.now() - started,
    llmCallsUsed: 0,
    skillReports: reports,
    ...(failedSkillId ? { failedSkillId } : {}),
  };
}
