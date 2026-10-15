import { type SyntheticEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link, NavLink, useParams } from 'react-router';
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

function errorText(error: unknown, what: 'save' | 'webhook' | 'test' | 'load'): string {
  if (!(error instanceof ApiError)) return 'Неочікувана помилка. Перечитайте стан.';
  switch (error.kind) {
    case 'conflict': return 'Налаштування вже змінились (інший адміністратор, інша вкладка, тест у процесі або інтеграція не налаштована). Перечитайте стан і повторіть.';
    case 'invalid_request': return what === 'webhook' ? 'Це не Slack Incoming Webhook URL (https://hooks.slack.com/services/…).' : 'Перевірте значення: деякі поза допустимими межами.';
    case 'forbidden': return 'Недостатньо прав.';
    case 'rate_limited': return `Забагато запитів.${formatRetry(error.retryAfterSeconds) || ' Спробуйте пізніше.'}`;
    case 'unavailable': return `Сервіс тимчасово недоступний.${formatRetry(error.retryAfterSeconds) || ' Спробуйте пізніше.'}`;
    case 'network': case 'timeout':
      return what === 'load' ? 'Не вдалося отримати відповідь.' : 'Відповідь не отримано — зміна могла застосуватись. Перечитайте стан перед повтором.';
    default: return 'Неочікувана помилка. Перечитайте стан.';
  }
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
    }
  }, [csrf, bindSession, sessionExpired]);
}

function SlackPanel({ data, onData, onReload }: { data: SettingsView; onData: (d: SettingsView) => void; onReload: () => void }) {
  const mutate = useMutation();
  const [webhook, setWebhook] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [pending, setPending] = useState<null | 'webhook' | 'delivery' | 'test' | 'remove'>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [test, setTest] = useState<SlackTestResult | null>(null);
  const ids = { webhook: useId(), delivery: useId(), webhookHint: useId() };
  const slack = data.slack;
  const configured = slack.state === 'configured';
  const showForm = slack.state === 'not_configured' || replacing;
  const unsaved = webhook !== '';

  const run = async (what: 'webhook' | 'delivery' | 'test' | 'remove', fn: (csrf: string, signal: AbortSignal) => Promise<SettingsView | SlackTestResult>, success: string) => {
    if (pending) return;
    setPending(what);
    setMessage(null);
    const r = await mutate(fn);
    if (r === null) return;
    setPending(null);
    if (what === 'webhook') setWebhook(''); // never kept after a submit, successful or not
    if (!r.ok) { setMessage({ kind: 'error', text: errorText(r.error, what === 'webhook' ? 'webhook' : what === 'test' ? 'test' : 'save') }); return; }
    if ('slack' in r.value) { onData(r.value); setReplacing(false); } else { setTest(r.value); }
    setMessage({ kind: 'ok', text: success });
  };

  const state = slack.state === 'not_configured' ? 'Не налаштовано'
    : slack.state === 'error' ? `Помилка: ${slack.error ? KEY_ERRORS[slack.error] : 'інтеграція недоступна'}`
      : data.deliveryEnabled ? 'Налаштовано, автоматична доставка увімкнена' : 'Налаштовано, автоматичну доставку вимкнено';
  const testShown = test && test.generation === slack.generation ? { outcome: test.outcome, code: test.code, at: test.at } : slack.lastTest;

  return (
    <section className="card settings-card" aria-labelledby="slack-title">
      <div className="settings-head">
        <h2 id="slack-title" className="section__title">Slack</h2>
        <StatusIndicator tone={slack.state === 'error' ? 'bad' : configured && data.deliveryEnabled ? 'ok' : 'muted'}>{state}</StatusIndicator>
      </div>
      <p className="hint">Incoming Webhook, створений у Slack для потрібного (зокрема приватного) каналу. Канал визначає сам webhook, змінити його тут неможливо.</p>
      <dl className="facts">
        {configured || slack.state === 'error' ? <><dt>Webhook</dt><dd>{`Webhook налаштовано${slack.configuredAt ? ` (${formatDate(slack.configuredAt)})` : ''} — значення не показується`}</dd></> : null}
        <dt>Останній тест</dt><dd>{testShown ? `${testShown.outcome === 'success' ? 'успішно' : testShown.outcome === 'failed' ? `не вдалося (${testShown.code ?? '—'})` : `результат невідомий (${testShown.code ?? '—'})`} · ${formatDate(testShown.at)}` : 'не виконувався для цього webhook'}</dd>
        <dt>Черга</dt><dd>{`у черзі ${String(data.queue.queued)} · надсилається ${String(data.queue.sending)} · надіслано ${String(data.queue.sent)} · не доставлено ${String(data.queue.failed)} · невідомо ${String(data.queue.unknown)} · скасовано ${String(data.queue.cancelled)} · відкинуто ${String(data.queue.dropped)}`}</dd>
      </dl>
      {!slack.keyAvailable ? <p className="notice notice--warning">На сервері не задано ключ шифрування (ALERTS_SECRET_KEY): webhook не можна зберегти, доставка не працює.</p> : null}
      {message ? <p className={message.kind === 'ok' ? 'notice' : 'form-error'} role={message.kind === 'ok' ? 'status' : 'alert'}>{message.text}</p> : null}

      <div className="settings-block">
        <h3 className="settings-block__title">{showForm ? (replacing ? 'Новий webhook' : 'Підключення') : 'Перевірка й доставка'}</h3>
        {showForm ? (
          <form className="settings-form" noValidate onSubmit={(e: SyntheticEvent) => {
            e.preventDefault();
            if (!/^https:\/\/hooks\.slack\.com\/services\/\S+$/.test(webhook)) { setMessage({ kind: 'error', text: errorText(new ApiError('invalid_request'), 'webhook') }); return; }
            const url = webhook;
            void run('webhook', (csrf, signal) => settingsApi.saveSlack(slack.generation, url, csrf, signal), 'Webhook збережено.');
          }}>
            <div className="field">
              <label htmlFor={ids.webhook}>{replacing ? 'Новий webhook' : 'Webhook URL'}</label>
              <input id={ids.webhook} type="password" autoComplete="off" spellCheck={false} value={webhook} maxLength={300} disabled={pending !== null}
                onChange={(e) => { setWebhook(e.target.value); }} aria-describedby={ids.webhookHint} />
              <p id={ids.webhookHint} className="hint">{replacing
                ? 'Повідомлення в черзі для поточного webhook буде скасовано, а не переслано новому адресату.'
                : 'https://hooks.slack.com/services/… — після збереження значення не показується.'}</p>
            </div>
            <div className="button-row">
              <button type="submit" className="button button--primary" disabled={pending !== null || !slack.keyAvailable || webhook === ''}>{pending === 'webhook' ? 'Збереження…' : 'Зберегти webhook'}</button>
              {replacing ? <button type="button" className="button" disabled={pending !== null} onClick={() => { setReplacing(false); setWebhook(''); }}>Скасувати</button> : null}
            </div>
          </form>
        ) : null}
        <div className="button-row">
          <button type="button" className={`button${configured && !showForm ? ' button--primary' : ''}`} disabled={pending !== null || !configured || unsaved}
            onClick={() => { void run('test', (csrf, signal) => settingsApi.testSlack(slack.generation, csrf, signal), 'Тестове повідомлення оброблено.'); }}>
            {pending === 'test' ? 'Надсилання…' : 'Надіслати тестове повідомлення'}
          </button>
        </div>
        {unsaved ? <p className="hint">Спочатку збережіть webhook — тест перевіряє лише збережену інтеграцію.</p> : !configured ? <p className="hint">Тест доступний для збереженої інтеграції.</p> : <p className="hint">Тест надсилає одне позначене повідомлення в канал webhook; працює, навіть коли автоматичну доставку вимкнено.</p>}
        <div className="field">
          <label htmlFor={ids.delivery} className="switch">
            <input id={ids.delivery} type="checkbox" role="switch" checked={data.deliveryEnabled} disabled={pending !== null || (!configured && !data.deliveryEnabled)}
              onChange={(e) => {
                const enabled = e.target.checked;
                void run('delivery', (csrf, signal) => settingsApi.patch({ revision: data.revision, deliveryEnabled: enabled }, csrf, signal),
                  enabled ? 'Автоматичну доставку увімкнено.' : 'Автоматичну доставку вимкнено; повідомлення в черзі скасовано.');
              }} />
            <span>Автоматична доставка сповіщень у Slack</span>
          </label>
          <p className="hint">{configured ? 'Вимкнення скасовує повідомлення, що чекають у черзі (вони не надішлються пізніше).' : 'Доступно після збереження webhook.'}</p>
        </div>
      </div>

      <div className="settings-block">
        <h3 className="settings-block__title">Інші дії</h3>
        <div className="button-row">
          {configured && !replacing ? <button type="button" className="button button--small" disabled={pending !== null} onClick={() => { setReplacing(true); setMessage(null); }}>Замінити webhook</button> : null}
          <button type="button" className="button button--small" disabled={pending !== null} onClick={onReload}>Перечитати стан</button>
          {slack.state !== 'not_configured' ? <button type="button" className="button button--small button--danger" disabled={pending !== null} onClick={() => { setConfirmRemove(true); }}>Видалити інтеграцію</button> : null}
        </div>
      </div>

      {confirmRemove ? (
        <Dialog title="Видалити Slack-інтеграцію?" dismissible={pending === null} onClose={() => { if (pending === null) setConfirmRemove(false); }} actions={(
          <>
            <button type="button" className="button" disabled={pending !== null} onClick={() => { setConfirmRemove(false); }}>Скасувати</button>
            <button type="button" className="button button--danger" disabled={pending !== null} onClick={() => {
              void run('remove', (csrf, signal) => settingsApi.removeSlack(slack.generation, csrf, signal), 'Інтеграцію видалено.').then(() => { setConfirmRemove(false); });
            }}>{pending === 'remove' ? 'Видалення…' : 'Видалити'}</button>
          </>
        )}>
          <p>Webhook буде видалено, автоматичну доставку вимкнено, а повідомлення в черзі — скасовано. Інциденти залишаться.</p>
        </Dialog>
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

function RulesPanel({ data, onData, onReload, onDirty }: { data: SettingsView; onData: (d: SettingsView) => void; onReload: () => void; onDirty: (dirty: boolean) => void }) {
  const mutate = useMutation();
  const [draft, setDraft] = useState<Draft>(() => toDraft(data));
  const [base, setBase] = useState(data.revision);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'conflict'; text: string } | null>(null);
  const idPrefix = useId();
  const saved = toDraft(data);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || base !== data.revision;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);

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
            onChange={(e) => { setDraft({ ...draft, [k]: e.target.value }); }}
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
    if (pending) return;
    const found = validate(draft, data);
    setErrors(found);
    if (Object.keys(found).length > 0) { setMessage({ kind: 'error', text: 'Виправте позначені поля.' }); return; }
    const num = (k: Field) => Number(draft[k]);
    setPending(true);
    setMessage(null);
    const r = await mutate((csrf, signal) => settingsApi.patch({
      revision: base, engineEnabled: draft.engineEnabled,
      rules: Object.fromEntries(RULE_FIELDS.map((k) => [k, num(k)])),
      timing: { intervalSeconds: num('intervalSeconds'), cooldownMinutes: num('cooldownMinutes'), reminderMinutes: num('reminderMinutes'), reminderEnabled: draft.reminderEnabled },
      advanced: Object.fromEntries(ADVANCED_FIELDS.map((k) => [k, num(k)])),
    }, csrf, signal));
    if (r === null) return;
    setPending(false);
    if (r.ok) { onData(r.value); setDraft(toDraft(r.value)); setBase(r.value.revision); setMessage({ kind: 'ok', text: 'Збережено. Нові правила діють з наступного циклу, без перезапуску.' }); return; }
    if (r.error instanceof ApiError && r.error.kind === 'conflict') { setMessage({ kind: 'conflict', text: 'Налаштування змінив інший адміністратор. Ваші зміни не збережено — перечитайте стан і внесіть їх знову.' }); return; }
    setMessage({ kind: 'error', text: errorText(r.error, 'save') });
  };

  return (
    <form className="card rules-form" onSubmit={(e) => { void onSubmit(e); }} noValidate aria-labelledby="rules-title">
      <div className="rules-form__head">
        <h2 id="rules-title" className="card__title">Правила сповіщень</h2>
        <button type="button" className="button button--secondary rules-form__limits" aria-pressed={showLimits} onClick={() => { setShowLimits(!showLimits); }}>
          {showLimits ? 'Сховати межі' : 'Показати межі й типові'}
        </button>
      </div>
      <fieldset className="rules-group">
        <legend>Загальний стан</legend>
        <div className="rules-row">
          <div className="rules-row__text"><p className="rules-row__title">Моніторинг проблем</p><p className="hint">Вимкнений рушій нічого не відстежує й не надсилає.</p></div>
          <div className="rules-row__controls">
            <label className="switch rules-row__wide"><input type="checkbox" role="switch" checked={draft.engineEnabled} disabled={pending} onChange={(e) => { setDraft({ ...draft, engineEnabled: e.target.checked }); }} />
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
              <label className="switch switch--boxed"><input type="checkbox" role="switch" aria-label="Нагадування про незакриті проблеми" checked={draft.reminderEnabled} disabled={pending} onChange={(e) => { setDraft({ ...draft, reminderEnabled: e.target.checked }); }} />
                <span aria-hidden="true">Надсилати</span></label>
            </div>
            {control('reminderMinutes')}
          </div>
        </div>
      </fieldset>
      <details className="rules-group rules-group--more">
        <summary>Додаткові параметри</summary>
        {ADVANCED_ROWS.map(row)}
      </details>
      <div className="rules-actions">
        {message ? <div className={message.kind === 'ok' ? 'notice rules-actions__message' : 'form-error rules-actions__message'} role={message.kind === 'ok' ? 'status' : 'alert'}>
          <p>{message.text}</p>
          {message.kind === 'conflict' ? <button type="button" className="button" onClick={() => { onReload(); setMessage(null); }}>Перечитати стан</button> : null}
        </div> : null}
        <div className="rules-actions__bar">
          {dirty ? <p className="rules-actions__dirty">Є незбережені зміни.</p> : <p className="hint">Змін немає.</p>}
          <div className="button-row">
            <button type="button" className="button button--secondary" disabled={pending || !dirty} onClick={() => { setDraft(saved); setBase(data.revision); setErrors({}); setMessage(null); }}>Скасувати зміни</button>
            <button type="submit" className="button button--primary" disabled={pending || !dirty}>{pending ? 'Збереження…' : 'Зберегти'}</button>
          </div>
        </div>
      </div>
    </form>
  );
}

export function SettingsPage() {
  const { can, bindSession, sessionExpired } = useAuth();
  const { tab } = useParams();
  const active = tab === 'rules' ? 'rules' : 'integrations';
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; data: SettingsView } | { status: 'error'; text: string } | { status: 'forbidden' }>({ status: 'loading' });
  const [dirty, setDirty] = useState(false);
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

  // Unsaved changes: the browser asks before leaving the page.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); };
  }, [dirty]);

  const reload = useCallback(() => { setState({ status: 'loading' }); setSeq((n) => n + 1); }, []);
  const onData = useCallback((data: SettingsView) => { setState({ status: 'ready', data }); }, []);

  if (!allowed || state.status === 'forbidden') return <Forbidden />;
  return (
    <section className="page" aria-labelledby="settings-title">
      <PageHeader title="Налаштування" titleId="settings-title" meta={<span>Сповіщення: інтеграція зі Slack і правила. Зміни діють без перезапуску.</span>}
        actions={<Link className="button" to="/alerts">До сповіщень</Link>} />
      <nav className="tabs" aria-label="Розділи налаштувань">
        <NavLink to="/settings/integrations" className={() => `tab${active === 'integrations' ? ' tab--active' : ''}`} aria-current={active === 'integrations' ? 'page' : undefined}
          onClick={(e) => { if (dirty && active !== 'integrations' && !window.confirm('Є незбережені зміни правил. Перейти без збереження?')) e.preventDefault(); }}>Інтеграції</NavLink>
        <NavLink to="/settings/rules" className={() => `tab${active === 'rules' ? ' tab--active' : ''}`} aria-current={active === 'rules' ? 'page' : undefined}>Правила сповіщень</NavLink>
      </nav>
      {state.status === 'loading' ? <LoadingState /> : null}
      {state.status === 'error' ? <ErrorState title="Не вдалося завантажити налаштування" onRetry={reload}>{state.text}</ErrorState> : null}
      {state.status === 'ready' ? (
        active === 'integrations'
          ? <SlackPanel key={`slack-${String(state.data.slack.generation)}`} data={state.data} onData={onData} onReload={reload} />
          : <RulesPanel key={`rules-${String(seq)}`} data={state.data} onData={onData} onReload={reload} onDirty={setDirty} />
      ) : null}
    </section>
  );
}
