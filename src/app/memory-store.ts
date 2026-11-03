/**
 * Compatibility surface for the host: the memory rules now live in `dsh-superagent-memory`, which registers itself as
 * a cordis service (`ctx.superagentMemory`). These wrappers keep the existing call sites — which pass the host store —
 * working unchanged, so the split is a change of implementation rather than a rewrite of every caller.
 */
import {
  RECALL_CARD_CHARS,
  RECALL_LIMIT,
  type RecallOptions,
  type RememberInput as PluginRememberInput,
} from 'dsh-superagent-memory'
import type { MemoryRecord } from '../core/model.ts'
import type { Store } from './store.ts'
import { memoryService } from './memory-bridge.ts'

export { RECALL_CARD_CHARS, RECALL_LIMIT }

/** What a caller must supply to record one fact; the package owns its meaning and its defaults. */
export type RememberInput = PluginRememberInput

export function isCurrent(memory: MemoryRecord, now = Date.now()): boolean {
  return memoryService().isCurrent(memory as never, now)
}

export function remember(store: Store, input: RememberInput): { memory: MemoryRecord; superseded?: MemoryRecord } {
  void store
  return memoryService().remember(input) as { memory: MemoryRecord; superseded?: MemoryRecord }
}

export function retract(store: Store, id: string): MemoryRecord {
  void store
  return memoryService().retract(id) as MemoryRecord
}

export function markUsed(store: Store, ids: readonly string[]): void {
  void store
  memoryService().markUsed(ids)
}

export function recallTerms(query: string): string[] {
  return memoryService().recallTerms(query)
}

export function recall(
  store: Store,
  query: string,
  options: { scope?: MemoryRecord['scope']; owner?: string; limit?: number } = {},
): MemoryRecord[] {
  void store
  return memoryService().recall(query, options as RecallOptions) as MemoryRecord[]
}

export function recallCard(entries: readonly MemoryRecord[], budget = RECALL_CARD_CHARS): string {
  return memoryService().recallCard(entries as never, budget)
}
