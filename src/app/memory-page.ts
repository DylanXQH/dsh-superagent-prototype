/**
 * The memory page: what the agent currently believes about you, the project, and the machines it runs on.
 *
 * A person needs to be able to audit this without reading a database, because every recalled entry can change behaviour
 * (see `recallCard`). The page is server-rendered plain HTML on purpose: no bundle, no client framework, and the same
 * source of truth the agent uses. Retracting is a POST to the existing API, which re-checks the request is same-origin.
 */
import type { MemoryRecord } from '../core/model.ts'
import type { Store } from './store.ts'

const SCOPE_LABEL: Record<MemoryRecord['scope'], string> = { user: '关于你', project: '关于项目', env: '关于机器' }
const SCOPE_HINT: Record<MemoryRecord['scope'], string> = {
  user: '你的偏好与习惯：派单、回复、交付时都会参考。',
  project: '这个仓库的做法与教训：和具体任务有关，换项目就不适用。',
  env: '某台 worker 的机器事实：只在派给那台机器的任务里出现。',
}
const SOURCE_LABEL: Record<MemoryRecord['source'], string> = {
  'user-said': '你确认过',
  'observed-trusted': '我观察到',
  'observed-untrusted': '外部观察（不入库）',
  inferred: '我推测',
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)

const day = (iso: string): string => (iso.length >= 10 ? iso.slice(0, 10) : iso)

function card(entry: MemoryRecord): string {
  const confidence = Math.round(entry.confidence * 100)
  const owner = entry.owner ? `<span class="tag owner">仅 ${escapeHtml(entry.owner)}</span>` : ''
  const evidence = entry.evidence.length > 0
    ? `<div class="evidence">依据：${entry.evidence.slice(0, 3).map(item => `<code>${escapeHtml(item)}</code>`).join(' ')}</div>`
    : ''
  const ttl = entry.ttlDays ? ` · ${entry.ttlDays} 天后待复核` : ''
  return `<li class="entry" data-id="${escapeHtml(entry.id)}">
  <div class="value">${escapeHtml(entry.value)}</div>
  <div class="meta">
    <span class="tag kind">${escapeHtml(entry.key)}</span>
    ${owner}
    <span class="tag source s-${escapeHtml(entry.source)}">${escapeHtml(SOURCE_LABEL[entry.source])}</span>
    <span class="tag conf">置信度 ${confidence}%</span>
    <span class="when">${escapeHtml(day(entry.createdAt))}${escapeHtml(ttl)}</span>
  </div>
  ${evidence}
  <button class="forget" data-id="${escapeHtml(entry.id)}">忘掉这条</button>
</li>`
}

/** Renders the whole page from the current store; every request renders fresh, so the page is never stale. */
export function renderMemoryPage(store: Store): string {
  const all = store.memories.list({ limit: 1000 }).filter(entry => !entry.supersededBy && !entry.retractedAt)
  const scopes: MemoryRecord['scope'][] = ['user', 'project', 'env']
  const groups = scopes
    .map(scope => ({ scope, entries: all.filter(entry => entry.scope === scope) }))
    .filter(group => group.entries.length > 0)
  const body = groups.length === 0
    ? `<p class="empty">还没有记忆。可以在飞书里说「记住 …」直接教我一条。</p>`
    : groups.map(group => `<section>
  <h2>${SCOPE_LABEL[group.scope]} <span class="count">${group.entries.length}</span></h2>
  <p class="hint">${SCOPE_HINT[group.scope]}</p>
  <ul class="list">${group.entries.map(card).join('\n')}</ul>
</section>`).join('\n')
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>记忆 · dsh-superagent</title>
<style>
:root { color-scheme: light dark; --fg:#1b1d21; --dim:#6b7280; --line:#e5e7eb; --bg:#fff; --card:#fafafa; --accent:#2563eb; }
@media (prefers-color-scheme: dark) { :root { --fg:#e5e7eb; --dim:#9ca3af; --line:#2b2f36; --bg:#14161a; --card:#1b1f25; --accent:#60a5fa; } }
* { box-sizing: border-box; }
body { margin:0; padding:24px 16px 64px; font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; color:var(--fg); background:var(--bg); }
main { max-width: 780px; margin: 0 auto; }
h1 { font-size:20px; margin:0 0 4px; }
.sub { color:var(--dim); font-size:13px; margin:0 0 20px; }
h2 { font-size:15px; margin:28px 0 4px; }
.count { color:var(--dim); font-weight:400; font-size:13px; }
.hint { color:var(--dim); font-size:13px; margin:0 0 10px; }
.list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:10px; }
.entry { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
.value { font-size:15px; margin-bottom:8px; word-break:break-word; }
.meta { display:flex; flex-wrap:wrap; gap:6px; align-items:center; font-size:12px; color:var(--dim); }
.tag { border:1px solid var(--line); border-radius:999px; padding:1px 8px; }
.tag.s-user-said { border-color:var(--accent); color:var(--accent); }
.tag.s-inferred { border-style:dashed; }
.evidence { margin-top:8px; font-size:12px; color:var(--dim); }
.evidence code { background:transparent; border:1px solid var(--line); border-radius:4px; padding:0 4px; margin-right:4px; }
.when { margin-left:auto; }
.forget { margin-top:10px; font:inherit; font-size:12px; color:var(--dim); background:none; border:1px solid var(--line); border-radius:6px; padding:3px 10px; cursor:pointer; }
.forget:hover { color:#dc2626; border-color:#dc2626; }
.empty { color:var(--dim); }
footer { margin-top:36px; padding-top:16px; border-top:1px solid var(--line); color:var(--dim); font-size:13px; }
</style></head>
<body><main>
<h1>记忆</h1>
<p class="sub">这里是我现在记住的全部内容；每一条都可能影响我派单和回复的方式。共 ${all.length} 条。</p>
${body}
<footer>在飞书里可以直接说「你记得什么」「记住 …」「忘掉 …」。这里删掉一条，等同于在那里说「忘掉」。</footer>
</main>
<script>
for (const button of document.querySelectorAll('.forget')) {
  button.addEventListener('click', async () => {
    const id = button.dataset.id
    if (!id || !confirm('确定忘掉这条？')) return
    button.disabled = true
    const response = await fetch('/orchestrator/api/memory/' + encodeURIComponent(id) + '/retract', {
      method: 'POST', headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' }, body: '{}',
    })
    if (response.ok) location.reload()
    else { button.disabled = false; alert('删除失败：' + (await response.text()).slice(0, 200)) }
  })
}
</script>
</body></html>`
}
