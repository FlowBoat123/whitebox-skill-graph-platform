import { canonicalJson, compareText } from "./canonical-json.js";
import { createEvidenceId, isValidCodeUnitStableId } from "./stable-id.js";
import type {
  JsonObject,
  JsonValue,
  KnowledgeDocument,
  KnowledgeRegistry,
  ValidationDiagnostic,
  ValidationOptions,
} from "./types.js";

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && !Array.isArray(value) && typeof value === "object" ? value : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function documentId(document: KnowledgeDocument): string | undefined {
  return stringValue(document.data.id);
}

function addDiagnostic(
  diagnostics: ValidationDiagnostic[],
  document: KnowledgeDocument,
  code: ValidationDiagnostic["code"],
  path: string,
  message: string,
): void {
  diagnostics.push({ code, file: document.file, path, message });
}

function indexById(documents: KnowledgeDocument[]): Map<string, KnowledgeDocument> {
  const result = new Map<string, KnowledgeDocument>();
  for (const document of documents) {
    const id = documentId(document);
    if (id !== undefined && !result.has(id)) {
      result.set(id, document);
    }
  }
  return result;
}

function statusOf(document: KnowledgeDocument | undefined): string | undefined {
  return document === undefined ? undefined : stringValue(document.data.status);
}

function isPlaceholder(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") {
    return true;
  }
  const normalized = value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase();
  return /^(?:chua xac nhan\.?|tbd|todo|unknown|not confirmed|pending|n\/?a|null|-+)$/u.test(
    normalized,
  );
}

function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateDuplicateIds(
  registry: KnowledgeRegistry,
  diagnostics: ValidationDiagnostic[],
): void {
  const firstById = new Map<string, KnowledgeDocument>();
  for (const document of registry.documents) {
    const id = documentId(document);
    if (id === undefined) {
      continue;
    }
    const first = firstById.get(id);
    if (first === undefined) {
      firstById.set(id, document);
    } else {
      addDiagnostic(
        diagnostics,
        document,
        "DUPLICATE_ID",
        "$.id",
        `Duplicate ID "${id}"; first declared in ${first.file}`,
      );
    }
  }
}

function validateInvariantReferences(
  invariants: KnowledgeDocument[],
  invariantById: Map<string, KnowledgeDocument>,
  diagnostics: ValidationDiagnostic[],
): void {
  for (const invariant of invariants) {
    for (const [index, targetId] of stringArray(invariant.data.supersedes).entries()) {
      if (!invariantById.has(targetId)) {
        addDiagnostic(
          diagnostics,
          invariant,
          "UNKNOWN_REFERENCE",
          `$.supersedes[${index}]`,
          `Unknown invariant "${targetId}"`,
        );
      }
    }
  }
}

function validateGuardrailReferences(
  guardrails: KnowledgeDocument[],
  invariantById: Map<string, KnowledgeDocument>,
  diagnostics: ValidationDiagnostic[],
): void {
  for (const guardrail of guardrails) {
    for (const [index, invariantId] of stringArray(guardrail.data.enforces).entries()) {
      if (!invariantById.has(invariantId)) {
        addDiagnostic(
          diagnostics,
          guardrail,
          "UNKNOWN_REFERENCE",
          `$.enforces[${index}]`,
          `Unknown invariant "${invariantId}"`,
        );
      }
    }
  }
}

function validateBugReferences(
  bugs: KnowledgeDocument[],
  familyById: Map<string, KnowledgeDocument>,
  invariantById: Map<string, KnowledgeDocument>,
  guardrailById: Map<string, KnowledgeDocument>,
  evidenceIds: ReadonlySet<string>,
  diagnostics: ValidationDiagnostic[],
): void {
  for (const bug of bugs) {
    const id = documentId(bug);
    const source = objectValue(bug.data.source);
    const identity = id?.match(/^BUG:([^:]+):([1-9][0-9]*)$/u);
    if (
      identity !== null &&
      identity !== undefined &&
      (stringValue(source?.projectKey) !== identity[1] || source?.issueIid !== Number(identity[2]))
    ) {
      addDiagnostic(
        diagnostics,
        bug,
        "INCONSISTENT_IDENTITY",
        "$.source",
        `Bug ID "${id}" must match source.projectKey and source.issueIid`,
      );
    }

    const classification = objectValue(bug.data.classification);
    const familyId = stringValue(classification?.defectFamily);
    if (familyId !== undefined && !familyById.has(familyId)) {
      addDiagnostic(
        diagnostics,
        bug,
        "UNKNOWN_REFERENCE",
        "$.classification.defectFamily",
        `Unknown defect family "${familyId}"`,
      );
    }

    const analysis = objectValue(bug.data.analysis);
    for (const [index, invariantId] of stringArray(analysis?.violatedInvariants).entries()) {
      if (!invariantById.has(invariantId)) {
        addDiagnostic(
          diagnostics,
          bug,
          "UNKNOWN_REFERENCE",
          `$.analysis.violatedInvariants[${index}]`,
          `Unknown invariant "${invariantId}"`,
        );
      }
    }

    const resolution = objectValue(bug.data.resolution);
    for (const [index, guardrailId] of stringArray(resolution?.regressionGuardrails).entries()) {
      if (!guardrailById.has(guardrailId)) {
        addDiagnostic(
          diagnostics,
          bug,
          "UNKNOWN_REFERENCE",
          `$.resolution.regressionGuardrails[${index}]`,
          `Unknown guardrail "${guardrailId}"`,
        );
      }
    }

    const impact = objectValue(bug.data.impact);
    for (const [index, codeUnitId] of stringArray(impact?.affectedCodeUnits).entries()) {
      if (!isValidCodeUnitStableId(codeUnitId)) {
        addDiagnostic(
          diagnostics,
          bug,
          "INVALID_STABLE_KEY",
          `$.impact.affectedCodeUnits[${index}]`,
          `Invalid code-unit stable key "${codeUnitId}"`,
        );
      }
    }
    const siblingScan = objectValue(impact?.siblingScan);
    const candidates = siblingScan?.candidates;
    if (Array.isArray(candidates)) {
      const seenCodeUnits = new Set<string>();
      for (const [index, candidateValue] of candidates.entries()) {
        const candidate = objectValue(candidateValue);
        const codeUnitId = stringValue(candidate?.codeUnit);
        if (codeUnitId !== undefined && !isValidCodeUnitStableId(codeUnitId)) {
          addDiagnostic(
            diagnostics,
            bug,
            "INVALID_STABLE_KEY",
            `$.impact.siblingScan.candidates[${index}].codeUnit`,
            `Invalid code-unit stable key "${codeUnitId}"`,
          );
        }
        if (codeUnitId !== undefined) {
          if (seenCodeUnits.has(codeUnitId)) {
            addDiagnostic(
              diagnostics,
              bug,
              "DUPLICATE_SIBLING_CANDIDATE",
              `$.impact.siblingScan.candidates[${index}].codeUnit`,
              `Sibling candidate "${codeUnitId}" is declared more than once`,
            );
          }
          seenCodeUnits.add(codeUnitId);
        }
        const evidenceRef = stringValue(candidate?.evidenceRef);
        if (evidenceRef !== undefined && !evidenceIds.has(evidenceRef)) {
          addDiagnostic(
            diagnostics,
            bug,
            "UNKNOWN_REFERENCE",
            `$.impact.siblingScan.candidates[${index}].evidenceRef`,
            `Unknown evidence "${evidenceRef}"`,
          );
        }
      }
    }
  }
}

function collectEvidenceIds(registry: KnowledgeRegistry): Set<string> {
  const result = new Set<string>();
  for (const document of registry.documents) {
    if (!Array.isArray(document.data.sourceRefs)) {
      continue;
    }
    for (const sourceRefValue of document.data.sourceRefs) {
      const sourceRef = objectValue(sourceRefValue);
      if (sourceRef !== undefined) {
        result.add(createEvidenceId(canonicalJson(sourceRef)));
      }
    }
  }
  return result;
}

function validateConfirmedBugs(
  bugs: KnowledgeDocument[],
  familyById: Map<string, KnowledgeDocument>,
  invariantById: Map<string, KnowledgeDocument>,
  guardrailById: Map<string, KnowledgeDocument>,
  diagnostics: ValidationDiagnostic[],
): void {
  for (const bug of bugs) {
    if (bug.data.status !== "CONFIRMED") {
      continue;
    }

    const classification = objectValue(bug.data.classification);
    const familyId = stringValue(classification?.defectFamily);
    if (statusOf(familyId === undefined ? undefined : familyById.get(familyId)) !== "ACTIVE") {
      addDiagnostic(
        diagnostics,
        bug,
        "CONFIRMED_BUG_INCOMPLETE",
        "$.classification.defectFamily",
        "A CONFIRMED bug must reference an ACTIVE defect family",
      );
    }

    const analysis = objectValue(bug.data.analysis);
    const invariantIds = stringArray(analysis?.violatedInvariants);
    if (
      invariantIds.length === 0 ||
      invariantIds.some((id) => statusOf(invariantById.get(id)) !== "ACTIVE")
    ) {
      addDiagnostic(
        diagnostics,
        bug,
        "CONFIRMED_BUG_INCOMPLETE",
        "$.analysis.violatedInvariants",
        "A CONFIRMED bug must reference at least one ACTIVE invariant",
      );
    }

    for (const [field, label] of [
      ["directCause", "direct cause"],
      ["enablingCondition", "enabling condition"],
      ["escapeReason", "escape reason"],
    ] as const) {
      if (isPlaceholder(stringValue(analysis?.[field]))) {
        addDiagnostic(
          diagnostics,
          bug,
          "CONFIRMED_BUG_INCOMPLETE",
          `$.analysis.${field}`,
          `A CONFIRMED bug must have a non-placeholder ${label}`,
        );
      }
    }

    const impact = objectValue(bug.data.impact);
    const affectedCodeUnits = stringArray(impact?.affectedCodeUnits);
    if (affectedCodeUnits.length === 0) {
      addDiagnostic(
        diagnostics,
        bug,
        "CONFIRMED_BUG_INCOMPLETE",
        "$.impact.affectedCodeUnits",
        "A CONFIRMED bug must affect at least one code unit",
      );
    }
    const siblingScan = objectValue(impact?.siblingScan);
    if (siblingScan?.status !== "COMPLETED" && siblingScan?.status !== "NOT_APPLICABLE") {
      addDiagnostic(
        diagnostics,
        bug,
        "CONFIRMED_BUG_INCOMPLETE",
        "$.impact.siblingScan.status",
        "A CONFIRMED bug requires a completed or not-applicable sibling scan",
      );
    } else if (isPlaceholder(stringValue(siblingScan.method))) {
      addDiagnostic(
        diagnostics,
        bug,
        "CONFIRMED_BUG_INCOMPLETE",
        "$.impact.siblingScan.method",
        "A CONFIRMED bug must record the sibling-scan method or not-applicable rationale",
      );
    }
    const siblingCandidates = Array.isArray(siblingScan?.candidates)
      ? siblingScan.candidates
      : [];
    if (siblingScan?.status === "NOT_APPLICABLE" && siblingCandidates.length > 0) {
      addDiagnostic(
        diagnostics,
        bug,
        "CONFIRMED_BUG_INCOMPLETE",
        "$.impact.siblingScan.candidates",
        "A not-applicable sibling scan cannot contain candidates",
      );
    }
    if (siblingScan?.status === "COMPLETED") {
      for (const [index, candidateValue] of siblingCandidates.entries()) {
        const candidate = objectValue(candidateValue);
        const verdict = stringValue(candidate?.verdict);
        const codeUnitId = stringValue(candidate?.codeUnit);
        if (verdict === "DEFERRED") {
          addDiagnostic(
            diagnostics,
            bug,
            "CONFIRMED_BUG_INCOMPLETE",
            `$.impact.siblingScan.candidates[${index}].verdict`,
            "A completed sibling scan cannot leave a candidate deferred",
          );
        }
        if (
          verdict === "AFFECTED" &&
          codeUnitId !== undefined &&
          !affectedCodeUnits.includes(codeUnitId)
        ) {
          addDiagnostic(
            diagnostics,
            bug,
            "CONFIRMED_BUG_INCOMPLETE",
            `$.impact.siblingScan.candidates[${index}].codeUnit`,
            "An affected sibling candidate must also appear in affectedCodeUnits",
          );
        }
      }
    }

    const resolution = objectValue(bug.data.resolution);
    if (stringValue(resolution?.fixMergeRequest) === undefined) {
      addDiagnostic(
        diagnostics,
        bug,
        "CONFIRMED_BUG_INCOMPLETE",
        "$.resolution.fixMergeRequest",
        "A CONFIRMED bug must reference its fix merge request",
      );
    }

    const guardrailIds = stringArray(resolution?.regressionGuardrails);
    const hasRelevantActiveGuardrail = guardrailIds.some((guardrailId) => {
      const guardrail = guardrailById.get(guardrailId);
      return (
        statusOf(guardrail) === "ACTIVE" &&
        stringArray(guardrail?.data.enforces).some((invariantId) =>
          invariantIds.includes(invariantId),
        )
      );
    });
    if (!hasRelevantActiveGuardrail) {
      const exception = objectValue(resolution?.guardrailException);
      const reason = stringValue(exception?.reason);
      const owner = stringValue(exception?.owner);
      const expiresOn = stringValue(exception?.expiresOn);
      const completeException =
        !isPlaceholder(reason) &&
        !isPlaceholder(owner) &&
        expiresOn !== undefined &&
        isRealIsoDate(expiresOn);

      if (!completeException) {
        addDiagnostic(
          diagnostics,
          bug,
          "CONFIRMED_BUG_INCOMPLETE",
          "$.resolution",
          "A CONFIRMED bug needs an ACTIVE regression guardrail that enforces a violated invariant, or a complete exception",
        );
      }
    }

    if (!Array.isArray(bug.data.sourceRefs) || bug.data.sourceRefs.length === 0) {
      addDiagnostic(
        diagnostics,
        bug,
        "CONFIRMED_BUG_INCOMPLETE",
        "$.sourceRefs",
        "A CONFIRMED bug must include at least one evidence source reference",
      );
    }
  }
}

function validateGuardrailExceptions(
  bugs: KnowledgeDocument[],
  asOf: string | undefined,
  diagnostics: ValidationDiagnostic[],
): void {
  for (const bug of bugs) {
    const resolution = objectValue(bug.data.resolution);
    const exceptionValue = resolution?.guardrailException;
    if (exceptionValue === null || exceptionValue === undefined) {
      continue;
    }

    const exception = objectValue(exceptionValue);
    const expiresOn = stringValue(exception?.expiresOn);
    if (expiresOn === undefined) {
      continue;
    }
    if (!isRealIsoDate(expiresOn)) {
      addDiagnostic(
        diagnostics,
        bug,
        "INVALID_GUARDRAIL_EXCEPTION",
        "$.resolution.guardrailException.expiresOn",
        `Guardrail exception expiry is not a real ISO date: ${expiresOn}`,
      );
    } else if (asOf !== undefined && expiresOn <= asOf) {
      addDiagnostic(
        diagnostics,
        bug,
        "EXPIRED_GUARDRAIL_EXCEPTION",
        "$.resolution.guardrailException.expiresOn",
        `Guardrail exception expired on ${expiresOn}; validation date is ${asOf}`,
      );
    }
  }
}

function validateSupersedesCycles(
  invariants: KnowledgeDocument[],
  invariantById: Map<string, KnowledgeDocument>,
  diagnostics: ValidationDiagnostic[],
): void {
  const adjacency = new Map<string, string[]>();
  for (const invariant of invariants) {
    const id = documentId(invariant);
    if (id !== undefined) {
      adjacency.set(
        id,
        stringArray(invariant.data.supersedes)
          .filter((target) => invariantById.has(target))
          .sort(compareText),
      );
    }
  }

  const state = new Map<string, "VISITING" | "VISITED">();
  const stack: string[] = [];
  const reported = new Set<string>();

  const visit = (id: string): void => {
    state.set(id, "VISITING");
    stack.push(id);
    for (const target of adjacency.get(id) ?? []) {
      if (state.get(target) === "VISITING") {
        const start = stack.indexOf(target);
        const cycle = [...stack.slice(start), target];
        const members = [...new Set(cycle.slice(0, -1))].sort(compareText);
        const cycleKey = members.join("\0");
        if (!reported.has(cycleKey)) {
          reported.add(cycleKey);
          const document = invariantById.get(id);
          if (document !== undefined) {
            addDiagnostic(
              diagnostics,
              document,
              "CYCLIC_SUPERSEDES",
              "$.supersedes",
              `Invariant supersedes cycle: ${cycle.join(" -> ")}`,
            );
          }
        }
      } else if (state.get(target) === undefined) {
        visit(target);
      }
    }
    stack.pop();
    state.set(id, "VISITED");
  };

  for (const id of [...adjacency.keys()].sort(compareText)) {
    if (state.get(id) === undefined) {
      visit(id);
    }
  }
}

export function validateReferences(
  registry: KnowledgeRegistry,
  options: ValidationOptions = {},
): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const requestedAsOf = options.asOf ?? new Date().toISOString().slice(0, 10);
  const asOf = isRealIsoDate(requestedAsOf) ? requestedAsOf : undefined;
  if (asOf === undefined) {
    diagnostics.push({
      code: "INVALID_VALIDATION_OPTIONS",
      file: "(validation options)",
      path: "$.asOf",
      message: `Validation date is not a real ISO date: ${requestedAsOf}`,
    });
  }
  const families = registry.documents.filter((document) => document.kind === "DEFECT_FAMILY");
  const invariants = registry.documents.filter((document) => document.kind === "INVARIANT");
  const guardrails = registry.documents.filter((document) => document.kind === "GUARDRAIL");
  const bugs = registry.documents.filter((document) => document.kind === "BUG");
  const familyById = indexById(families);
  const invariantById = indexById(invariants);
  const guardrailById = indexById(guardrails);
  const evidenceIds = collectEvidenceIds(registry);

  validateDuplicateIds(registry, diagnostics);
  validateInvariantReferences(invariants, invariantById, diagnostics);
  validateGuardrailReferences(guardrails, invariantById, diagnostics);
  validateBugReferences(
    bugs,
    familyById,
    invariantById,
    guardrailById,
    evidenceIds,
    diagnostics,
  );
  validateConfirmedBugs(
    bugs,
    familyById,
    invariantById,
    guardrailById,
    diagnostics,
  );
  validateGuardrailExceptions(bugs, asOf, diagnostics);
  validateSupersedesCycles(invariants, invariantById, diagnostics);

  return diagnostics;
}
