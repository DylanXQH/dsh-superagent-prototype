/**
 * Wiring between the host and the `dsh-superagent-memory` package.
 *
 * The package owns the memory rules (source provenance, capped confidence, supersede chains, recall ranking) and the
 * sqlite table stays the host's, because the host already has one transaction boundary and a second database would
 * mean two failure modes. This module adapts the row shape to the package's store contract and keeps the one service
 * instance reachable from the call sites that predate the split.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  MemoryService,
  type MemoryQuery,
  type MemoryRecord as PluginMemoryRecord,
  type MemoryStore,
} from 'dsh-superagent-memory'
import type { MemoryRecord } from '../core/model.ts'
import type { Store } from './store.ts'

function asPlugin(record: MemoryRecord): PluginMemoryRecord {
  return record as unknown as PluginMemoryRecord
}

function asHost(record: PluginMemoryRecord): MemoryRecord {
  return record as unknown as MemoryRecord
}

/** The package's store contract over the host's `memory` table. */
export function memoryStoreOf(store: Store): MemoryStore {
  return {
    get: id => {
      const row = store.memories.get(id)
      return row === undefined ? undefined : asPlugin(row)
    },
    save: memory => {
      store.memories.save(asHost(memory))
    },
    list: (query?: MemoryQuery) =>
      store.memories
        .list(query as { scope?: MemoryRecord['scope']; kind?: MemoryRecord['kind']; owner?: string; limit?: number })
        .map(asPlugin),
    atomic: run => store.atomic(run),
  }
}

let installed: MemoryService | undefined

/** Installs the one service the host uses. Called while the runtime is constructed, before anything can recall. */
export function installMemory(service: MemoryService): MemoryService {
  installed = service
  return service
}

/**
 * Builds and installs the service over this store. Registering it on the runtime's own context means the package's
 * lifecycle follows the plugin's: an unload removes `ctx.superagentMemory` with the rest of the fiber.
 */
export function createMemory(ctx: Context, store: Store, stateDir: string): MemoryService {
  return installMemory(new MemoryService(ctx, { store: memoryStoreOf(store), stateDir }))
}

export function memoryService(): MemoryService {
  if (installed === undefined) throw new Error('the memory service is not installed yet')
  return installed
}
