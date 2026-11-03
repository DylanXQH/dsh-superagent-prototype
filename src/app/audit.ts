/**
 * The audit trail: every change to what the agent believes or how it is told to behave, in one append-only file.
 *
 * The design requires that a change be attributable — "who changed this, when, on what evidence, and did it survive the
 * observation window". The store already keeps every prompt revision and every memory entry, so the audit file is not a
 * second source of truth: it is the one place a person (or a weekly report) can read as a chronological story without
 * joining three tables. It is JSON-lines because appending must never rewrite history, and a truncated tail must still
 * leave every earlier line readable.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export interface AuditEntry {
  /** What changed: a prompt revision, a memory write, a retraction, a rollback, or a gate self-test. */
  kind: 'prompts' | 'memory' | 'retract' | 'rollback' | 'canary'
  /** The revision a change produced, when it has one. */
  revision?: number
  previousRevision?: number | null
  /** Who caused it: `panel`, `tool`, `chat`, `system`, or `rollback`. */
  source: string
  /** A short, human-readable summary; never the full text (the store holds that). */
  summary: string
  /** How many gate findings the change carried, by severity. */
  findings?: { block: number; warn: number }
  /** Free-form detail the writer wants a reader a week later to still understand. */
  detail?: Record<string, unknown>
}

/** Appends one entry. Failures are swallowed by the caller's policy: an audit write must never fail the change it records. */
export async function appendAudit(stateDir: string, entry: AuditEntry): Promise<void> {
  const path = join(stateDir, 'memory-audit.jsonl')
  await mkdir(stateDir, { recursive: true })
  await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
}
