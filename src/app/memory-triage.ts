/**
 * Deterministic triage of standing instructions in a person's message (M1 candidates).
 *
 * This is the "learning" half of the memory loop that may run without a model: it recognises the handful of shapes in which
 * people state a durable preference ("以后都用中文提交", "记住我习惯…", "always use pnpm"), and records them as memory entries.
 * It never edits prompts or behaviour — a `convention` recorded here is only ever shown back as background.
 */
import { randomUUID } from 'node:crypto'
import type { MemoryRecord } from '../core/index.ts'
import { remember } from './memory-store.ts'
import type { Store } from './store.ts'

/** Most entries one message may contribute, so a long message cannot flood memory. */
export const TRIAGE_MAX_PER_MESSAGE = 5
/** Longest message considered; anything longer is a document, not a standing instruction. */
export const TRIAGE_MAX_CHARS = 2000

/** Matched instruction: the durable content and whether it reads like a project convention. */
interface Instruction {
  readonly content: string
  readonly kind: MemoryRecord['kind']
}

/** Words that make an instruction about the project rather than about the person. */
const CONVENTION_WORDS = /提交|commit|分支|branch|命名|naming|格式|format|风格|style|目录|directory|测试|test|文档|docs|readme|依赖|dependency|版本|version|review|评审/i

/**
 * Recognises standing-instruction shapes and returns the durable content they carry.
 * Rules are intentionally few and literal: a missed instruction costs one clarification, while a wrong one pollutes every
 * future recall, so ambiguous text is left alone.
 */
export function instructions(text: string): Instruction[] {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > TRIAGE_MAX_CHARS) return []
  const found: Instruction[] = []
  const push = (raw: string): void => {
    const content = raw.trim().replace(/^[：:，,、\s]+/, '').replace(/^(?:用|要|请|都|得)\s*/, '').replace(/[。.;；\s]+$/, '')
    if (content.length < 2 || content.length > 300) return
    // Drop echoes: a later rule often re-extracts a tail of what an earlier rule already captured.
    if (found.some(item => item.content.includes(content) || content.includes(item.content))) return
    found.push({ content, kind: CONVENTION_WORDS.test(content) ? 'convention' : 'preference' })
  }
  const rememberVerb = /^(?:请)?(?:记住|记一下|记下|帮我记住)[：:，,、\s]*(?<content>.+)$/u.exec(trimmed)
  if (rememberVerb?.groups?.content) push(rememberVerb.groups.content)
  const englishRemember = /^(?:please\s+)?remember(?:\s+that)?[:,]?\s+(?<content>.+)$/i.exec(trimmed)
  if (englishRemember?.groups?.content) push(englishRemember.groups.content)
  const alwaysNever = /^(?:always|never)\s+(?<content>.+)$/i.exec(trimmed)
  if (alwaysNever?.groups?.content) push(`${/^never/i.test(trimmed) ? 'Never ' : 'Always '}${alwaysNever.groups.content}`)
  // "以后都用 X" / "今后一律 …" — a standing instruction introduced by a time adverb and a modal.
  const standing = /(?:以后|今后|之后|后续|往后)[^。；;\n]{0,12}?(?:都|一律|统一|始终|请|要)(?<content>[^。；;\n]{3,300})$/u.exec(trimmed)
  if (standing?.groups?.content) push(standing.groups.content)
  return found.slice(0, TRIAGE_MAX_PER_MESSAGE)
}

/** A stable key so restating the same instruction supersedes its previous version instead of piling up. */
export function instructionKey(content: string): string {
  const slug = content.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return `standing-${slug || randomUUID().slice(0, 8)}`
}

/** What triage learned from one message, and what it deliberately left untouched. */
export interface TriageResult {
  readonly saved: MemoryRecord[]
  readonly skipped: number
}

/**
 * Records standing instructions from `text`.
 * @param ticketId the ticket the message belongs to, kept as evidence so an entry can be traced back to what was said.
 */
export function triageMessage(store: Store, text: string, options: { ticketId?: string; actor?: string } = {}): TriageResult {
  const found = instructions(text)
  const saved: MemoryRecord[] = []
  let skipped = 0
  const current = store.memories.list({ limit: 1000 }).filter(entry => !entry.supersededBy && !entry.retractedAt)
  for (const instruction of found) {
    if (current.some(entry => entry.value === instruction.content)) { skipped += 1; continue }
    const evidence = [`message:${text.slice(0, 120)}`]
    if (options.ticketId) evidence.push(`ticket:${options.ticketId}`)
    if (options.actor) evidence.push(`actor:${options.actor}`)
    const result = remember(store, { scope: 'user', kind: instruction.kind, key: instructionKey(instruction.content),
      value: instruction.content, confidence: 0.9, source: 'user-said', evidence })
    saved.push(result.memory)
  }
  return { saved, skipped }
}
