import { interpolateTemplate } from "./validator.js";
import type {
  ConcreteFact,
  PlannedSkillCall,
  SkillDefinition,
  SkillPlan,
  StatePredicate,
} from "./types.js";

export interface PlanRequest {
  skills: SkillDefinition[];
  goal: {
    name: string;
    singleton?: boolean;
    params?: Record<string, string>;
  };
  bindings?: Record<string, string>;
  /** Optional per-actor credentials/attributes keyed by actor username/id (e.g. password per user). */
  actorBindings?: Record<string, Record<string, string>>;
  /** Optional explicit per-skill parameter overrides. */
  skillParams?: Record<string, Record<string, string>>;
  initialFacts?: ConcreteFact[];
  maxDepth?: number;
}

export class PlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanningError";
  }
}

function stableFactKey(fact: { name: string; params?: Record<string, string> }): string {
  const entries = Object.entries(fact.params ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return `${fact.name}(${entries.map(([k, v]) => `${k}=${v}`).join(",")})`;
}

function factMatches(actual: ConcreteFact, expected: ConcreteFact): boolean {
  if (actual.name !== expected.name) {
    return false;
  }
  for (const [key, val] of Object.entries(expected.params)) {
    if (actual.params[key] !== val) {
      return false;
    }
  }
  return true;
}

function stateSatisfies(facts: ConcreteFact[], expected: ConcreteFact): boolean {
  return facts.some((f) => factMatches(f, expected));
}

function cloneFacts(facts: ConcreteFact[]): ConcreteFact[] {
  return facts.map((f) => ({
    name: f.name,
    singleton: f.singleton,
    params: { ...f.params },
  }));
}

function applySkillEffects(
  facts: ConcreteFact[],
  clears: string[],
  produces: ConcreteFact[],
): ConcreteFact[] {
  const clearSet = new Set(clears);
  const next = facts.filter((f) => !clearSet.has(f.name));

  for (const produced of produces) {
    if (produced.singleton) {
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i]!.name === produced.name) {
          next.splice(i, 1);
        }
      }
    }
    if (!next.some((existing) => stableFactKey(existing) === stableFactKey(produced))) {
      next.push(produced);
    }
  }
  return next;
}

function extractVarName(templateValue: string): string | null {
  const m = /^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/.exec(templateValue.trim());
  return m?.[1] ?? null;
}

function unifyPredicateParams(
  templatePredicate: StatePredicate,
  targetFact: ConcreteFact,
): Record<string, string> | null {
  const unified: Record<string, string> = {};
  const templateParams = templatePredicate.params ?? {};

  for (const [paramKey, expectedVal] of Object.entries(targetFact.params)) {
    const tmpl = templateParams[paramKey];
    if (tmpl === undefined) {
      return null;
    }
    const varName = extractVarName(tmpl);
    if (varName) {
      const existing = unified[varName];
      if (existing !== undefined && existing !== expectedVal) {
        return null;
      }
      unified[varName] = expectedVal;
    } else if (tmpl !== expectedVal) {
      return null;
    }
  }
  return unified;
}

function resolveSkillInputs(
  skill: SkillDefinition,
  unified: Record<string, string>,
  request: PlanRequest,
): Record<string, string> | null {
  const resolved: Record<string, string> = { ...unified };
  const skillOverrides = request.skillParams?.[skill.id] ?? {};
  const globalBindings = request.bindings ?? {};

  // Detect active actor key (e.g. username or user) so actorBindings can supply role-specific secrets/inputs.
  const actorCandidate =
    resolved.username ??
    resolved.user ??
    skillOverrides.username ??
    skillOverrides.user ??
    globalBindings.username ??
    globalBindings.user;
  const actorMap = actorCandidate ? request.actorBindings?.[actorCandidate] : undefined;

  for (const [name, spec] of Object.entries(skill.inputs)) {
    if (resolved[name] !== undefined) {
      continue;
    }
    const candidate =
      skillOverrides[name] ??
      actorMap?.[name] ??
      globalBindings[name] ??
      spec.default;
    if (candidate !== undefined) {
      resolved[name] = candidate;
    } else if (spec.required) {
      return null;
    }
  }
  return resolved;
}

function instantiatePredicate(
  predicate: StatePredicate,
  params: Record<string, string>,
): ConcreteFact {
  const concreteParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(predicate.params ?? {})) {
    concreteParams[k] = interpolateTemplate(v, params);
  }
  return {
    name: predicate.name,
    singleton: Boolean(predicate.singleton),
    params: concreteParams,
  };
}

export function planToReach(request: PlanRequest): SkillPlan {
  const orderedSkills = [...request.skills].sort((a, b) => a.id.localeCompare(b.id));
  const maxDepth = request.maxDepth ?? 12;
  const goal: ConcreteFact = {
    name: request.goal.name,
    singleton: Boolean(request.goal.singleton),
    params: { ...(request.goal.params ?? {}) },
  };
  const initialState = cloneFacts(request.initialFacts ?? []);

  function achieve(
    currentFacts: ConcreteFact[],
    target: ConcreteFact,
    activeGoals: Set<string>,
    depth: number,
  ): { steps: PlannedSkillCall[]; nextFacts: ConcreteFact[] } | null {
    if (stateSatisfies(currentFacts, target)) {
      return { steps: [], nextFacts: cloneFacts(currentFacts) };
    }
    if (depth > maxDepth) {
      return null;
    }
    const goalKey = stableFactKey(target);
    if (activeGoals.has(goalKey)) {
      return null;
    }

    const nextActive = new Set(activeGoals);
    nextActive.add(goalKey);

    let best: { steps: PlannedSkillCall[]; nextFacts: ConcreteFact[] } | null = null;

    // Handle singleton conflict (e.g., switching logged-in user A -> user B) via explicit clear skill if present.
    let preSteps: PlannedSkillCall[] = [];
    let workingBase = cloneFacts(currentFacts);
    if (target.singleton) {
      const conflicting = workingBase.find((f) => f.name === target.name && !factMatches(f, target));
      if (conflicting) {
        const clearer = orderedSkills.find(
          (s) =>
            (s.clears ?? []).includes(target.name) &&
            s.preconditions.every((pre) => {
              const pParams = resolveSkillInputs(s, {}, request);
              if (!pParams) return false;
              try {
                return stateSatisfies(workingBase, instantiatePredicate(pre, pParams));
              } catch {
                return false;
              }
            }),
        );
        if (clearer) {
          const clearParams = resolveSkillInputs(clearer, {}, request) ?? {};
          const clearProduces = clearer.produces.map((p) => instantiatePredicate(p, clearParams));
          const clearClears = [...(clearer.clears ?? [])];
          preSteps = [
            {
              skillId: clearer.id,
              params: clearParams,
              produces: clearProduces,
              clears: clearClears,
            },
          ];
          workingBase = applySkillEffects(workingBase, clearClears, clearProduces);
        }
      }
    }

    for (const skill of orderedSkills) {
      for (const produce of skill.produces) {
        if (produce.name !== target.name) {
          continue;
        }
        const unified = unifyPredicateParams(produce, target);
        if (!unified) {
          continue;
        }
        const resolvedInputs = resolveSkillInputs(skill, unified, request);
        if (!resolvedInputs) {
          continue;
        }

        // Satisfy preconditions sequentially
        let state = cloneFacts(workingBase);
        const collectedSteps: PlannedSkillCall[] = [...preSteps];
        let allPreOk = true;
        const concretePreconditions: ConcreteFact[] = [];

        for (const pre of skill.preconditions) {
          const concretePre = instantiatePredicate(pre, resolvedInputs);
          concretePreconditions.push(concretePre);
          const sub = achieve(state, concretePre, nextActive, depth + 1);
          if (!sub) {
            allPreOk = false;
            break;
          }
          collectedSteps.push(...sub.steps);
          state = sub.nextFacts;
        }
        if (!allPreOk) {
          continue;
        }

        // Guard against clobbered earlier preconditions (Sussman anomaly check)
        if (!concretePreconditions.every((cp) => stateSatisfies(state, cp))) {
          continue;
        }

        const produces = skill.produces.map((p) => instantiatePredicate(p, resolvedInputs));
        const clears = [...(skill.clears ?? [])];
        const finalFacts = applySkillEffects(state, clears, produces);
        if (!stateSatisfies(finalFacts, target)) {
          continue;
        }

        collectedSteps.push({
          skillId: skill.id,
          params: resolvedInputs,
          produces,
          clears,
        });

        if (
          best === null ||
          collectedSteps.length < best.steps.length ||
          (collectedSteps.length === best.steps.length &&
            collectedSteps.map((s) => s.skillId).join(",") <
              best.steps.map((s) => s.skillId).join(","))
        ) {
          best = { steps: collectedSteps, nextFacts: finalFacts };
        }
      }
    }

    return best;
  }

  const plan = achieve(initialState, goal, new Set(), 0);
  if (!plan) {
    throw new PlanningError(
      `Cannot construct a verified skill plan to reach ${stableFactKey(goal)}. Check skill preconditions, produces, and required input bindings.`,
    );
  }

  return {
    goal,
    steps: plan.steps,
    totalSkills: plan.steps.length,
    llmCallsUsed: 0,
  };
}
