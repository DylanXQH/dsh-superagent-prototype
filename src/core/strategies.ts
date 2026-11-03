/**
 * The four decision layers of the router, each replaceable without touching the layer that calls it.
 *
 * Triage decides whether an accepted candidate becomes work, planning fixes the scope a Ticket runs under, assignment
 * picks the worker a Ticket's next Assignment runs on, and review decides whether a ready report is accepted. A
 * deployment selects one strategy per layer in `settings.policy.strategies` and gets its facts recorded in the
 * Ticket's basis chain (`StrategyTrace`), so a decision can be explained later without replaying it.
 */
import type { ArtifactRef, AssignmentCandidate, ReportState, StrategyConfig, StrategyFact, Strength, Ticket } from './model.ts'
import type { TaskKind } from './task-kind.ts'

/** What triage sees: the gate's strength, the admission rules the assessment matched, and whether the request was explicit. */
export interface TriageInput { strength: Strength; rules: readonly string[]; explicit: boolean }
export interface TriageVerdict { decision: 'accept' | 'ignore'; facts: StrategyFact[] }
export interface TriageStrategy { id: string; decide(input: TriageInput): TriageVerdict }

/** What planning sees: the title and scope the assessment proposed. */
export interface PlanningInput { title: string; scope: string }
export interface PlanningVerdict { title: string; scope: string; facts: StrategyFact[] }
export interface PlanningStrategy { id: string; plan(input: PlanningInput): PlanningVerdict }

export interface AssignmentInput { candidates: readonly AssignmentCandidate[]; requiredTags: Record<string, string | number | boolean> }
export interface AssignmentVerdict { id?: string; facts: StrategyFact[] }
export interface AssignmentStrategy { id: string; choose(input: AssignmentInput): AssignmentVerdict }

/** What a ready report says, as a review strategy reads it: a reference view, never the artifact content. */
export interface ReviewReport {
  state: ReportState
  summary: string
  completed?: { item: string; artifact?: ArtifactRef }[]
  remaining?: string[]
  failed?: { item: string; reason: string; retryable: boolean }[]
}
export interface ReviewInput { kind: TaskKind; report: ReviewReport; ticket: Ticket }
export interface ReviewVerdict { ok: boolean; reason?: string; facts: StrategyFact[] }
export interface ReviewStrategy { id: string; review(input: ReviewInput): ReviewVerdict }

/** Triage that keeps what the assessment decided; the default, and what a deployment that configures nothing gets. */
const triageDefault: TriageStrategy = {
  id: 'default',
  decide(input) {
    return { decision: 'accept', facts: [
      { name: 'strength', value: input.strength },
      { name: 'explicit', value: String(input.explicit) },
      { name: 'rules', value: input.rules.length ? input.rules.join(', ') : '(none)' },
    ] }
  },
}

/** Triage that accepts an inferred candidate only when its assessment matched at least one admission rule. */
const triageRulesOnly: TriageStrategy = {
  id: 'rules-only',
  decide(input) {
    const facts: StrategyFact[] = [
      { name: 'strength', value: input.strength },
      { name: 'rules', value: input.rules.length ? input.rules.join(', ') : '(none)' },
    ]
    if (input.explicit || input.rules.length > 0) return { decision: 'accept', facts }
    return { decision: 'ignore', facts: [...facts, { name: 'held', value: 'no admission rule matched' }] }
  },
}

/** Planning that keeps the assessed title and scope. */
const planningDefault: PlanningStrategy = {
  id: 'default',
  plan(input) {
    return { title: input.title, scope: input.scope, facts: [
      { name: 'scope_chars', value: String(input.scope.length) },
    ] }
  },
}

/** Planning that bounds what a Ticket may be asked for: a short scope sentence, not an essay, and a short title. */
const planningBounded: PlanningStrategy = {
  id: 'bounded',
  plan(input) {
    const scope = input.scope.trim()
    const bounded = scope.length > 800 ? `${scope.slice(0, 800).trimEnd()} …` : scope
    const title = input.title.trim().slice(0, 120)
    return { title, scope: bounded, facts: [
      { name: 'scope_chars', value: String(scope.length) },
      { name: 'scope_capped', value: String(bounded.length !== scope.length) },
    ] }
  },
}

/** Assignment by least load: of the workers with free capacity, the one with the fewest running and reserved Sessions. */
const assignmentLeastLoaded: AssignmentStrategy = {
  id: 'least-loaded',
  choose(input) {
    const free = input.candidates.filter(candidate => candidate.load < candidate.capacity)
      .sort((left, right) => left.load - right.load)
    const chosen = free[0]
    return { ...chosen ? { id: chosen.id } : {}, facts: [
      { name: 'candidates', value: `${input.candidates.length} (${free.length} free)` },
      ...chosen ? [{ name: 'load', value: `${chosen.load}/${chosen.capacity}` }] : [],
    ] }
  },
}

/** Assignment that first keeps only workers whose reported tags include every required tag, then picks the least loaded. */
const assignmentTagMatch: AssignmentStrategy = {
  id: 'tag-match',
  choose(input) {
    const required = Object.entries(input.requiredTags)
    const facts: StrategyFact[] = [
      { name: 'required_tags', value: required.length ? required.map(([name, value]) => `${name}=${String(value)}`).join(', ') : '(none)' },
    ]
    const free = input.candidates.filter(candidate => candidate.load < candidate.capacity)
    const matches = free.filter(candidate => required.every(([name, value]) => candidate.tags[name] !== undefined
      && String(candidate.tags[name]) === String(value)))
    const pool = matches.length ? matches : free
    if (matches.length) facts.push({ name: 'tag_matched', value: `${matches.length} of ${free.length}` })
    else if (required.length) facts.push({ name: 'tag_matched', value: 'no worker matched; fell back to least load' })
    const chosen = [...pool].sort((left, right) => left.load - right.load)[0]
    return { ...chosen ? { id: chosen.id } : {}, facts: [...facts,
      ...chosen ? [{ name: 'load', value: `${chosen.load}/${chosen.capacity}` }] : [],
    ] }
  },
}

/** Review that asks the TaskKind's own verify seam: the default, so every kind keeps its acceptance rule. */
const reviewVerify: ReviewStrategy = {
  id: 'verify',
  review(input) {
    const verdict = input.kind.verify({ ticket: input.ticket, text: '' }, input.report)
    return { ok: verdict.ok, ...verdict.ok ? {} : { reason: verdict.reason }, facts: [
      { name: 'kind', value: input.kind.id },
      { name: 'artifacts', value: String(input.report.completed?.filter(item => item.artifact).length ?? 0) },
    ] }
  },
}

/** Review that requires at least one artifact reference for any ready report, whatever the kind's own rule says. */
const reviewArtifactsRequired: ReviewStrategy = {
  id: 'artifacts-required',
  review(input) {
    const artifacts = input.report.completed?.filter(item => item.artifact).length ?? 0
    const facts: StrategyFact[] = [{ name: 'kind', value: input.kind.id }, { name: 'artifacts', value: String(artifacts) }]
    if (input.report.state === 'ready' && artifacts === 0) return { ok: false,
      reason: 'This deployment accepts a ready report only when it names at least one artifact reference in completed[].', facts }
    const verdict = input.kind.verify({ ticket: input.ticket, text: '' }, input.report)
    return { ok: verdict.ok, ...verdict.ok ? {} : { reason: verdict.reason }, facts }
  },
}

/** Registry of strategies per layer: a deployment registers implementations and selects them by id in settings. */
export class StrategyRegistry {
  readonly #triages = new Map<string, TriageStrategy>()
  readonly #plannings = new Map<string, PlanningStrategy>()
  readonly #assignments = new Map<string, AssignmentStrategy>()
  readonly #reviews = new Map<string, ReviewStrategy>()

  constructor(input: {
    triage?: readonly TriageStrategy[]
    planning?: readonly PlanningStrategy[]
    assignment?: readonly AssignmentStrategy[]
    review?: readonly ReviewStrategy[]
  } = {}) {
    for (const strategy of input.triage ?? [triageDefault, triageRulesOnly]) this.register('triage', strategy)
    for (const strategy of input.planning ?? [planningDefault, planningBounded]) this.register('planning', strategy)
    for (const strategy of input.assignment ?? [assignmentLeastLoaded, assignmentTagMatch]) this.register('assignment', strategy)
    for (const strategy of input.review ?? [reviewVerify, reviewArtifactsRequired]) this.register('review', strategy)
  }

  /** Registers a strategy for its layer, replacing one of the same id so a deployment can override a built-in. */
  register(layer: 'triage', strategy: TriageStrategy): void
  register(layer: 'planning', strategy: PlanningStrategy): void
  register(layer: 'assignment', strategy: AssignmentStrategy): void
  register(layer: 'review', strategy: ReviewStrategy): void
  register(layer: 'triage' | 'planning' | 'assignment' | 'review', strategy: TriageStrategy | PlanningStrategy | AssignmentStrategy | ReviewStrategy): void {
    if (layer === 'triage') this.#triages.set((strategy as TriageStrategy).id, strategy as TriageStrategy)
    else if (layer === 'planning') this.#plannings.set((strategy as PlanningStrategy).id, strategy as PlanningStrategy)
    else if (layer === 'assignment') this.#assignments.set((strategy as AssignmentStrategy).id, strategy as AssignmentStrategy)
    else this.#reviews.set((strategy as ReviewStrategy).id, strategy as ReviewStrategy)
  }

  triage(id?: string): TriageStrategy { return this.#triages.get(id ?? 'default') ?? triageDefault }
  planning(id?: string): PlanningStrategy { return this.#plannings.get(id ?? 'default') ?? planningDefault }
  assignment(id?: string): AssignmentStrategy { return this.#assignments.get(id ?? 'least-loaded') ?? assignmentLeastLoaded }
  review(id?: string): ReviewStrategy { return this.#reviews.get(id ?? 'verify') ?? reviewVerify }
}

/** The strategies this router ships with, plus registration and selection. */
export const builtinStrategies = (): StrategyRegistry => new StrategyRegistry()
