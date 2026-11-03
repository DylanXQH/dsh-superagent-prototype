import { describe, expect, it } from 'vitest'
import { analysis, builtinTaskKinds, codeChange, fileChange, normalizeArtifact, TaskKindRegistry } from '../src/core/index.ts'
import type { Ticket } from '../src/core/index.ts'

/** A ticket whose title and intent are the words a kind routes on; nothing else is read by these seams. */
const ticket = (title: string, overrides: Partial<Ticket> = {}): Ticket =>
  ({ id: 't1', title, intent: title, summary: '', channels: [], assignments: [], inputs: [], undelivered: [], ...overrides }) as unknown as Ticket

describe('task kind selection (axiom 1)', () => {
  const registry = builtinTaskKinds()
  it('routes a request that produces files to file-change when it names no repository', () => {
    expect(registry.select({ text: '生成一份 notes/p4-kind.txt 记录探针结果' }).id).toBe('file-change')
    expect(registry.select({ text: 'write a markdown report about the latest run' }).id).toBe('file-change')
  })
  it('routes an analysis request to analysis', () => {
    expect(registry.select({ text: '帮我分析这段日志为什么失败，并总结根因' }).id).toBe('analysis')
    expect(registry.select({ text: 'summarize what the last three runs found' }).id).toBe('analysis')
  })
  it('keeps a request that names a repository in code-change, even when it produces files', () => {
    expect(registry.select({ title: '生成 docs/report.md', text: '生成 docs/report.md 并开 PR' }).id).toBe('code-change')
    expect(registry.select({ text: 'update the README in the repo and commit it' }).id).toBe('code-change')
  })
  it('does not read a request that says not to open a PR as repository work', () => {
    expect(registry.select({ text: '生成一份 notes/p4-kind.txt 记录探针结果，不要开 PR' }).id).toBe('file-change')
  })
  it('falls back to the default kind when nothing matches', () => {
    expect(registry.select({ text: '梳理一下这次事故的时间线' }).id).toBe('analysis')
    expect(registry.select({ text: '把部署配置改成两台机器' }).id).toBe('code-change')
  })
  it('selects from configured rules first, so a deployment routes without an executor change', () => {
    const rules = [{ id: 'analysis', match: ['生成.*报告'] }]
    expect(registry.select({ text: '生成一份报告', rules }).id).toBe('analysis')
    // A configured rule also decides when the request names a repository: configuration, not the heuristic, is the opinion.
    expect(registry.select({ text: '生成一份报告并开 PR', rules }).id).toBe('analysis')
  })
  it('accepts a task kind added by registration, so extension needs one implementation and one rule', () => {
    const extended = new TaskKindRegistry()
    const replyComment = {
      id: 'reply-comment', workspace: 'workspace' as const,
      deliver: () => ({ text: 'commented' }), verify: () => ({ ok: true as const }),
    }
    extended.register(replyComment)
    expect(extended.select({ text: '在这条 issue 下回复一句确认', rules: [{ id: 'reply-comment', match: ['回复'] }] }).id).toBe('reply-comment')
    expect(extended.select({ text: '普通请求' }).id).toBe('code-change')
  })
  it('resolves a ticket from its stored execution, and defaults old tickets to code-change', () => {
    expect(registry.resolve(ticket('x', { execution: { name: 'x', directory: '/w/x', assignment: '', taskKind: 'file-change' } })).id).toBe('file-change')
    expect(registry.resolve(ticket('x')).id).toBe('code-change')
  })
})

describe('task kind seams (axiom 1)', () => {
  const context = (title = '生成报告') => ({ ticket: ticket(title), text: title })
  it('verifies a file task only when a ready report names an artifact reference', () => {
    expect(fileChange.verify(context(), { state: 'ready', summary: 'done' }).ok).toBe(false)
    expect(fileChange.verify(context(), { state: 'ready', summary: 'done', completed: [{ item: 'notes/x.md', artifact: { kind: 'file', uri: 'worker://w1/notes/x.md' } }] }).ok).toBe(true)
    expect(fileChange.verify(context(), { state: 'progress', summary: 'working' }).ok).toBe(true)
  })
  it('verifies an analysis task by its findings and a code task by a closed item list', () => {
    expect(analysis.verify(context(), { state: 'ready', summary: 'short' }).ok).toBe(false)
    expect(analysis.verify(context(), { state: 'ready', summary: 'the failure came from an empty token because the profile lost its key' }).ok).toBe(true)
    expect(codeChange.verify(context(), { state: 'ready', summary: 'done', remaining: ['finish tests'] }).ok).toBe(false)
    expect(codeChange.verify(context(), { state: 'ready', summary: 'done' }).ok).toBe(true)
  })
  it('delivers each kind in its own words: a PR, the produced files, or the findings', () => {
    expect(codeChange.deliver(context('修复登录'), { state: 'ready', summary: 'fixed', pull: { number: 42, url: 'https://github.com/a/b/pull/42' } })!.text)
      .toContain('PR #42 https://github.com/a/b/pull/42')
    expect(codeChange.deliver(context('修复登录'), { state: 'ready', summary: 'fixed' })!.text).toContain('没有改动需要合并')
    const files = fileChange.deliver(context('生成报告'), { state: 'ready', summary: 'written',
      completed: [{ item: 'a', artifact: { kind: 'file', uri: 'worker://w1/a.md' } }] })!.text
    expect(files).toContain('产物：worker://w1/a.md')
    expect(files).not.toContain('没有改动需要合并')
    expect(analysis.deliver(context('分析日志'), { state: 'ready', summary: 'root cause is x' })!.text).toContain('✅ 任务完成：分析日志')
  })
  it('gives a non-repository kind assignment text that says no clone and no PR are needed', () => {
    expect(fileChange.note!(context())).toContain('no clone, no branch and no pull request')
    expect(analysis.note!(context())).toContain('no clone, no branch and no pull request')
    expect(codeChange.note).toBeUndefined()
  })
})

describe('artifact references (axiom 1, §3.2)', () => {
  it('keeps a valid reference and drops content that is not one', () => {
    expect(normalizeArtifact({ kind: 'file', uri: 'worker://w1/a.md', size: 12, sha256: 'abc', mime: 'text/markdown' }))
      .toEqual({ kind: 'file', uri: 'worker://w1/a.md', size: 12, sha256: 'abc', mime: 'text/markdown' })
    expect(normalizeArtifact({ kind: 'video', uri: 'worker://w1/a.mp4' })).toBeUndefined()
    expect(normalizeArtifact({ kind: 'file' })).toBeUndefined()
    expect(normalizeArtifact({ kind: 'file', uri: '   ' })).toBeUndefined()
    expect(normalizeArtifact('data:image/png;base64,AAAA')).toBeUndefined()
    expect(normalizeArtifact({ kind: 'file', uri: 'worker://w1/a.md', content: 'x'.repeat(1000) })).toEqual({ kind: 'file', uri: 'worker://w1/a.md' })
  })
  it('bounds an inline preview instead of storing the content', () => {
    const preview = 'p'.repeat(70 * 1024)
    expect(normalizeArtifact({ kind: 'log', uri: 'worker://w1/run.log', preview })!.preview).toHaveLength(64 * 1024)
  })
})
