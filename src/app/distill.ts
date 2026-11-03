/**
 * Deterministic distillation: turns a finished Episode into candidate memories.
 *
 * Why deterministic instead of "ask the model to write a lesson": the model that just ran the task is the least
 * trustworthy judge of whether it learned something worth keeping. A rule-based pass can be read, tested and argued
 * with; a model-written summary cannot. Anything this pass cannot express stays in the Episode until a person (or a
 * later, better rule) promotes it.
 *
 * The rules are deliberately narrow. They only look at what the **user** said after the first message — the part of
 * the conversation where a human corrects course — plus the terminal outcome. Nothing here can turn untrusted text
 * into a fact: every candidate is attributed to `user-said` or `inferred`, never to an observation.
 */
import { createHash } from 'node:crypto';
import type { Episode } from '../core/model.ts';
import { remember } from './memory-store.ts';
import type { MemoryRecord } from '../core/model.ts';
import type { Store } from './store.ts';

/** Hard ceiling per ticket: a bad rule must not flood the memory store in one run. */
export const MAX_CANDIDATES = 5;
/** A candidate longer than this is a spec, not a preference; keep the sentence but bound it. */
const MAX_VALUE_CHARS = 220;
/** Below this length a follow-up is "ok"/"继续"/"嗯" — noise for a preference rule. */
const MIN_FOLLOWUP_CHARS = 6;
/** Preferences decay: six months is long enough to matter, short enough to get re-confirmed. */
const PREFERENCE_TTL_DAYS = 180;
/** A lesson about one failed run is only useful while the codebase stands; 30 days keeps it from becoming folklore. */
const LESSON_TTL_DAYS = 30;

/**
 * Words that mark a sentence as an instruction about *how* to work rather than a one-off request.
 * Kept as data so the rule can be reviewed and extended without reading code.
 */
const PREFERENCE_HINTS = [
  '用中文', '用英文', '不要', '别在', '别再', '以后', '每次', '总是', '必须', '记得', '一律', '统一用', '尽量',
  'prefer', 'always', 'never', "don't", 'must',
];

/** Words that scope an instruction to one repository rather than to the person. */
const PROJECT_HINTS = ['这个仓库', '本项目', '这个项目', '在本项目', '这个repo', '本仓库'];

export interface Candidate {
  key: string
  scope: MemoryRecord['scope']
  kind: MemoryRecord['kind']
  value: string
  source: MemoryRecord['source']
  confidence: number
  ttlDays: number
  /** Human-readable reason, stored as evidence so a later reader can see *why* this was written. */
  rule: string
}

/** `distilled-<rule>-<hash8>`: stable across runs, so repeating the same correction supersedes instead of piling up. */
function candidateKey(rule: string, value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
  const digest = createHash('sha1').update(normalized).digest('hex').slice(0, 8);
  return `distilled-${rule}-${digest}`;
}

function clip(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_VALUE_CHARS ? `${flat.slice(0, MAX_VALUE_CHARS - 1)}…` : flat;
}

/**
 * The rules, in priority order. Each returns at most one candidate per follow-up.
 *
 * Note what is *absent*: nothing inspects the assistant's own messages. Self-reported success is not evidence.
 */
export function distillEpisode(episode: Episode): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  const push = (candidate: Candidate): void => {
    if (candidates.length >= MAX_CANDIDATES) return;
    if (seen.has(candidate.key)) return;
    seen.add(candidate.key);
    candidates.push(candidate);
  };

  for (const followUp of episode.followUps) {
    if (followUp.length < MIN_FOLLOWUP_CHARS) continue;
    const value = clip(followUp);
    const isProjectScoped = PROJECT_HINTS.some(hint => followUp.includes(hint));
    const isPreference = isProjectScoped || PREFERENCE_HINTS.some(hint => followUp.toLowerCase().includes(hint));
    if (!isPreference) continue;
    push({
      key: candidateKey(isProjectScoped ? 'convention' : 'preference', value),
      scope: isProjectScoped ? 'project' : 'user',
      kind: isProjectScoped ? 'convention' : 'preference',
      value,
      // The user typed it: that is the strongest provenance available, and the only one that may exceed the
      // observed-trusted ceiling without a person confirming it again.
      source: 'user-said',
      confidence: isProjectScoped ? 0.8 : 0.85,
      ttlDays: PREFERENCE_TTL_DAYS,
      rule: isProjectScoped ? 'followup-project-convention' : 'followup-preference',
    });
  }

  // A run that ended badly is worth remembering even when nobody said a corrective word: the next attempt should
  // not rediscover the same wall. Marked `inferred` and capped at 0.6 so it never outranks something a person said.
  if (episode.outcome !== 'completed' && episode.outcome !== 'cancelled' && episode.reason) {
    const value = clip(`${episode.title ?? episode.intent} — ${episode.outcome}: ${episode.reason}`);
    if (value.length >= MIN_FOLLOWUP_CHARS) {
      push({
        key: candidateKey('lesson', value),
        scope: 'project',
        kind: 'convention',
        value,
        source: 'inferred',
        confidence: 0.5,
        ttlDays: LESSON_TTL_DAYS,
        rule: 'failed-run-lesson',
      });
    }
  }

  return candidates;
}

/**
 * Distils and writes. Idempotent by (key, value): replaying the same Episode — the runtime can emit `ticket.ended`
 * more than once across restarts — must not add a row or bump a supersede chain.
 */
export function distillAndRemember(store: Store, episode: Episode): MemoryRecord[] {
  const written: MemoryRecord[] = [];
  for (const candidate of distillEpisode(episode)) {
    const current = store.memories
      .list({ scope: candidate.scope, limit: 500 })
      .find(entry => entry.key === candidate.key);
    if (current?.value === candidate.value) continue;
    const { memory } = remember(store, {
      scope: candidate.scope,
      kind: candidate.kind,
      key: candidate.key,
      value: candidate.value,
      source: candidate.source,
      confidence: candidate.confidence,
      ttlDays: candidate.ttlDays,
      evidence: [`episode:${episode.id}`, `rule:${candidate.rule}`],
    });
    written.push(memory);
  }
  return written;
}
