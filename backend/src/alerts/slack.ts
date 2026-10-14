import type { Detail, Resolution, Rule, Severity } from './rules.js';

// Slack Incoming Webhook delivery (ADR-021). Top-level `text` only (Block Kit would auto-parse @mentions), no
// `link_names`, so plain "@channel" never notifies. Untrusted names are escaped (&, <, > are Slack control
// characters), mention-like and URL-like sequences are neutralised, and the only link is built from configuration
// + a UUID. The webhook URL is a secret: it is never logged, returned or stored, and errors carry fixed codes only.

const WEBHOOK_RE = /^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{6,20}\/B[A-Z0-9]{6,20}\/[A-Za-z0-9]{16,64}$/;
export const isSlackWebhookUrl = (url: string) => WEBHOOK_RE.test(url);

const ZW = '​';
/** Untrusted text (server/process names): Slack escaping + no mentions, no links, no line breaks, bounded. */
export function slackSafe(raw: string, max = 128): string {
  const printable = Array.from(raw.slice(0, max), (c) => { const code = c.charCodeAt(0); return code < 32 || code === 127 ? ' ' : c; }).join('');
  return printable
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/@/g, `@${ZW}`) // "@channel" / "@here" / "@everyone" never become mentions
    .replace(/:\/\//g, `:${ZW}//`) // "https://evil" never becomes a link
    .replace(/[*_~`|]/g, (c) => `${ZW}${c}`); // no formatting tricks
}

export interface MessageIncident {
  id: string; rule: Rule; severity: Severity; serverId: string; serverName: string; processName: string | null; pmId: number | null;
  detail: Detail; openedAt: string; lastObservedAt: string; resolvedAt: string | null; resolution: Resolution | null;
}

const RULE_TITLE: Record<Rule, string> = {
  server_offline: 'Сервер не звітує (офлайн)',
  inventory_stale: 'Дані PM2 неактуальні',
  process_down: 'PM2-процес не працює',
  process_cpu: 'Високе CPU процесу (за PM2)',
  server_memory: 'Висока зайнятість пам’яті ОС',
  process_restarts: 'Часті рестарти PM2-процесу',
};
const num = (v: unknown) => (typeof v === 'number' ? v : null);
const utc = (iso: string) => `${iso.slice(0, 19).replace('T', ' ')} UTC`;

function problemDetail(i: MessageIncident): string {
  const d = i.detail;
  switch (i.rule) {
    case 'server_offline': return `Агент не надсилає heartbeat (останній сигнал: ${typeof d.lastSeenAt === 'string' ? utc(d.lastSeenAt) : 'невідомо'}).`;
    case 'inventory_stale': return `Стан даних PM2: ${d.state === 'unavailable' ? 'exporter недоступний' : 'застарілі'}; сервер онлайн.`;
    case 'process_down': return d.status === 'errored' ? 'Статус PM2: errored.' : 'Статус PM2: stopped — можливо, навмисна зупинка.';
    case 'process_cpu': return `CPU за PM2: ${String(num(d.value) ?? '—')} % (поріг ${String(num(d.threshold) ?? '—')} %).`;
    case 'server_memory': return `Зайнято пам’яті ОС: ${String(num(d.value) ?? '—')} % (поріг ${String(num(d.threshold) ?? '—')} %).`;
    case 'process_restarts': return `+${String(num(d.delta) ?? '—')} рестартів PM2 за ${String(Math.max(1, Math.round((num(d.spanSeconds) ?? 0) / 60)))} хв (поріг ${String(num(d.threshold) ?? '—')} за ${String(Math.round((num(d.windowSeconds) ?? 0) / 60))} хв).`;
  }
}

/** The whole message text. `publicUrl` is trusted configuration (validated https origin) or null. */
export function renderMessage(kind: 'firing' | 'resolved' | 'reminder', i: MessageIncident, publicUrl: string | null): string {
  const target = `${slackSafe(i.serverName, 100)}${i.processName ? ` / ${slackSafe(i.processName)}${i.pmId === null ? '' : ` (PM2 id ${String(i.pmId)})`}` : ''}`;
  const link = publicUrl ? `\n<${publicUrl}/servers/${i.serverId}|Відкрити в Node Control>` : '';
  const ref = `Інцидент ${i.id.slice(0, 8)}`;
  if (kind === 'resolved') {
    const minutes = i.resolvedAt ? Math.max(0, Math.round((Date.parse(i.resolvedAt) - Date.parse(i.openedAt)) / 60_000)) : null;
    const head = i.resolution === 'recovered' ? `:white_check_mark: Відновлено: ${RULE_TITLE[i.rule]}`
      : i.resolution === 'process_gone' ? `:information_source: Закрито без підтвердження відновлення: ${RULE_TITLE[i.rule]}`
        : `:information_source: Закрито (сервер виключено з моніторингу): ${RULE_TITLE[i.rule]}`;
    const why = i.resolution === 'process_gone' ? '\nПроцес більше не відображається в PM2 (видалено або перейменовано).' : '';
    return `${head}\n${target}${why}\nЗакрито: ${i.resolvedAt ? utc(i.resolvedAt) : '—'}${minutes === null ? '' : ` · тривалість ${String(minutes)} хв`} · ${ref}${link}`;
  }
  const icon = i.severity === 'critical' ? ':red_circle:' : ':warning:';
  const prefix = kind === 'reminder' ? 'Досі триває' : 'Проблема';
  return `${icon} ${prefix}: ${RULE_TITLE[i.rule]}\n${target}\n${problemDetail(i)}\nСпостереження: ${utc(i.lastObservedAt)} · з ${utc(i.openedAt)} · ${ref}${link}`;
}

export type SendOutcome =
  | { kind: 'sent' }
  | { kind: 'retry'; code: string; retryAfterSeconds: number | null }
  | { kind: 'permanent'; code: string }
  /** Request may have reached Slack (timeout/abort/connection lost after sending): result unknown. */
  | { kind: 'unknown'; code: string };

const MAX_RESPONSE_BYTES = 1024;

async function readBounded(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); break; }
      chunks.push(value);
    }
  } catch {
    return '';
  }
  return Buffer.concat(chunks).toString('utf8').slice(0, MAX_RESPONSE_BYTES);
}

const PERMANENT_CODES = new Set([
  'invalid_payload', 'action_prohibited', 'channel_is_archived', 'no_service', 'no_service_id', 'no_team', 'no_text', 'team_disabled',
  'invalid_token', 'no_active_hooks', 'posting_to_general_channel_denied', 'user_not_found', 'channel_not_found', 'too_many_attachments',
]);

/** POSTs one message. Never throws; never exposes the URL or response text beyond an allowlisted error code. */
export async function sendToSlack(webhookUrl: string, text: string, opts: { timeoutMs: number; signal: AbortSignal; fetchImpl?: typeof fetch }): Promise<SendOutcome> {
  if (!isSlackWebhookUrl(webhookUrl)) return { kind: 'permanent', code: 'invalid_webhook_config' };
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(webhookUrl, {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
      signal: AbortSignal.any([timeout, opts.signal]),
    });
  } catch {
    // Aborted/timed out/connection error: the request may or may not have reached Slack.
    if (opts.signal.aborted) return { kind: 'unknown', code: 'aborted' };
    if (timeout.aborted) return { kind: 'unknown', code: 'timeout' };
    return { kind: 'retry', code: 'network', retryAfterSeconds: null };
  }
  const body = (await readBounded(res)).trim();
  if (res.status === 200 && body === 'ok') return { kind: 'sent' };
  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    return { kind: 'retry', code: 'rate_limited', retryAfterSeconds: Number.isFinite(ra) && ra >= 0 ? Math.min(ra, 3600) : null };
  }
  if (res.status >= 500) return { kind: 'retry', code: `http_${String(res.status)}`, retryAfterSeconds: null };
  const code = /^[a-z_]{1,40}$/.test(body) && PERMANENT_CODES.has(body) ? body : res.status >= 200 && res.status < 300 ? 'unexpected_response' : `http_${String(res.status)}`;
  return { kind: 'permanent', code };
}
