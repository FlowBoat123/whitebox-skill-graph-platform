import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileGraph, loadRegistry, validateRegistry } from "@defect-intelligence/knowledge-validator";
import {
  buildProposedSkillGuardrailYaml,
  buildRegistryBugDraftYaml,
  createSkillValidator,
  endpointToCodeUnitId,
  matchesPathGlob,
  queryDefectKnowledgeGraph,
  selectDefectAwareImpactedSkills,
  sourceFileToCodeUnitId,
  writeRegistryBugDraftYaml,
  type BugEvidenceBundle,
  type LoadedSkill,
} from "../src/index.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

function makeSyntheticRegistryDir(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "closed-loop-reg-"));
  fs.cpSync(path.join(REPO_ROOT, "contracts"), path.join(tmp, "contracts"), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, "knowledge", "defect-families"), path.join(tmp, "knowledge", "defect-families"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmp, "knowledge", "invariants"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "knowledge", "guardrails"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "knowledge", "bugs", "horilla"), { recursive: true });
  return tmp;
}

describe("Phase B closed-loop Skill Graph <-> Defect Knowledge Graph", () => {
  it("maps TS, Python, HTML template, and HTTP endpoints to valid CodeUnit stable IDs and rejects unsafe paths", () => {
    expect(sourceFileToCodeUnitId("cypress-rwa", "src/components/UserSettingsForm.tsx")).toBe(
      "cypress-rwa:ts:FILE:src/components/UserSettingsForm.tsx#file",
    );
    expect(sourceFileToCodeUnitId("horilla", "base/cbv/department.py")).toBe(
      "horilla:py:FILE:base/cbv/department.py#file",
    );
    expect(sourceFileToCodeUnitId("horilla", "horilla_theme/templates/login.html")).toBe(
      "horilla:template:FILE:horilla_theme/templates/login.html#file",
    );
    expect(endpointToCodeUnitId("horilla", "POST /settings-department-creation/")).toBe(
      "horilla:api:POST:/settings-department-creation/",
    );

    // Reject path traversal & absolute paths
    expect(sourceFileToCodeUnitId("horilla", "../secret.py")).toBeNull();
    expect(sourceFileToCodeUnitId("horilla", "/etc/passwd.py")).toBeNull();
    expect(endpointToCodeUnitId("horilla", "INVALID /foo")).toBeNull();

    // Glob matcher sanity
    expect(matchesPathGlob("base/cbv/department.py", "base/cbv/**")).toBe(true);
    expect(matchesPathGlob("base/views.py", "base/cbv/**")).toBe(false);
    expect(matchesPathGlob("horilla_theme/templates/generic/form.html", "horilla_theme/templates/**")).toBe(true);
  });

  it("emits schema-valid DRAFT bug & PROPOSED guardrail YAMLs that compile deterministically and cannot self-promote to CONFIRMED", async () => {
    const tmp = makeSyntheticRegistryDir();
    try {
      fs.writeFileSync(
        path.join(tmp, "knowledge", "invariants", "INV-HOR-TEST-001.yaml"),
        `schemaVersion: 1
id: INV-HOR-TEST-001
title: Persist department mutations
statement: Department creation must persist records.
rationale: Prevent silent save omission.
severity: P1
status: ACTIVE
owner: qa-platform
appliesTo:
  projects:
    - horilla
  pathGlobs:
    - base/cbv/**
  codeUnitKinds:
    - FILE
sourceRefs: []
supersedes: []
`,
        "utf8",
      );

      const bugEvidence: BugEvidenceBundle = {
        origin: "OBSERVED_DETERMINISTIC",
        skillId: "department.create",
        summary: "Postcondition failure on 'department.create': DOM missing expected text 'Platform Eng'",
        currentUrl: "http://127.0.0.1:8000/settings/department-view/",
        failedPostconditions: [
          { kind: "DOM_CONTAINS", passed: false, detail: "DOM missing expected text 'Platform Eng'" },
        ],
        httpErrors: [],
        consoleErrors: [],
        codeRefs: {
          routes: ["/settings/department-view/"],
          endpoints: ["POST /settings-department-creation/"],
          sourceFiles: ["base/cbv/department.py", "horilla_theme/templates/generic/form.html"],
        },
      };

      const builtBug = buildRegistryBugDraftYaml("horilla", bugEvidence, {
        violatedInvariants: ["INV-HOR-TEST-001"],
      });
      expect(builtBug.document.status).toBe("DRAFT");
      expect(builtBug.document.impact.affectedCodeUnits).toEqual([
        "horilla:api:POST:/settings-department-creation/",
        "horilla:py:FILE:base/cbv/department.py#file",
        "horilla:template:FILE:horilla_theme/templates/generic/form.html#file",
      ]);

      const writtenPath = writeRegistryBugDraftYaml(builtBug, path.join(tmp, "knowledge", "bugs", "horilla"));
      expect(fs.existsSync(writtenPath)).toBe(true);

      const skills = createSkillValidator().validateDirectory(path.join(REPO_ROOT, "skills/horilla")).skills;
      const deptSkill = skills.find((s) => s.skill.id === "department.create")!.skill;
      const builtGrd = buildProposedSkillGuardrailYaml({
        app: "horilla",
        skill: deptSkill,
        skillRelPath: "skills/horilla/department.create.yaml",
        enforces: ["INV-HOR-TEST-001"],
      });
      fs.writeFileSync(path.join(tmp, "knowledge", "guardrails", builtGrd.fileName), builtGrd.yaml, "utf8");

      const registry = await loadRegistry(tmp);
      const val = validateRegistry(registry);
      expect(val.valid).toBe(true);
      expect(val.errors).toEqual([]);

      const graph1 = compileGraph(registry);
      const graph2 = compileGraph(registry);
      expect(graph1.sourceDigest).toBe(graph2.sourceDigest);
      expect(graph1.nodes).toContainEqual(expect.objectContaining({ id: builtBug.document.id, type: "BUG" }));
      expect(graph1.edges).toContainEqual(
        expect.objectContaining({
          type: "AFFECTS",
          from: builtBug.document.id,
          to: "horilla:py:FILE:base/cbv/department.py#file",
        }),
      );

      // Rule #5 enforcement: flipping status to CONFIRMED without human RCA + active guardrail MUST fail validation!
      const forgedConfirmed = builtBug.yaml.replace("status: DRAFT", "status: CONFIRMED");
      fs.writeFileSync(writtenPath, forgedConfirmed, "utf8");
      const forgedVal = validateRegistry(await loadRegistry(tmp));
      expect(forgedVal.valid).toBe(false);
      expect(forgedVal.errors.some((e) => e.code === "CONFIRMED_BUG_INCOMPLETE")).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("prioritizes confirmed defect + active guardrail skills first and propagates unmodified sibling skills deterministically", async () => {
    const tmp = makeSyntheticRegistryDir();
    try {
      fs.writeFileSync(
        path.join(tmp, "knowledge", "invariants", "INV-HOR-001.yaml"),
        `schemaVersion: 1
id: INV-HOR-001
title: Persist HRMS mutations
statement: Mutations must persist to DB and refresh list views.
rationale: Avoid silent data loss.
severity: P1
status: ACTIVE
owner: qa-platform
appliesTo:
  projects:
    - horilla
  pathGlobs:
    - base/cbv/**
  codeUnitKinds:
    - FILE
sourceRefs: []
supersedes: []
`,
        "utf8",
      );
      fs.writeFileSync(
        path.join(tmp, "knowledge", "guardrails", "GRD-HOR-DEPT-001.yaml"),
        `schemaVersion: 1
id: GRD-HOR-DEPT-001
name: Department create skill verifier
type: SKILL_GRAPH_VERIFIER
status: ACTIVE
owner: qa-platform
locator:
  project: horilla
  path: skills/horilla/department.create.yaml
  ruleId: department.create
enforces:
  - INV-HOR-001
sourceRefs: []
`,
        "utf8",
      );
      // Confirmed P1 bug on department.py with AFFECTED sibling candidate pointing to employee_type.py!
      fs.writeFileSync(
        path.join(tmp, "knowledge", "bugs", "horilla", "7001.yaml"),
        `schemaVersion: 1
id: BUG:horilla:7001
status: CONFIRMED
severity: P1
owner: qa-platform
source:
  projectKey: horilla
  issueIid: 7001
  issueUrl: skill-graph:observed:horilla:7001
classification:
  defectFamily: DF-DATA_QUERY_PERSISTENCE
analysis:
  symptom: Department creation omitted form.save().
  trigger: Submit Create Department modal.
  directCause: Missing super().form_valid(form) call.
  enablingCondition: Custom override returned HttpResponse early.
  escapeReason: Missing DOM persistence postcondition.
  violatedInvariants:
    - INV-HOR-001
impact:
  affectedCodeUnits:
    - horilla:py:FILE:base/cbv/department.py#file
    - horilla:py:FILE:base/cbv/shared_helper.py#file
    - horilla:py:FILE:base/cbv/employee_type.py#file
  siblingScan:
    status: COMPLETED
    method: Audited HorillaFormView subclasses
    candidates:
      - codeUnit: horilla:py:FILE:base/cbv/employee_type.py#file
        verdict: AFFECTED
        evidenceRef: null
resolution:
  fixMergeRequest: MR:horilla:77:0123456789abcdef0123456789abcdef01234567
  regressionGuardrails:
    - GRD-HOR-DEPT-001
  guardrailException: null
sourceRefs:
  - kind: RUNTIME_TRACE
    uri: skill-graph:horilla:department.create:demo7001
    commitSha: null
    contentHash: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
`,
        "utf8",
      );
      // Draft bug on department.search's template to verify provenance separation
      fs.writeFileSync(
        path.join(tmp, "knowledge", "bugs", "horilla", "7002.yaml"),
        `schemaVersion: 1
id: BUG:horilla:7002
status: DRAFT
severity: P2
owner: skill-graph-verifier
source:
  projectKey: horilla
  issueIid: 7002
  issueUrl: skill-graph:observed:horilla:7002
classification:
  defectFamily: DF-UI_STATE_INTERACTION
analysis:
  symptom: Search input returned stale list.
  trigger: Filter department list.
  directCause: Chưa xác nhận.
  enablingCondition: Chưa xác nhận.
  escapeReason: Chưa xác nhận.
  violatedInvariants: []
impact:
  affectedCodeUnits:
    - horilla:py:FILE:base/cbv/shared_helper.py#file
  siblingScan:
    status: PENDING
    method: null
    candidates: []
resolution:
  fixMergeRequest: null
  regressionGuardrails: []
  guardrailException: null
sourceRefs:
  - kind: RUNTIME_TRACE
    uri: skill-graph:horilla:department.search:demo7002
    commitSha: null
    contentHash: fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210
`,
        "utf8",
      );

      const graph = compileGraph(await loadRegistry(tmp));
      const skills: LoadedSkill[] = [
        {
          filePath: "skills/horilla/aaa.low_risk.yaml",
          skill: {
            schemaVersion: 1,
            id: "aaa.low_risk",
            app: "horilla",
            description: "Alphabetically first skill touching shared helper (no confirmed guardrail).",
            preconditions: [],
            produces: [{ name: "low.done" }],
            inputs: {},
            codeRefs: { routes: ["/"], endpoints: [], sourceFiles: ["base/cbv/shared_helper.py"] },
            steps: [{ op: "NAVIGATE", url: "/" }],
            postconditions: [{ kind: "PAGE_ERRORS", maxCount: 0 }],
          },
        },
        {
          filePath: "skills/horilla/department.create.yaml",
          skill: {
            schemaVersion: 1,
            id: "department.create",
            app: "horilla",
            description: "High-risk skill backed by ACTIVE guardrail + CONFIRMED P1 bug.",
            preconditions: [],
            produces: [{ name: "department.exists" }],
            inputs: {},
            codeRefs: {
              routes: ["/settings/department-view/"],
              endpoints: ["POST /settings-department-creation/"],
              sourceFiles: ["base/cbv/department.py", "base/cbv/shared_helper.py"],
            },
            steps: [{ op: "NAVIGATE", url: "/settings/department-view/" }],
            postconditions: [{ kind: "PAGE_ERRORS", maxCount: 0 }],
          },
        },
        {
          filePath: "skills/horilla/employee_type.create.yaml",
          skill: {
            schemaVersion: 1,
            id: "employee_type.create",
            app: "horilla",
            description: "Unmodified sibling skill pulled in via SIBLING_CANDIDATE.",
            preconditions: [],
            produces: [{ name: "employee_type.exists" }],
            inputs: {},
            codeRefs: {
              routes: ["/settings/employee-type-view/"],
              endpoints: [],
              sourceFiles: ["base/cbv/employee_type.py"],
            },
            steps: [{ op: "NAVIGATE", url: "/settings/employee-type-view/" }],
            postconditions: [{ kind: "PAGE_ERRORS", maxCount: 0 }],
          },
        },
        {
          filePath: "skills/horilla/unrelated.skill.yaml",
          skill: {
            schemaVersion: 1,
            id: "unrelated.skill",
            app: "horilla",
            description: "Completely untouched skill.",
            preconditions: [],
            produces: [{ name: "unrelated.done" }],
            inputs: {},
            codeRefs: { routes: ["/other/"], endpoints: [], sourceFiles: ["other/views.py"] },
            steps: [{ op: "NAVIGATE", url: "/other/" }],
            postconditions: [{ kind: "PAGE_ERRORS", maxCount: 0 }],
          },
        },
      ];

      // Changed ONLY base/cbv/shared_helper.py -> plain overlap misses employee_type.create and ranks aaa.low_risk #1!
      const impact1 = selectDefectAwareImpactedSkills({
        skills,
        knowledgeGraph: graph,
        changedFiles: ["base/cbv/shared_helper.py"],
      });
      const impact2 = selectDefectAwareImpactedSkills({
        skills,
        knowledgeGraph: graph,
        changedFiles: ["base/cbv/shared_helper.py"],
      });

      // Determinism
      expect(impact1).toEqual(impact2);

      // 1. department.create MUST outrank aaa.low_risk despite alphabetical disadvantage!
      expect(impact1.affectedSkills.map((s) => s.skillId)).toEqual([
        "department.create",
        "aaa.low_risk",
        "employee_type.create",
      ]);
      const top = impact1.affectedSkills[0]!;
      expect(top.riskScore).toBeGreaterThan(impact1.affectedSkills[1]!.riskScore);
      expect(top.confirmedSignals.bugIds).toContain("BUG:horilla:7001");
      expect(top.confirmedSignals.activeGuardrailIds).toContain("GRD-HOR-DEPT-001");
      expect(top.confirmedSignals.invariantIds).toContain("INV-HOR-001");
      // Provenance separation: DRAFT bug stays strictly inside observedDraftSignals!
      expect(top.confirmedSignals.bugIds).not.toContain("BUG:horilla:7002");
      expect(top.observedDraftSignals.draftBugIds).toContain("BUG:horilla:7002");

      // 2. Unmodified sibling skill MUST be pulled in via SIBLING_DEFECT_PROPAGATION!
      const sib = impact1.affectedSkills.find((s) => s.skillId === "employee_type.create")!;
      expect(sib.matchedSourceFiles).toEqual([]);
      expect(sib.selectionReasons).toContain("SIBLING_DEFECT_PROPAGATION");
      expect(sib.confirmedSignals.siblingCodeUnits).toContain("horilla:py:FILE:base/cbv/employee_type.py#file");

      // 3. Unrelated skill must NOT be pulled in (preserves 100% NO_IMPACT precision!)
      expect(impact1.affectedSkills.some((s) => s.skillId === "unrelated.skill")).toBe(false);

      // 4. Query helper also strictly separates confirmed vs draft records
      const q = queryDefectKnowledgeGraph(graph, {
        projectKey: "horilla",
        filePaths: ["base/cbv/shared_helper.py"],
      });
      expect(q.confirmedKnowledge.bugs.map((b) => b.id)).toEqual(["BUG:horilla:7001"]);
      expect(q.observedDrafts.draftBugs.map((b) => b.id)).toEqual(["BUG:horilla:7002"]);
      expect(q.confirmedKnowledge.activeGuardrails.map((g) => g.id)).toContain("GRD-HOR-DEPT-001");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
