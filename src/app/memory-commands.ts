/**
 * Memory commands a person can say in chat: 你记得什么 / 忘掉 X / 记住 X.
 *
 * Why this exists rather than "ask the model to handle it": if a model decides whether a message is a memory command,
 * then a model also decides what gets written into the store — and a chat message is untrusted input. Here the *shape*
 * decides: a message is a command only when it matches a fixed form, and the only text that enters memory is the part
 * the person explicitly marked with 记住. Everything else stays a normal conversation.
 *
 * The commands are intercepted before the Engine sees them: asking what the agent remembers must not open a ticket,
 * spend a worker, or produce a PR.
 */
import { createHash } from 'node:crypto';
import type { MemoryRecord } from '../core/model.ts';
import { recall, remember, retract } from './memory-store.ts';
import type { Store } from './store.ts';

export type MemoryCommand =
  | { kind: 'recall'; query?: string }
  | { kind: 'forget'; query: string }
  | { kind: 'remember'; text: string };

/** `你记得什么` / `你还记得我什么？` / `记忆` — a question with no object. */
const RECALL = /^(?:你)?(?:还)?(?:记得|记住)(?:了)?(?:我)?(?:什么|哪些|啥|什么东西)?[？?。!！]*$|^(?:记忆|memories)[？?]*$/i;
/** `记得关于 X 的？` — a recall scoped to a topic. Placed before the bare `记得什么` form so the object is captured. */
const RECALL_ABOUT = /^(?:你)?(?:还)?记得\s*(?:关于)?\s*([^\s？?。,，！!;；]{2,40})\s*[？?。]*$/i;
/** Objects that are questions, not topics: `你记得什么` must list everything rather than search for the word 什么. */
const EMPTY_OBJECT = /^(?:什么|哪些|啥|我什么|什么东西|什么的)$/;
/** `忘掉 X` / `忘记 X` / `删除记忆 X` */
const FORGET = /^(?:你)?(?:忘掉|忘记|删掉记忆|删除记忆|清掉记忆)\s*[:：]?\s*(.+)$/i;
/** `记住 X` / `记一下：X` / `记下 X` */
const REMEMBER = /^(?:你)?(?:记住|记一下|记下|记一笔)\s*[:：]?\s*(.+)$/i;

/** Strips what a chat platform adds around a command (`@bot 你记得什么`, trailing whitespace). */
function normalize(text: string): string {
  return text
    .replace(/<at[^>]*>.*?<\/at>/gi, ' ')
    .replace(/@\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseMemoryCommand(text: string): MemoryCommand | undefined {
  const flat = normalize(text);
  if (flat.length === 0 || flat.length > 2000) return undefined;
  const about = RECALL_ABOUT.exec(flat);
  const topic = about?.[1]?.trim();
  if (topic && !EMPTY_OBJECT.test(topic)) return { kind: 'recall', query: topic };
  if (RECALL.test(flat)) return { kind: 'recall' };
  const forget = FORGET.exec(flat);
  if (forget?.[1]) return { kind: 'forget', query: forget[1].trim() };
  const rememberMatch = REMEMBER.exec(flat);
  const payload = rememberMatch?.[1]?.trim();
  // `你记住了吗` / `记住我` are questions or fragments, not instructions: the object of 记住 must look like content.
  if (payload && payload.length >= 3 && !/^(?:吗|么|嘛|没|了|呀|呢|我|你)/.test(payload)) return { kind: 'remember', text: payload };
  return undefined;
}

const SCOPE_LABEL: Record<MemoryRecord['scope'], string> = { user: '关于你', project: '关于项目', env: '关于机器' };
const LIST_LIMIT = 10;
const VALUE_CHARS = 70;

function clip(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > VALUE_CHARS ? `${flat.slice(0, VALUE_CHARS - 1)}…` : flat;
}

function stableKey(prefix: string, value: string): string {
  const digest = createHash('sha1').update(value.replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex').slice(0, 8);
  return `${prefix}-${digest}`;
}

/**
 * Runs one command and returns the reply text.
 *
 * The reply is plain text on purpose: it goes through the same IM length check as every other message, and a person
 * asking "what do you remember" should get a list they can argue with, not a formatted card they cannot quote.
 */
export function runMemoryCommand(store: Store, command: MemoryCommand): string {
  if (command.kind === 'remember') {
    const text = command.text.trim();
    if (text.length < 3) return '这条太短了，我没记 —— 能说完整一点吗？';
    const existing = store.memories.list({ scope: 'user', limit: 500 }).find(entry => entry.value === text);
    if (existing) return `这条已经记着了：${clip(text)}`;
    remember(store, {
      scope: 'user', kind: 'preference', key: stableKey('stated', text), value: text,
      source: 'user-said', confidence: 0.9, evidence: ['chat:remember-command'],
    });
    return `记下了：${clip(text)}\n（来源标为「你确认过」，以后派单会带上它。）`;
  }

  if (command.kind === 'forget') {
    const query = command.query.trim();
    const matches = store.memories
      .search(query, { limit: 50 })
      .filter(entry => !entry.supersededBy && !entry.retractedAt);
    if (matches.length === 0) return `没找到和「${query}」有关的记忆。`;
    for (const entry of matches) retract(store, entry.id);
    const listed = matches.slice(0, 3).map(entry => `· ${clip(entry.value)}`).join('\n');
    const more = matches.length > 3 ? `\n…共 ${matches.length} 条` : '';
    return `已忘掉 ${matches.length} 条：\n${listed}${more}`;
  }

  // recall
  const entries = command.query
    ? recall(store, command.query, { limit: LIST_LIMIT })
    : store.memories.list({ limit: 200 }).filter(entry => !entry.supersededBy && !entry.retractedAt && entry.scope !== 'env');
  if (entries.length === 0) {
    return command.query ? `关于「${command.query}」，我这边没有记着的。` : '我现在还没记住什么。你可以说「记住 …」直接教我。';
  }
  const groups = new Map<MemoryRecord['scope'], MemoryRecord[]>();
  for (const entry of entries.slice(0, LIST_LIMIT)) {
    const list = groups.get(entry.scope) ?? [];
    list.push(entry);
    groups.set(entry.scope, list);
  }
  const sections = [...groups.entries()].map(([scope, list]) => {
    const lines = list.map(entry => `· ${clip(entry.value)}`).join('\n');
    return `【${SCOPE_LABEL[scope]}】\n${lines}`;
  });
  const total = entries.length;
  const shown = Math.min(total, LIST_LIMIT);
  const tail = total > shown ? `\n（共 ${total} 条，只列了前 ${shown} 条；问具体话题可以缩小范围）` : '';
  return `${sections.join('\n\n')}${tail}`;
}
