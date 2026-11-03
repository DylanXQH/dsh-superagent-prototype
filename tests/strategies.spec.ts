import { describe, expect, it } from 'vitest'
import { builtinStrategies, builtinTaskKinds, StrategyRegistry } from '../src/core/index.ts'
import type { AssignmentCandidate, AssignmentStrategy, PlanningStrategy, TriageStrategy } from '../src/core/index.ts'

const candidate = (id: string, load: number, capacity: number, tags: Record<string, string> = {}): AssignmentCandidate =>
  ({ id, load, capacity, tags })

describe('strategy selection (axiom 7)', () => {
  it('ships defaults and resolves an unknown id to the layer default', () => {
    const strategies = builtinStrategies()
    expect(strategies.triage().id).toBe('default')
    expect(strategies.planning().id).toBe('default')
    expect(strategies.assignment().id).toBe('least-loaded')
    expect(strategies.review().id).toBe('verify')
    expect(strategies.triage('rules-only').id).toBe('rules-only')
    expect(strategies.assignment('no-such-strategy').id).toBe('least-loaded')
  })

  it('lets a deployment register its own strategy and select it by id', () => {
    const registry = new StrategyRegistry()
    const never: TriageStrategy = { id: 'never', decide: () => ({ decision: 'ignore', facts: [{ name: 'why', value: 'never' }] }) }
    const tagging: AssignmentStrategy = { id: 'prefer-gpu', choose: input => ({ id: input.candidates.at(-1)?.id, facts: [{ name: 'why', value: 'prefer-gpu' }] }) }
    const planner: PlanningStrategy = { id: 'prefix', plan: input => ({ title: `[P] ${input.title}`, scope: input.scope, facts: [] }) }
    registry.register('triage', never)
    registry.register('assignment', tagging)
    registry.register('planning', planner)
    expect(registry.triage('never').decide({ strength: 'explicit', rules: [], explicit: true }).decision).toBe('ignore')
    expect(registry.assignment('prefer-gpu').choose({ candidates: [candidate('a', 0, 2), candidate('b', 0, 2)], requiredTags: {} }))
      .toEqual({ id: 'b', facts: [{ name: 'why', value: 'prefer-gpu' }] })
    expect(registry.planning('prefix').plan({ title: 'Fix', scope: 'small' }).title).toBe('[P] Fix')
  })
})

describe('triage and planning strategies', () => {
  it('rules-only holds an inferred candidate whose assessment matched no rule', () => {
    const registry = builtinStrategies()
    const verdict = registry.triage('rules-only').decide({ strength: 'inferred', rules: [], explicit: false })
    expect(verdict.decision).toBe('ignore')
    expect(verdict.facts).toContainEqual({ name: 'held', value: 'no admission rule matched' })
    expect(registry.triage('rules-only').decide({ strength: 'inferred', rules: ['answer-questions'], explicit: false }).decision).toBe('accept')
    expect(registry.triage('rules-only').decide({ strength: 'explicit', rules: [], explicit: true }).decision).toBe('accept')
  })

  it('bounded planning caps the scope and title and records that it did', () => {
    const verdict = builtinStrategies().planning('bounded').plan({ title: 'T'.repeat(200), scope: 'S'.repeat(1000) })
    expect(verdict.title).toHaveLength(120)
    expect(verdict.scope.length).toBeLessThanOrEqual(802)
    expect(verdict.facts).toContainEqual({ name: 'scope_chars', value: '1000' })
    expect(verdict.facts).toContainEqual({ name: 'scope_capped', value: 'true' })
    expect(builtinStrategies().planning('default').plan({ title: 'Fix', scope: 'small' })).toMatchObject({ title: 'Fix', scope: 'small' })
  })
})

describe('assignment strategies', () => {
  it('least-loaded takes the free worker with the smallest load', () => {
    const choice = builtinStrategies().assignment('least-loaded').choose({ candidates: [
      candidate('busy', 2, 2), candidate('idle', 0, 2), candidate('warm', 1, 2),
    ], requiredTags: {} })
    expect(choice.id).toBe('idle')
    expect(choice.facts).toContainEqual({ name: 'candidates', value: '3 (2 free)' })
  })

  it('tag-match keeps only workers that report every required tag, then takes the least loaded', () => {
    const choice = builtinStrategies().assignment('tag-match').choose({ candidates: [
      candidate('guangzhou', 0, 2, { zone: 'cn-guangzhou' }),
      candidate('shenzhen', 1, 2, { zone: 'cn-shenzhen', 'tool.chrome': 'true' }),
    ], requiredTags: { zone: 'cn-shenzhen' } })
    expect(choice.id).toBe('shenzhen')
    expect(choice.facts).toContainEqual({ name: 'required_tags', value: 'zone=cn-shenzhen' })
    expect(choice.facts).toContainEqual({ name: 'tag_matched', value: '1 of 2' })
  })

  it('tag-match falls back to least load when no worker matches', () => {
    const choice = builtinStrategies().assignment('tag-match').choose({ candidates: [
      candidate('a', 1, 2, { zone: 'cn-guangzhou' }), candidate('b', 0, 2, { zone: 'cn-guangzhou' }),
    ], requiredTags: { zone: 'cn-shenzhen' } })
    expect(choice.id).toBe('b')
    expect(choice.facts).toContainEqual({ name: 'tag_matched', value: 'no worker matched; fell back to least load' })
  })
})

describe('review strategies', () => {
  const kinds = builtinTaskKinds()
  const file = kinds.get('file-change')!
  const analysis = kinds.get('analysis')!
  const ticket = {} as never

  it('verify delegates the decision to the task kind', () => {
    const verdict = builtinStrategies().review('verify').review({ kind: file, ticket,
      report: { state: 'ready', summary: 'done' } })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toBeTruthy()
    expect(verdict.facts).toContainEqual({ name: 'kind', value: 'file-change' })
    expect(builtinStrategies().review('verify').review({ kind: file, ticket, report: { state: 'ready', summary: 'done',
      completed: [{ item: 'notes/a.md', artifact: { kind: 'file', uri: 'worker://w/notes/a.md' } }] } }).ok).toBe(true)
  })

  it('artifacts-required rejects a ready report that names no artifact', () => {
    const verdict = builtinStrategies().review('artifacts-required').review({ kind: analysis, ticket,
      report: { state: 'ready', summary: 'A'.repeat(80) } })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('artifact')
    expect(builtinStrategies().review('artifacts-required').review({ kind: analysis, ticket, report: { state: 'ready',
      summary: 'A'.repeat(80), completed: [{ item: 'report', artifact: { kind: 'report', uri: 'worker://w/report.md' } }] } }).ok).toBe(true)
  })
})
