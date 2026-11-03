/**
 * P0 memory: a deterministic, model-free record of what a finished ticket was and did.
 * Built only from facts the Store already holds, so it can be written inside the ending transaction, costs nothing, and
 * never invents anything. Later phases read these records to learn; nothing here changes behaviour on its own.
 */
import { threadKey, type Episode, type Ticket } from '../core/model.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'

/** How many episodes the index lists; older records stay readable by id, they simply leave the list. */
export const EPISODE_INDEX_LIMIT = 500
/** How far back a new ticket may reach to count as redoing an earlier one's work. */
export const REWORK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** How many recent episodes a rework check looks at; bounded so recording an episode stays cheap. */
const REWORK_SCAN = 20

/** The text a person or Source actually wrote for an Input, or nothing when it carries none. */
const inputText = (store: Store, ticket: Ticket, input: Ticket['inputs'][number]): string => {
  if (input.kind === 'trigger') {
    const own = input.id === ticket.inputs[0]?.id
    // A Trigger reached as a note is context the worker did not act on its own; keep it out of the follow-up list.
    if (input.context) return ''
    return store.triggers.get(input.triggerId)?.text?.trim() ?? (own ? '' : '')
  }
  if (input.kind === 'text' || input.kind === 'note') return input.kind === 'text' ? input.text.trim() : ''
  return ''
}

/**
 * Builds the episode of an ended ticket from stored facts alone.
 * @param store the Store holding the ticket's Triggers.
 * @param ticket a ticket with `ended` set; the caller checks that.
 */
export function buildEpisode(store: Store, ticket: Ticket): Episode {
  const ended = ticket.ended!
  const intent = store.triggers.get(ticket.origin.triggerId)?.text?.trim() ?? ''
  const followUps = ticket.inputs
    .filter(input => input.id !== ticket.origin.triggerId)
    .map(input => inputText(store, ticket, input))
    .filter(text => text.length > 0)
    // Keep the record bounded: a long conversation is summarised by its first few messages rather than copied whole.
    .slice(0, 20)
  const createdAt = ticket.createdAt
  const endedAt = ended.at
  const durationMs = Date.parse(endedAt) - Date.parse(createdAt)
  const rework = reworkOfEarlier(store, ticket)
  return {
    id: ticket.id,
    ticketId: ticket.id,
    intent,
    triggerId: ticket.origin.triggerId,
    ...(ticket.title ? { title: ticket.title } : {}),
    ...(ticket.execution?.assignment ? { plan: ticket.execution.assignment } : {}),
    ...(ticket.execution?.directory ? { directory: ticket.execution.directory } : {}),
    outcome: ended.outcome,
    endedBy: ended.by,
    ...(ended.reason ? { reason: ended.reason } : {}),
    followUps,
    answers: [...(ticket.answers ?? [])],
    assignments: ticket.assignments.length,
    createdAt,
    endedAt,
    durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    ...rework,
  }
}

/** The thread a trigger belongs to, which is what makes two tickets "the same conversation". */
const threadOf = (store: Store, triggerId: string): string | undefined => {
  const thread = store.triggers.get(triggerId)?.threads?.[0]
  return thread ? threadKey(thread) : undefined
}

/**
 * Finds the earlier episode this ticket redid, if any.
 *
 * Deterministic on purpose: the same thread, an earlier ending, and a start inside {@link REWORK_WINDOW_MS}. It does not
 * try to judge whether the rework was justified — it only counts that the work came back, which is exactly the signal
 * that offsets "fewer clarifying questions".
 */
function reworkOfEarlier(store: Store, ticket: Ticket): Pick<Episode, 'reworkOf' | 'reworkGapMs'> {
  const thread = threadOf(store, ticket.origin.triggerId)
  if (!thread) return {}
  const startedAt = Date.parse(ticket.createdAt)
  if (!Number.isFinite(startedAt)) return {}
  const index = (store.get(KV.episodes.index) ?? []).slice(0, REWORK_SCAN)
  for (const id of index) {
    if (id === ticket.id) continue
    const earlier = store.get(KV.episodes.one(id))
    if (!earlier || earlier.outcome !== 'completed') continue
    const gap = startedAt - Date.parse(earlier.endedAt)
    if (!Number.isFinite(gap) || gap < 0 || gap > REWORK_WINDOW_MS) continue
    if (threadOf(store, earlier.triggerId) !== thread) continue
    return { reworkOf: earlier.id, reworkGapMs: gap }
  }
  return {}
}

/**
 * Records the episode of a ticket that just ended, and moves it to the front of the index.
 * Idempotent: an ending recorded twice replaces its entry rather than duplicating it.
 * @returns the written episode, or undefined when the ticket has not ended.
 */
export function recordEpisode(store: Store, ticket: Ticket): Episode | undefined {
  if (!ticket.ended) return undefined
  const episode = buildEpisode(store, ticket)
  store.set(KV.episodes.one(ticket.id), episode)
  const index = store.get(KV.episodes.index) ?? []
  store.set(KV.episodes.index, [ticket.id, ...index.filter(id => id !== ticket.id)].slice(0, EPISODE_INDEX_LIMIT))
  return episode
}

/** Episodes, newest first, skipping any index entry whose record is gone. */
export function listEpisodes(store: Store, limit = 50): Episode[] {
  const index = store.get(KV.episodes.index) ?? []
  const episodes: Episode[] = []
  for (const id of index) {
    const episode = store.get(KV.episodes.one(id))
    if (episode) episodes.push(episode)
    if (episodes.length >= limit) break
  }
  return episodes
}

/** One episode by ticket id. */
export function readEpisode(store: Store, ticketId: string): Episode | undefined {
  return store.get(KV.episodes.one(ticketId))
}

/** The numbers a person checks to see whether the agent is getting better, or just quieter. */
export interface EpisodeStats {
  total: number
  completed: number
  rework: number
  /**
   * Share of completed episodes that came back for changes. Read it together with `averageClarifications`:
   * asking fewer questions is only an improvement when this stays flat or falls.
   */
  reworkRate: number
  /** Mean of `followUps.length + answers.length`: how much had to be said before the work was right. */
  averageClarifications: number
  averageDurationMs: number
}

/** Aggregates the stored episodes; bounded by the index so the cost stays flat. */
export function episodeStats(store: Store, limit = 200): EpisodeStats {
  const episodes = listEpisodes(store, limit)
  const completed = episodes.filter(episode => episode.outcome === 'completed')
  const rework = completed.filter(episode => episode.reworkOf !== undefined).length
  const clarifications = episodes.reduce((sum, episode) => sum + episode.followUps.length + episode.answers.length, 0)
  const duration = episodes.reduce((sum, episode) => sum + episode.durationMs, 0)
  const total = episodes.length
  return {
    total,
    completed: completed.length,
    rework,
    reworkRate: completed.length === 0 ? 0 : Number((rework / completed.length).toFixed(3)),
    averageClarifications: total === 0 ? 0 : Number((clarifications / total).toFixed(2)),
    averageDurationMs: total === 0 ? 0 : Math.round(duration / total),
  }
}
