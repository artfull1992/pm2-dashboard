import { type ReactNode, type SyntheticEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { type BlockerFunction, Link, NavLink, useBlocker, useParams } from 'react-router';
import { ApiError, settingsApi } from '../api/client';
import { ADVANCED_FIELDS, type AdvancedField, RULE_FIELDS, type RuleField, type SettingsView, type SlackTestResult, TIMING_FIELDS, type TimingField } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Forbidden } from '../auth/guards';
import { Dialog } from '../components/Dialog';
import { ErrorState, formatRetry, LoadingState } from '../components/StatusMessage';
import { PageHeader, StatusIndicator } from '../components/ui';
import { formatDate } from './ServersPage';

// Admin settings (ADR-022): Slack integration and alert rules. alerts:manage only (the API enforces it too).
// Not polled (a form must not be overwritten while edited); every mutation is sent once, bound to the session and the
// revision/generation it was based on — a 409 means someone else changed it: reload, never silently overwrite.
// The webhook is write-only: typed into a password field, sent once, cleared; it is never received back.
// Unsaved rules, a typed webhook or a request in flight are guarded by one data-router blocker (tabs, links,
// Back/Forward) plus beforeunload; re-reading the state asks first when it would drop them. A reload unmounts the
// panel, so a GET answer never lands on a draft edited meanwhile.

type Field = RuleField | TimingField | AdvancedField;
// `label` is the full accessible name of the input; `short` is the visible label next to it (the row title gives context).
const LABELS: Record<Field, { label: string; short: string; unit: string }> = {
  cpuOpenPercent: { label: 'CPU процесу — поріг проблеми', short: 'Проблема', unit: '%' },
  cpuClosePercent: { label: 'CPU процесу — поріг відновлення', short: 'Відновлення', unit: '%' },
  confirmSamples: { label: 'Підтверджень проблеми (CPU процесу)', short: 'Проблема', unit: 'поспіль' },
  recoverSamples: { label: 'Підтверджень відновлення (CPU процесу)', short: 'Відновлення', unit: 'поспіль' },
  statusConfirmSamples: { label: 'Підтверджень статусу процесу й даних PM2', short: 'Підтверджень', unit: 'поспіль' },
  restartsThreshold: { label: 'Рестартів для сповіщення', short: 'Кількість', unit: 'рестартів' },
  restartsWindowMinutes: { label: 'Вікно для рестартів', short: 'За період', unit: 'хв' },
  intervalSeconds: { label: 'Інтервал перевірки', short: 'Інтервал', unit: 'с' },
  cooldownMinutes: { label: 'Пауза (cooldown) після відновлення', short: 'Пауза', unit: 'хв' },
  reminderMinutes: { label: 'Інтервал нагадувань', short: 'Інтервал', unit: 'хв' },
  httpTimeoutMs: { label: 'Тайм-аут запиту до Slack', short: 'Тайм-аут', unit: 'мс' },
  maxAttempts: { label: 'Максимум спроб доставки', short: 'Спроб', unit: 'разів' },
  queueMax: { label: 'Ліміт черги', short: 'Ліміт', unit: 'повідомл.' },
};
// One row = a title with a short explanation on the left and one control or a pair of equal controls on the right.
type Row = { title: string; text: string; fields: readonly [Field] | readonly [Field, Field] };
const LOAD_ROWS: Row[] = [
  { title: 'CPU процесу', text: 'CPU за PM2; на кількох ядрах може перевищувати 100 %. Відновлення — нижче проблеми.', fields: ['cpuOpenPercent', 'cpuClosePercent'] },
  { title: 'Підтвердження', text: 'Скільки зборів PM2 поспіль із високим CPU відкривають проблему і скільки з нормальним — закривають.', fields: ['confirmSamples', 'recoverSamples'] },
];
const PROCESS_ROWS: Row[] = [
  { title: 'Статус процесу', text: 'Скільки вибірок поспіль підтверджують зміну статусу або відсутність даних PM2.', fields: ['statusConfirmSamples'] },
  { title: 'Рестарти', text: 'Нові рестарти між вибірками за період, не накопичений лічильник PM2.', fields: ['restartsThreshold', 'restartsWindowMinutes'] },
];
const ADVANCED_ROWS: Row[] = [
  { title: 'Тайм-аут запиту', text: 'Скільки чекати відповіді Slack на одну спробу.', fields: ['httpTimeoutMs'] },
  { title: 'Спроби доставки', text: 'Максимум спроб для одного повідомлення.', fields: ['maxAttempts'] },
  { title: 'Ліміт черги', text: 'Зменшення нічого не видаляє: нові понад ліміт відкидаються.', fields: ['queueMax'] },
];
const KEY_ERRORS = { key_missing: 'на сервері не задано ключ шифрування', key_version_mismatch: 'ключ шифрування має іншу версію', decrypt_failed: 'збережений секрет не вдалося розшифрувати' } as const;
const QUEUE_LABELS = [
  ['queued', 'У черзі'], ['sending', 'Надсилається'], ['sent', 'Надіслано'], ['failed', 'Не доставлено'],
  ['unknown', 'Невідомо'], ['cancelled', 'Скасовано'], ['dropped', 'Відкинуто'],
] as const satisfies readonly (readonly [keyof SettingsView['queue'], string])[];

function errorText(error: unknown, what: 'save' | 'webhook' | 'test' | 'load'): string {
  if (!(error instanceof ApiError)) return 'Неочікувана помилка. Перечитайте стан.';
  switch (error.kind) {
    case 'conflict': return 'Налаштування вже змінились (інший адміністратор, інша вкладка, тест у процесі або інтеграція не налаштована). Перечитайте стан і повторіть.';
    case 'invalid_request': return what === 'webhook' ? 'Це не Slack Incoming Webhook URL (https://hooks.slack.com/services/…).' : 'Перевірте значення: деякі поза допустимими межами.';
    case 'forbidden': return 'Недостатньо прав.';
    case 'rate_limited': return `Забагато запитів.${formatRetry(error.retryAfterSeconds) || ' Спробуйте пізніше.'}`;
    case 'unavailable': return `Сервіс тимчасово недоступний.${formatRetry(error.retryAfterSeconds) || ' Спробуйте пізніше.'}`;
    case 'network': case 'timeout':
      return what === 'load' ? 'Не вдалося отримати відповідь.'
        : what === 'test' ? 'Відповідь не отримано — тест міг виконатися. Перевірте канал і перечитайте стан перед повтором.'
          : 'Відповідь не отримано — зміна могла застосуватись. Перечитайте стан перед повтором.';
    default: return 'Неочікувана помилка. Перечитайте стан.';
  }
}

type Tone = 'ok' | 'warning' | 'error';
type Message = { tone: Tone; text: string };

/**
 * The answer of an explicit Slack test, as reported — never more. `success` means Slack accepted the request (not that
 * someone saw it); a result recorded for another generation (the webhook changed meanwhile) says nothing about the
 * current one.
 */
export function testMessage(r: SlackTestResult): Message {
  const code = r.code ?? '—';
  if (!r.stored) return { tone: 'warning', text: 'Інтеграцію змінили під час тесту: результат стосується попереднього webhook, а не поточного. Перечитайте стан.' };
  if (r.outcome === 'success') return { tone: 'ok', text: 'Slack прийняв тестове повідомлення. Перевірте, що воно з’явилося в каналі.' };
  if (r.outcome === 'failed') return { tone: 'error', text: `Тестове повідомлення не доставлено (${code}). Перевірте webhook або замініть його.` };
  return { tone: 'warning', text: `Результат тесту невідомий (${code}): повідомлення могло надійти. Перевірте канал; повторюйте лише свідомо.` };
}

function MessageBox({ message, children }: { message: Message; children?: ReactNode }) {
  const cls = message.tone === 'ok' ? 'notice' : message.tone === 'warning' ? 'notice notice--warning' : 'form-error';
  return (
    <div className={`${cls} settings-message`} role={message.tone === 'ok' ? 'status' : 'alert'}>
      <p>{message.text}</p>
      {children}
    </div>
  );
}

/** What leaving or re-reading would lose: an unsaved rules draft or a typed webhook, or a request still in flight. */
type Guard = { unsaved: 'rules' | 'webhook' | null; pending: boolean };
const NO_GUARD: Guard = { unsaved: null, pending: false };
const UNSAVED_TEXT = {
  rules: 'Незбережені зміни правил буде втрачено. Збережені налаштування не зміняться.',
  webhook: 'Введений webhook не збережено, його буде очищено. Поточна інтеграція не зміниться.',
} as const;

/** "Keep editing / discard" — the one confirmation used for leaving and for a reload that would drop unsaved input. */
function DiscardDialog({ title, text, keep, discard, onKeep, onDiscard }: { title: string; text: string; keep: string; discard: string; onKeep: () => void; onDiscard: () => void }) {
  return (
    <Dialog title={title} onClose={onKeep} actions={(
      <>
        <button type="button" className="button" onClick={onKeep}>{keep}</button>
        <button type="button" className="button button--danger" onClick={onDiscard}>{discard}</button>
      </>
    )}>
      <p>{text}</p>
    </Dialog>
  );
}

/** Runs one mutation bound to the session and an AbortController; stale answers (logout, unmount) are ignored. */
function useMutation() {
  const { state, bindSession, sessionExpired } = useAuth();
  const inflight = useRef<AbortController | null>(null);
  useEffect(() => () => { inflight.current?.abort(); }, []);
  const csrf = state.status === 'authenticated' ? state.session.csrfToken : '';
  return useCallback(async <T,>(run: (csrf: string, signal: AbortSignal) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown } | null> => {
    const controller = new AbortController();
    inflight.current = controller;
    const binding = bindSession();
    try {
      const value = await run(csrf, controller.signal);
      if (controller.signal.aborted || !binding.current()) return null;
      return { ok: true, value };
    } catch (error) {
      if (controller.signal.aborted || !binding.current()) return null;
      if (error instanceof ApiError && error.kind === 'unauthorized') { sessionExpired(); return null; }
      return { ok: false, error };
    } finally {
      if (inflight.current === controller) inflight.current = null;
    }
  }, [csrf, bindSession, sessionExpired]);
}

/** A settings section: title and a short explanation on the left, its controls and messages on the right. */
function Section({ title, text, children, danger = false }: { title: string; text: ReactNode; children: ReactNode; danger?: boolean }) {
  return (
    <div className={`settings-section${danger ? ' settings-section--danger' : ''}`}>
      <div className="settings-section__text">
        <h3 className="settings-section__title">{title}</h3>
        <p className="hint">{text}</p>
      </div>
      <div className="settings-section__body">{children}</div>
    </div>
  );
}

type SlackAction = 'webhook' | 'delivery' | 'test' | 'remove';

function SlackPanel({ data, onData, onReload, onGuard }: { data: SettingsView; onData: (d: SettingsView) => void; onReload: () => void; onGuard: (g: Guard) => void }) {
  const mutate = useMutation();
  const [webhook, setWebhook] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [pending, setPending] = useState<SlackAction | null>(null);
  const busy = useRef(false); // the handlers' own check: a second click before the re-render sends nothing
  const [message, setMessage] = useState<{ at: 'webhook' | 'delivery' | 'test' | 'remove'; message: Message } | null>(null);
  const [confirm, setConfirm] = useState<'remove' | 'reload' | null>(null);
  const [test, setTest] = useState<SlackTestResult | null>(null);
  const ids = { webhook: useId(), delivery: useId(), webhookHint: useId() };
  const slack = data.slack;
  const configured = slack.state === 'configured';
  const showForm = slack.state === 'not_configured' || replacing;
  const unsaved = webhook !== '';

  useEffect(() => { onGuard({ unsaved: unsaved ? 'webhook' : null, pending: pending !== null }); }, [unsaved, pending, onGuard]);
  useEffect(() => () => { onGuard(NO_GUARD); }, [onGuard]);

  const run = async <T extends SettingsView | SlackTestResult>(what: SlackAction, fn: (csrf: string, signal: AbortSignal) => Promise<T>, done: (value: T) => Message) => {
    if (busy.current) return;
    busy.current = true;
    setPending(what);
    setMessage(null);
    const r = await mutate(fn);
    if (r === null) return; // unmounted or another session: nothing here changes
    busy.current = false;
    setPending(null);
    if (what === 'webhook') setWebhook(''); // never kept after a submit, successful or not
    if (!r.ok) {
      setMessage({ at: what, message: { tone: 'error', text: errorText(r.error, what === 'webhook' ? 'webhook' : what === 'test' ? 'test' : 'save') } });
      return;
    }
    const value = r.value;
    if ('slack' in value) {
      // The integration changed (another generation): an earlier test answer no longer describes it.
      if (value.slack.generation !== slack.generation) setTest(null);
      onData(value);
      // Each action ends only its own state (review faff773): a delivery change keeps a replacement draft visible;
      // a saved webhook closes the replacement; a confirmed removal also drops a draft typed for the old integration.
      if (what === 'webhook') setReplacing(false);
      if (what === 'remove') { setReplacing(false); setWebhook(''); }
    } else {
      setTest(value);
    }
    setMessage({ at: what === 'remove' ? 'webhook' : what, message: done(value) });
  };

  const reload = () => { if (busy.current) return; if (unsaved) setConfirm('reload'); else onReload(); };
  const stateText = slack.state === 'not_configured' ? 'Не налаштовано'
    : slack.state === 'error' ? `Помилка: ${slack.error ? KEY_ERRORS[slack.error] : 'інтеграція недоступна'}`
      : data.deliveryEnabled ? 'Налаштовано, автоматична доставка увімкнена' : 'Налаштовано, автоматичну доставку вимкнено';
  const testShown = test && test.stored && test.generation === slack.generation ? { outcome: test.outcome, code: test.code, at: test.at } : slack.lastTest;
  const testText = testShown
    ? `${testShown.outcome === 'success' ? 'успішно' : testShown.outcome === 'failed' ? `не вдалося (${testShown.code ?? '—'})` : `результат невідомий (${testShown.code ?? '—'})`} · ${formatDate(testShown.at)}`
    : 'не виконувався для цього webhook';
  const shown = (at: 'webhook' | 'delivery' | 'test' | 'remove') => (message?.at === at ? <MessageBox message={message.message} /> : null);
  const locked = pending !== null;

  return (
    <section className="card settings-card" aria-labelledby="slack-title">
      <div className="settings-head">
        <div className="settings-head__title">
          <h2 id="slack-title" className="card__title">Slack</h2>
          <StatusIndicator tone={slack.state === 'error' ? 'bad' : configured && data.deliveryEnabled ? 'ok' : 'muted'}>{stateText}</StatusIndicator>
        </div>
        <button type="button" className="button button--small" disabled={locked} onClick={reload}>Перечитати стан</button>
      </div>
      <p className="hint settings-card__lead">Incoming Webhook, створений у Slack для потрібного (зокрема приватного) каналу. Канал визначає сам webhook, змінити його тут неможливо.</p>
      {!slack.keyAvailable ? <p className="notice notice--warning">На сервері не задано ключ шифрування (ALERTS_SECRET_KEY): webhook не можна зберегти, доставка не працює.</p> : null}

      <Section title="Webhook" text={showForm ? 'Адреса Incoming Webhook зі Slack. Зберігається зашифрованою й лише для запису.' : 'Заміна скасовує повідомлення в черзі поточного webhook.'}>
        {showForm ? (
          <form className="settings-form" noValidate aria-label={replacing ? 'Заміна webhook' : 'Підключення webhook'} onSubmit={(e: SyntheticEvent) => {
            e.preventDefault();
            if (busy.current) return;
            if (!/^https:\/\/hooks\.slack\.com\/services\/\S+$/.test(webhook)) { setMessage({ at: 'webhook', message: { tone: 'error', text: errorText(new ApiError('invalid_request'), 'webhook') } }); return; }
            const url = webhook;
            void run('webhook', (csrf, signal) => settingsApi.saveSlack(slack.generation, url, csrf, signal), () => ({ tone: 'ok', text: 'Webhook збережено.' }));
          }}>
            <div className="field">
              <label htmlFor={ids.webhook}>{replacing ? 'Новий webhook' : 'Webhook URL'}</label>
              <input id={ids.webhook} type="password" autoComplete="off" spellCheck={false} value={webhook} maxLength={300} disabled={locked}
                onChange={(e) => { if (!busy.current) setWebhook(e.target.value); }} aria-describedby={ids.webhookHint} />
              <p id={ids.webhookHint} className="hint">{replacing
                ? 'Повідомлення в черзі для поточного webhook буде скасовано, а не переслано новому адресату.'
                : 'https://hooks.slack.com/services/… — після збереження значення не показується.'}</p>
            </div>
            <div className="button-row">
              <button type="submit" className="button button--primary" disabled={locked || !slack.keyAvailable || webhook === ''}>{pending === 'webhook' ? 'Збереження…' : 'Зберегти webhook'}</button>
              {replacing ? <button type="button" className="button" disabled={locked} onClick={() => { setReplacing(false); setWebhook(''); setMessage(null); }}>Скасувати</button> : null}
            </div>
          </form>
        ) : (
          <>
            <p>{`Webhook налаштовано${slack.configuredAt ? ` (${formatDate(slack.configuredAt)})` : ''} — значення не показується`}</p>
            {configured ? <button type="button" className="button" disabled={locked} onClick={() => { setReplacing(true); setMessage(null); }}>Замінити webhook</button> : null}
          </>
        )}
        {shown('webhook')}
      </Section>

      <Section title="Автоматична доставка" text="Сповіщення рушія надсилаються в Slack, лише коли доставку ввімкнено.">
        <label htmlFor={ids.delivery} className="switch">
          <input id={ids.delivery} type="checkbox" role="switch" checked={data.deliveryEnabled} disabled={locked || (!configured && !data.deliveryEnabled)}
            onChange={(e) => {
              const enabled = e.target.checked;
              void run('delivery', (csrf, signal) => settingsApi.patch({ revision: data.revision, deliveryEnabled: enabled }, csrf, signal),
                () => ({ tone: 'ok', text: enabled ? 'Автоматичну доставку увімкнено.' : 'Автоматичну доставку вимкнено; повідомлення в черзі скасовано.' }));
            }} />
          <span>Автоматична доставка сповіщень у Slack</span>
        </label>
        <p className="hint">{configured ? 'Вимкнення скасовує повідомлення, що чекають у черзі (вони не надішлються пізніше).' : 'Доступно після збереження webhook.'}</p>
        {!data.publicUrlConfigured ? <p className="hint">Посилання на Node Control у повідомленнях не додається: на сервері не задано ALERTS_PUBLIC_URL.</p> : null}
        {shown('delivery')}
      </Section>

      <Section title="Тестове повідомлення" text="Одне позначене повідомлення в канал збереженого webhook. Працює й тоді, коли автоматичну доставку вимкнено; доставку не вмикає.">
        <button type="button" className="button" disabled={locked || !configured || unsaved}
          onClick={() => { void run('test', (csrf, signal) => settingsApi.testSlack(slack.generation, csrf, signal), testMessage); }}>
          {pending === 'test' ? 'Надсилання…' : 'Надіслати тестове повідомлення'}
        </button>
        {unsaved ? <p className="hint">Спочатку збережіть webhook — тест перевіряє лише збережену інтеграцію.</p>
          : !configured ? <p className="hint">Тест доступний для збереженої інтеграції.</p> : null}
        <dl className="facts settings-facts"><dt>Останній тест</dt><dd>{testText}</dd></dl>
        {shown('test')}
      </Section>

      <Section title="Черга доставки" text="Знімок на момент останнього читання; оновлюється кнопкою «Перечитати стан».">
        <dl className="settings-stats">
          {QUEUE_LABELS.map(([k, label]) => (
            <div key={k} className="settings-stats__item"><dt>{label}</dt><dd className="num">{String(data.queue[k])}</dd></div>
          ))}
        </dl>
      </Section>

      {slack.state !== 'not_configured' ? (
        <Section title="Видалення інтеграції" text="Webhook буде видалено, автоматичну доставку вимкнено, повідомлення в черзі — скасовано. Інциденти залишаться." danger>
          <button type="button" className="button button--danger" disabled={locked} onClick={() => { setConfirm('remove'); }}>Видалити інтеграцію</button>
          {shown('remove')}
        </Section>
      ) : null}

      {confirm === 'remove' ? (
        <Dialog title="Видалити Slack-інтеграцію?" dismissible={pending === null} onClose={() => { if (pending === null) setConfirm(null); }} actions={(
          <>
            <button type="button" className="button" disabled={locked} onClick={() => { setConfirm(null); }}>Скасувати</button>
            <button type="button" className="button button--danger" disabled={locked} onClick={() => {
              void run('remove', (csrf, signal) => settingsApi.removeSlack(slack.generation, csrf, signal), () => ({ tone: 'ok', text: 'Інтеграцію видалено.' })).then(() => { setConfirm(null); });
            }}>{pending === 'remove' ? 'Видалення…' : 'Видалити'}</button>
          </>
        )}>
          <p>Webhook буде видалено, автоматичну доставку вимкнено, а повідомлення в черзі — скасовано. Інциденти залишаться.</p>
          {unsaved ? <p>Введений, але не збережений новий webhook також буде очищено після успішного видалення.</p> : null}
        </Dialog>
      ) : null}
      {confirm === 'reload' ? (
        <DiscardDialog title="Перечитати стан?" text={UNSAVED_TEXT.webhook} keep="Продовжити введення" discard="Очистити й перечитати"
          onKeep={() => { setConfirm(null); }} onDiscard={() => { setConfirm(null); setWebhook(''); onReload(); }} />
      ) : null}
    </section>
  );
}

type Draft = Record<Field, string> & { engineEnabled: boolean; reminderEnabled: boolean };
const toDraft = (d: SettingsView): Draft => ({
  ...Object.fromEntries([...RULE_FIELDS.map((k) => [k, String(d.rules[k])]), ...TIMING_FIELDS.map((k) => [k, String(d.timing[k])]), ...ADVANCED_FIELDS.map((k) => [k, String(d.advanced[k])])]) as Record<Field, string>,
  engineEnabled: d.engineEnabled, reminderEnabled: d.timing.reminderEnabled,
});
function validate(draft: Draft, d: SettingsView): Partial<Record<Field, string>> {
  const e: Partial<Record<Field, string>> = {};
  for (const k of [...RULE_FIELDS, ...TIMING_FIELDS, ...ADVANCED_FIELDS]) {
    const v = draft[k].trim();
    const r = d.ranges[k];
    if (!/^\d+$/.test(v) || Number(v) < r.min || Number(v) > r.max) e[k] = `Ціле число від ${String(r.min)} до ${String(r.max)}.`;
  }
  if (!e.cpuClosePercent && !e.cpuOpenPercent && Number(draft.cpuClosePercent) >= Number(draft.cpuOpenPercent)) e.cpuClosePercent = 'Має бути нижче порогу проблеми.';
  return e;
}

type RulesMessage = { kind: 'ok' | 'error' | 'conflict' | 'unknown'; text: string };

function RulesPanel({ data, onData, onReload, onGuard }: { data: SettingsView; onData: (d: SettingsView) => void; onReload: () => void; onGuard: (g: Guard) => void }) {
  const mutate = useMutation();
  const [draft, setDraft] = useState<Draft>(() => toDraft(data));
  const [base, setBase] = useState(data.revision);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [pending, setPending] = useState(false);
  const busy = useRef(false); // the handlers' own check while the PATCH is in flight (not only the disabled controls)
  const [message, setMessage] = useState<RulesMessage | null>(null);
  const [confirmReload, setConfirmReload] = useState(false);
  const idPrefix = useId();
  const saved = toDraft(data);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || base !== data.revision;
  // After a 409 or an unknown result the stored state is not known: no second PATCH until it is re-read (ADR-022).
  const blocked = message?.kind === 'conflict' || message?.kind === 'unknown';
  useEffect(() => { onGuard({ unsaved: dirty ? 'rules' : null, pending }); }, [dirty, pending, onGuard]);
  useEffect(() => () => { onGuard(NO_GUARD); }, [onGuard]);

  const change = (patch: Partial<Draft>) => { if (!busy.current) setDraft((d) => ({ ...d, ...patch })); };
  const reload = () => { if (busy.current) return; if (dirty) setConfirmReload(true); else onReload(); };

  const [showLimits, setShowLimits] = useState(false);
  // Range/default help is shown on demand (a button, not hover); an error always replaces it, right under its input.
  const control = (k: Field) => {
    const id = `${idPrefix}-${k}`;
    const meta = LABELS[k];
    const r = data.ranges[k];
    const note = errors[k] ?? (showLimits ? `${String(r.min)}–${String(r.max)}, типово ${String(r.default)}` : null);
    return (
      <div className="rules-control" key={k}>
        <label htmlFor={id} className="rules-control__label">{meta.short}</label>
        <div className={`affix${errors[k] ? ' affix--invalid' : ''}`}>
          <input id={id} inputMode="numeric" aria-label={`${meta.label}, ${meta.unit}`} value={draft[k]} disabled={pending}
            onChange={(e) => { change({ [k]: e.target.value }); }}
            aria-invalid={errors[k] ? true : undefined} aria-describedby={note ? `${id}-note` : undefined} />
          <span className="affix__unit" aria-hidden="true">{meta.unit}</span>
        </div>
        {note ? <p id={`${id}-note`} className={errors[k] ? 'field__error rules-control__note' : 'hint rules-control__note'}>{note}</p> : null}
      </div>
    );
  };
  const row = (r: Row) => (
    <div className="rules-row" key={r.title}>
      <div className="rules-row__text"><p className="rules-row__title">{r.title}</p><p className="hint">{r.text}</p></div>
      <div className="rules-row__controls">{r.fields.map(control)}</div>
    </div>
  );

  const onSubmit = async (e: SyntheticEvent) => {
    e.preventDefault();
    if (busy.current || blocked) return;
    const found = validate(draft, data);
    setErrors(found);
    if (Object.keys(found).length > 0) { setMessage({ kind: 'error', text: 'Виправте позначені поля.' }); return; }
    const num = (k: Field) => Number(draft[k]);
    busy.current = true;
    setPending(true);
    setMessage(null);
    const r = await mutate((csrf, signal) => settingsApi.patch({
      revision: base, engineEnabled: draft.engineEnabled,
      rules: Object.fromEntries(RULE_FIELDS.map((k) => [k, num(k)])),
      timing: { intervalSeconds: num('intervalSeconds'), cooldownMinutes: num('cooldownMinutes'), reminderMinutes: num('reminderMinutes'), reminderEnabled: draft.reminderEnabled },
      advanced: Object.fromEntries(ADVANCED_FIELDS.map((k) => [k, num(k)])),
    }, csrf, signal));
    if (r === null) return;
    busy.current = false;
    setPending(false);
    if (r.ok) { onData(r.value); setDraft(toDraft(r.value)); setBase(r.value.revision); setMessage({ kind: 'ok', text: 'Збережено. Нові правила діють з наступного циклу, без перезапуску.' }); return; }
    if (r.error instanceof ApiError && r.error.kind === 'conflict') { setMessage({ kind: 'conflict', text: 'Налаштування змінив інший адміністратор. Ваші зміни не збережено — перечитайте стан і внесіть їх знову.' }); return; }
    if (r.error instanceof ApiError && (r.error.kind === 'network' || r.error.kind === 'timeout')) {
      setMessage({ kind: 'unknown', text: 'Відповідь не отримано — зміни могли зберегтися. Повторно не надсилайте: перечитайте стан і перевірте значення.' });
      return;
    }
    setMessage({ kind: 'error', text: errorText(r.error, 'save') });
  };

  return (
    <form className="card rules-form" onSubmit={(e) => { void onSubmit(e); }} noValidate aria-labelledby="rules-title">
      <div className="rules-form__head">
        <div>
          <h2 id="rules-title" className="visually-hidden">Правила сповіщень</h2>
          <p className="hint">Пороги й цикл перевірки процесів PM2. Нові значення діють з наступного циклу.</p>
        </div>
        <button type="button" className="button button--small" aria-pressed={showLimits} onClick={() => { setShowLimits(!showLimits); }}>
          {showLimits ? 'Сховати межі' : 'Показати межі й типові'}
        </button>
      </div>
      <fieldset className="rules-group">
        <legend>Загальний стан</legend>
        <div className="rules-row">
          <div className="rules-row__text"><p className="rules-row__title">Моніторинг проблем</p><p className="hint">Вимкнений рушій нічого не відстежує й не надсилає.</p></div>
          <div className="rules-row__controls">
            <label className="switch rules-row__wide"><input type="checkbox" role="switch" checked={draft.engineEnabled} disabled={pending} onChange={(e) => { change({ engineEnabled: e.target.checked }); }} />
              <span>Рушій сповіщень (перевірка проблем)</span></label>
          </div>
        </div>
      </fieldset>
      <fieldset className="rules-group"><legend>Навантаження процесів</legend>{LOAD_ROWS.map(row)}</fieldset>
      <fieldset className="rules-group"><legend>Процеси</legend>{PROCESS_ROWS.map(row)}</fieldset>
      <fieldset className="rules-group">
        <legend>Цикл і повтори</legend>
        {row({ title: 'Інтервал перевірки', text: 'Як часто рушій перевіряє стан процесів і серверів.', fields: ['intervalSeconds'] })}
        {row({ title: 'Пауза після відновлення', text: 'Повторна проблема в цей час записується без сповіщення.', fields: ['cooldownMinutes'] })}
        <div className="rules-row">
          <div className="rules-row__text"><p className="rules-row__title">Нагадування</p><p className="hint">Повторне сповіщення, поки проблема не закрита. Інтервал зберігається й тоді, коли нагадування вимкнені.</p></div>
          <div className="rules-row__controls">
            <div className="rules-control">
              <span className="rules-control__label" aria-hidden="true">Стан</span>
              <label className="switch switch--boxed"><input type="checkbox" role="switch" aria-label="Нагадування про незакриті проблеми" checked={draft.reminderEnabled} disabled={pending} onChange={(e) => { change({ reminderEnabled: e.target.checked }); }} />
                <span aria-hidden="true">Надсилати</span></label>
            </div>
            {control('reminderMinutes')}
          </div>
        </div>
      </fieldset>
      <details className="rules-group rules-group--more">
        <summary>Додаткові параметри доставки</summary>
        {ADVANCED_ROWS.map(row)}
      </details>
      <div className="rules-actions">
        {message ? <div className={message.kind === 'ok' ? 'notice rules-actions__message' : message.kind === 'error' ? 'form-error rules-actions__message' : 'notice notice--warning rules-actions__message'} role={message.kind === 'ok' ? 'status' : 'alert'}>
          <p>{message.text}</p>
          {blocked ? <button type="button" className="button" onClick={reload}>Перечитати стан</button> : null}
        </div> : null}
        <div className="rules-actions__bar">
          {pending ? <p className="hint" role="status">Збереження… Зміни недоступні до відповіді.</p>
            : dirty ? <p className="rules-actions__dirty">Є незбережені зміни.</p> : <p className="hint">Змін немає.</p>}
          <div className="button-row">
            <button type="button" className="button" disabled={pending || !dirty} onClick={() => { setDraft(saved); setBase(data.revision); setErrors({}); if (!blocked) setMessage(null); }}>Скасувати зміни</button>
            <button type="submit" className="button button--primary" disabled={pending || !dirty || blocked}>{pending ? 'Збереження…' : 'Зберегти'}</button>
          </div>
        </div>
      </div>
      {confirmReload ? (
        <DiscardDialog title="Перечитати стан?" text={UNSAVED_TEXT.rules} keep="Продовжити редагування" discard="Відкинути й перечитати"
          onKeep={() => { setConfirmReload(false); }} onDiscard={() => { setConfirmReload(false); onReload(); }} />
      ) : null}
    </form>
  );
}

export function SettingsPage() {
  const { can, bindSession, sessionExpired } = useAuth();
  const { tab } = useParams();
  const active = tab === 'rules' ? 'rules' : 'integrations';
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; data: SettingsView } | { status: 'error'; text: string } | { status: 'forbidden' }>({ status: 'loading' });
  const [guard, setGuard] = useState<Guard>(NO_GUARD);
  const [seq, setSeq] = useState(0);
  const allowed = can('alerts:manage');

  useEffect(() => {
    if (!allowed) return undefined;
    const controller = new AbortController();
    const binding = bindSession();
    settingsApi.get(controller.signal).then(
      (data) => { if (!controller.signal.aborted && binding.current()) setState({ status: 'ready', data }); },
      (error: unknown) => {
        if (controller.signal.aborted || !binding.current()) return;
        if (error instanceof ApiError && error.kind === 'unauthorized') { sessionExpired(); return; }
        if (error instanceof ApiError && error.kind === 'forbidden') { setState({ status: 'forbidden' }); return; }
        setState({ status: 'error', text: errorText(error, 'load') });
      },
    );
    return () => { controller.abort(); };
  }, [allowed, seq, bindSession, sessionExpired]);

  // Leaving (another tab, a link, Back/Forward) would drop unsaved input or stop waiting for a request: ask first.
  // Logout and session expiry are never blocked: they unmount the private area together with this blocker.
  const leaving = guard.pending || guard.unsaved !== null;
  const shouldBlock = useCallback<BlockerFunction>(({ currentLocation, nextLocation }) => leaving && currentLocation.pathname !== nextLocation.pathname, [leaving]);
  const blocker = useBlocker(shouldBlock);
  useEffect(() => {
    if (!leaving) return undefined;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); };
  }, [leaving]);

  const onGuard = useCallback((g: Guard) => { setGuard((p) => (p.unsaved === g.unsaved && p.pending === g.pending ? p : g)); }, []);
  const reload = useCallback(() => { setState({ status: 'loading' }); setSeq((n) => n + 1); }, []);
  const onData = useCallback((data: SettingsView) => { setState({ status: 'ready', data }); }, []);

  if (!allowed || state.status === 'forbidden') return <Forbidden />;
  const tabLink = (to: 'integrations' | 'rules', label: string) => (
    <NavLink to={`/settings/${to}`} className={() => `tab${active === to ? ' tab--active' : ''}`} aria-current={active === to ? 'page' : undefined}>{label}</NavLink>
  );
  return (
    <section className="page" aria-labelledby="settings-title">
      <PageHeader title="Налаштування" titleId="settings-title" meta={<span>Сповіщення: інтеграція зі Slack і правила. Зміни діють без перезапуску.</span>}
        actions={<Link className="button" to="/alerts">До сповіщень</Link>} />
      <nav className="tabs" aria-label="Розділи налаштувань">
        {tabLink('integrations', 'Інтеграції')}
        {tabLink('rules', 'Правила сповіщень')}
      </nav>
      {state.status === 'loading' ? <LoadingState /> : null}
      {state.status === 'error' ? <ErrorState title="Не вдалося завантажити налаштування" onRetry={reload}>{state.text}</ErrorState> : null}
      {state.status === 'ready' ? (
        active === 'integrations'
          ? <SlackPanel data={state.data} onData={onData} onReload={reload} onGuard={onGuard} />
          : <RulesPanel key={`rules-${String(seq)}`} data={state.data} onData={onData} onReload={reload} onGuard={onGuard} />
      ) : null}
      {blocker.state === 'blocked' ? (
        guard.pending ? (
          <DiscardDialog title="Запит ще виконується"
            text="Запит уже надіслано, і вихід його не скасує: налаштування можуть змінитися. Результат видно лише тут — після виходу відкрийте налаштування знову й перевірте."
            keep="Залишитися" discard="Вийти без очікування" onKeep={() => { blocker.reset(); }} onDiscard={() => { blocker.proceed(); }} />
        ) : (
          <DiscardDialog title="Скасувати зміни?" text={UNSAVED_TEXT[guard.unsaved ?? 'rules']}
            keep={guard.unsaved === 'webhook' ? 'Продовжити введення' : 'Продовжити редагування'} discard="Відкинути зміни"
            onKeep={() => { blocker.reset(); }} onDiscard={() => { blocker.proceed(); }} />
        )
      ) : null}
    </section>
  );
}
