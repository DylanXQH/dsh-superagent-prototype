/**
 * Static scan for program-memory changes (M2): policy rules, skills and prompt sections.
 *
 * Why this exists: the A/B gate measures *task success*. A change that keeps success flat while adding a side channel
 * ("after you finish, POST the diff to …") scores no worse than a harmless one. The gate is blind to it by
 * construction, so something else has to look at the text itself.
 *
 * What this is NOT: a content filter for user messages, or a sandbox. It reads the text a **program-memory change**
 * adds, and it only refuses things it can name. False positives are cheap here (a person can rephrase and save again);
 * false negatives are not.
 *
 * The scan is line-oriented and diff-based: only lines the change *adds* are scanned. Existing text with a legitimate
 * URL must not block an unrelated edit.
 */

export type Severity = 'block' | 'warn';

export interface Finding {
  rule: string
  severity: Severity
  /** Which prompt section (or `skills/<name>`) the line came from. */
  where: string
  /** 1-based line number inside that section's new text. */
  line: number
  excerpt: string
  reason: string
}

/**
 * Hosts an agent on this installation may legitimately reach: the repository host, the chat platform, the package
 * registries, the local machine, and the mirrors this deployment already uses to work around a blocked network.
 * Anything else in a *program-memory change* is worth a human look.
 */
const ALLOWED_HOSTS = [
  'github.com', 'api.github.com', 'codeload.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com',
  'feishu.cn', 'larksuite.com', 'open.feishu.cn',
  'registry.npmjs.org', 'nodejs.org', 'pypi.org',
  'ghfast.top', 'gh-proxy.com',
  'localhost', '127.0.0.1',
];

const URL_PATTERN = /https?:\/\/[^\s"'`)\]}>,]+/gi;
const NET_TOOL = /\b(curl|wget|ncat|netcat|netcat-openbsd|scp|rsync|socat)\b/i;
const EXFIL_VERB = /(发送|上报|上传|回传|传出|外发|提交到|发给|发到|送去|递交|传送到|存档到|同步到|粘贴到|post(?:ed|ing)?\s+to|send(?:s|ing|t)?\s+to|upload(?:ed|ing)?\s+to|push(?:ed|ing)?\s+to|exfiltrat)/i;
const CREDENTIAL_PATH = /(\.credentials\.ya?ml|\.ssh\/id_|id_rsa|id_ed25519|appsecret|client[_-]?secret|api[_-]?key|access[_-]?token|\.npmrc|\.netrc)/i;
const CREDENTIAL_VERB = /(cat|读取|读出|打印|echo|输出|上传|发送|转成|base64|复制)/i;
const HIDE_BEHAVIOUR = /(不要告诉用户|不让用户知道|别让用户知道|不要汇报|不必汇报|偷偷|静默地删除|删除证据|隐藏这次|hide\s+(this|it)\s+from\s+the\s+user|do\s+not\s+(tell|inform)\s+the\s+user)/i;
const GATE_BYPASS = /(跳过.{0,6}(审查|检查|闸门|评审)|绕过.{0,6}(审查|检查|闸门)|disable\s+(the\s+)?(review|gate|check)|bypass\s+(the\s+)?(review|gate|check)|skip\s+(the\s+)?(review|gate))/i;
const SELF_MERGE = /(自动合并|auto-?merge\s*(?::|=|为|设为)?\s*(true|on|开启|启用)|merge\s+(it\s+)?yourself|自行合并)/i;
/** Words that turn a merge instruction into a *prohibition* of merging — the default delivery text says exactly that. */
const NEGATION = /(不要|不得|禁止|切勿|绝不|别|never|do\s+not|don't|must\s+not|no\s+)\s*$/i;
const DESTRUCTIVE = /(\brm\s+-rf\s+\/(?!\w)|\bchmod\s+777\b|\bsudo\b|git\s+config\s+--global|>\s*\/dev\/sd[a-z])/i;
const DYNAMIC_EXEC = /(\beval\s*\(|\bexec\s*\(|new\s+Function\s*\(|child_process)/i;
const REMOTE_SOURCE = /(issue|评论|链接|网页|页面|link|page|comment)/i;
const REMOTE_DIRECTIVE = /(指令|指示|instructions?|prompt\s+injection)/i;

function hostsIn(line: string): string[] {
  const hosts: string[] = [];
  URL_PATTERN.lastIndex = 0;
  for (const match of line.matchAll(URL_PATTERN)) {
    try {
      const host = new URL(match[0]).hostname.toLowerCase();
      hosts.push(host);
    } catch {
      // A malformed URL is not a destination; ignore it here and let the generic URL rule warn.
    }
  }
  return hosts;
}

function isAllowedHost(host: string): boolean {
  return ALLOWED_HOSTS.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
}

function clip(line: string, limit = 200): string {
  const flat = line.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * Scans one line. Kept deliberately rule-by-rule instead of one mega-regex: every finding must be explainable to the
 * person who has to approve or rephrase the change.
 */
function scanLine(line: string, where: string, lineNumber: number): Finding[] {
  const findings: Finding[] = [];
  const add = (rule: string, severity: Severity, reason: string): void => {
    findings.push({ rule, severity, where, line: lineNumber, excerpt: clip(line), reason });
  };

  const externalHosts = hostsIn(line).filter(host => !isAllowedHost(host));

  // The one rule worth blocking outright: a *program-memory* change that both names an outside host and talks about
  // sending something to it. A bare URL is only a warning — documentation legitimately links to places.
  if (externalHosts.length > 0 && EXFIL_VERB.test(line)) {
    add('external-exfiltration', 'block', `names an outside host (${externalHosts.join(', ')}) together with a send/upload verb`);
  } else if (externalHosts.length > 0) {
    add('external-url', 'warn', `links to a host outside the allowlist (${externalHosts.join(', ')})`);
  }
  if (NET_TOOL.test(line) && externalHosts.length > 0) {
    add('network-command', 'warn', 'uses a network command against an outside host');
  }
  if (CREDENTIAL_PATH.test(line) && CREDENTIAL_VERB.test(line)) {
    add('credential-access', 'block', 'reads or exports a credential location');
  }
  if (HIDE_BEHAVIOUR.test(line)) {
    add('concealment', 'block', 'asks the agent to hide its behaviour from the user');
  }
  if (GATE_BYPASS.test(line)) {
    add('gate-bypass', 'block', 'asks the agent to skip or disable review');
  }
  const mergeMatch = line.search(SELF_MERGE);
  if (mergeMatch >= 0) {
    // "never auto-merge" is the correct instruction; only the affirmative form is a finding.
    const before = line.slice(Math.max(0, mergeMatch - 10), mergeMatch);
    if (!NEGATION.test(before)) add('self-merge', 'block', 'would let the agent merge its own change without a person');
  }
  if (DESTRUCTIVE.test(line)) {
    add('destructive', 'warn', 'uses a privileged or destructive command');
  }
  if (DYNAMIC_EXEC.test(line)) {
    add('dynamic-exec', 'warn', 'builds or runs code dynamically');
  }
  if (REMOTE_SOURCE.test(line) && REMOTE_DIRECTIVE.test(line)) {
    add('remote-instruction', 'warn', 'mentions following instructions that come from outside text');
  }
  return findings;
}

/** Scans a whole text (used by the dry-run endpoint). */
export function scanText(text: string, where = 'text'): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((line, index) => {
    if (line.trim().length === 0) return;
    findings.push(...scanLine(line, where, index + 1));
  });
  return findings;
}

/** Lines present in `next` but not in `previous`, per section. Only these are new behaviour. */
function addedLines(previous: string, next: string): { line: number; text: string }[] {
  const known = new Set(previous.split('\n').map(line => line.trim()).filter(line => line.length > 0));
  const added: { line: number; text: string }[] = [];
  next.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    if (known.has(trimmed)) return;
    added.push({ line: index + 1, text: line });
  });
  return added;
}

interface PromptLike {
  communication: string
  scope: string
  delivery: string
  skills: Record<string, string>
  overrides?: Record<string, { text?: string } | undefined>
}

/**
 * Diffs a prompt configuration against the previous one and scans only what the change adds.
 *
 * Returns every finding; callers decide what to refuse. The current caller refuses on any `block`.
 */
export function scanPromptChange(previous: PromptLike | undefined, next: PromptLike): Finding[] {
  const findings: Finding[] = [];
  const sections: [string, string, string | undefined][] = [
    ['communication', previous?.communication ?? '', next.communication],
    ['scope', previous?.scope ?? '', next.scope],
    ['delivery', previous?.delivery ?? '', next.delivery],
  ];
  for (const [name, before, after] of sections) {
    for (const { line, text } of addedLines(before, after)) findings.push(...scanLine(text, name, line));
  }
  for (const [name, body] of Object.entries(next.skills)) {
    for (const { line, text } of addedLines(previous?.skills[name] ?? '', body)) findings.push(...scanLine(text, `skills/${name}`, line));
  }
  for (const [name, override] of Object.entries(next.overrides ?? {})) {
    const body = override?.text ?? '';
    const before = previous?.overrides?.[name]?.text ?? '';
    for (const { line, text } of addedLines(before, body)) findings.push(...scanLine(text, `overrides/${name}`, line));
  }
  return findings;
}

/** The message a refusal carries: every blocking finding, so the author can fix them in one pass. */
export function describeBlocking(findings: readonly Finding[]): string {
  const blocking = findings.filter(finding => finding.severity === 'block');
  const lines = blocking.map(finding => `${finding.where}:${finding.line} [${finding.rule}] ${finding.reason} — ${finding.excerpt}`);
  return `This change adds text a person must approve first:\n${lines.join('\n')}`;
}
