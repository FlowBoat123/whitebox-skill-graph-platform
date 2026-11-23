export type InputType = "string" | "number" | "boolean";

export interface StatePredicate {
  name: string;
  singleton?: boolean;
  params?: Record<string, string>;
}

export interface InputSpec {
  type: InputType;
  required: boolean;
  default?: string;
  sensitive?: boolean;
}

export type SemanticStrategy = "role" | "label" | "placeholder" | "text" | "testid" | "title";

export type AriaRole =
  | "button"
  | "link"
  | "textbox"
  | "checkbox"
  | "radio"
  | "combobox"
  | "listitem"
  | "tab"
  | "menuitem"
  | "heading";

export interface SemanticTarget {
  strategy: SemanticStrategy;
  role?: AriaRole;
  value: string;
  exact?: boolean;
  containerText?: string;
  index?: number;
}

export type StepOp =
  | "NAVIGATE"
  | "CLICK"
  | "FILL"
  | "PRESS"
  | "SELECT"
  | "WAIT_URL"
  | "ASSERT_TEXT";

export interface SkillStep {
  op: StepOp;
  url?: string;
  target?: SemanticTarget;
  value?: string;
  pressEnter?: boolean;
  expectUrl?: string;
  note?: string;
}

export type PostconditionKind =
  | "HTTP_STATUS"
  | "CONSOLE_ERRORS"
  | "PAGE_ERRORS"
  | "URL_MATCH"
  | "DOM_CONTAINS"
  | "DOM_NOT_CONTAINS";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface Postcondition {
  kind: PostconditionKind;
  method?: HttpMethod;
  path?: string;
  expectStatus?: number;
  maxCount?: number;
  pattern?: string;
  text?: string;
}

export interface CodeRefs {
  routes: string[];
  endpoints: string[];
  sourceFiles: string[];
}

export interface SkillDefinition {
  schemaVersion: 1;
  id: string;
  app: string;
  description: string;
  preconditions: StatePredicate[];
  produces: StatePredicate[];
  clears?: string[];
  inputs: Record<string, InputSpec>;
  codeRefs: CodeRefs;
  steps: SkillStep[];
  postconditions: Postcondition[];
}

export interface LoadedSkill {
  filePath: string;
  skill: SkillDefinition;
}

export interface ValidationDiagnostic {
  filePath: string;
  path: string;
  code: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  skills: LoadedSkill[];
  diagnostics: ValidationDiagnostic[];
}

export interface ConcreteFact {
  name: string;
  singleton: boolean;
  params: Record<string, string>;
}

export interface PlannedSkillCall {
  skillId: string;
  params: Record<string, string>;
  produces: ConcreteFact[];
  clears: string[];
}

export interface SkillPlan {
  goal: ConcreteFact;
  steps: PlannedSkillCall[];
  totalSkills: number;
  llmCallsUsed: 0;
}

export interface HttpTelemetryEvent {
  method: string;
  path: string;
  status: number;
  timestampMs: number;
  responseSnippet?: string;
}

export interface ConsoleTelemetryEvent {
  type: "console.error" | "pageerror";
  text: string;
  timestampMs: number;
}

export interface StepExecutionReceipt {
  stepIndex: number;
  op: StepOp;
  ok: boolean;
  durationMs: number;
  beforeUrl: string;
  afterUrl: string;
  detail: string;
}

export interface PostconditionReceipt {
  kind: PostconditionKind;
  passed: boolean;
  detail: string;
}

export type ExecutionVerdict =
  | "VERIFIED_PASS"
  | "SKILL_DRIFT"
  | "PRODUCT_BUG"
  | "INFRA_ERROR";

export interface DriftEvidence {
  skillId: string;
  failedStepIndex: number;
  op: StepOp;
  target?: SemanticTarget;
  currentUrl: string;
  errorMessage: string;
  interactiveSnapshot: string[];
  codeRefs: CodeRefs;
  screenshotPath?: string;
}

export interface BugEvidenceBundle {
  skillId: string;
  summary: string;
  failedPostconditions: PostconditionReceipt[];
  httpErrors: HttpTelemetryEvent[];
  consoleErrors: ConsoleTelemetryEvent[];
  currentUrl: string;
  codeRefs: CodeRefs;
  screenshotPath?: string;
  origin: "OBSERVED_DETERMINISTIC";
}

export interface SkillExecutionReport {
  skillId: string;
  verdict: ExecutionVerdict;
  durationMs: number;
  llmCallsUsed: 0;
  steps: StepExecutionReceipt[];
  postconditions: PostconditionReceipt[];
  httpEvents: HttpTelemetryEvent[];
  consoleErrors: ConsoleTelemetryEvent[];
  drift?: DriftEvidence;
  bug?: BugEvidenceBundle;
}

export interface PlanExecutionReport {
  goal: ConcreteFact;
  verdict: ExecutionVerdict;
  totalDurationMs: number;
  llmCallsUsed: 0;
  skillReports: SkillExecutionReport[];
  failedSkillId?: string;
}

export interface ImpactMatch {
  skillId: string;
  filePath: string;
  matchedSourceFiles: string[];
  codeRefs: CodeRefs;
}

export interface ImpactAnalysisResult {
  repoPath: string;
  baseRef: string;
  changedFiles: string[];
  affectedSkills: ImpactMatch[];
  scopedDiffBySkill: Record<string, string>;
}
