# Node Control

Централізована платформа для моніторингу та керування Node.js-проєктами на декількох серверах.

> Реалізовано (стан на 2026-10-15): Central API (systemd) з auth, RBAC, audit log, міграціями; React/Vite UI; реєстр серверів і Agent heartbeat; PM2 inventory через локальний exporter; керування явно дозволеними PM2-процесами (start/stop/restart) і перегляд їхніх логів через локальний broker — зі сторінки сервера та з розділу «Застосунки» (ADR-017/018/024); користувачі та зміна власного пароля; Dashboard; сповіщення в Slack. Не реалізовано: redeploy через Jenkins, WebSocket, видалення користувачів. Інсталятори первинного встановлення додано 2026-10-20 (наскрізно на чистій VM ще не перевірені). Production-готовність не заявляється: відкриті release blockers — у [PROJECT_STATUS](docs/PROJECT_STATUS.md).

Task 001 підтверджений файлами та локальними unit-тестами, але серверний стан незалежно не підтверджено. Актуальні результати й проблеми — [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md).

## Встановлення

Node Control — self-hosted панель для серверів із PM2-застосунками: центральний сервер (Central API + веб-інтерфейс, host PostgreSQL і Nginx) і легкий Agent на кожному сервері (лише вихідний HTTPS; список PM2-процесів, керування й логи — тільки явно увімкнені).

Передумови:
- Ubuntu із systemd (x86_64 або arm64), користувач із sudo або root;
- на центральному сервері — PostgreSQL і Nginx, домен і TLS-сертифікат;
- мережа до `registry.npmjs.org` (і до `nodejs.org`, якщо сумісного Node.js 22 немає).

```bash
git clone <URL репозиторію> node-control
cd node-control
./install.sh
```

Окремі `npm ci`, збирання чи пошук артефактів не потрібні. `install.sh`:
1. питає, що встановлювати (Central Server або Agent);
2. перевіряє середовище;
3. за потреби, після підтвердження, встановлює окремий Node.js 22 у `/opt/node-control-runtime` (системний Node.js не змінюється);
4. збирає реліз закоміченої ревізії не від root;
5. збирає параметри, показує план і лише після «так» встановлює.

Для центрального сервера заздалегідь потрібні БД (PostgreSQL) і, для доступу ззовні, Nginx із TLS. Для Agent — ключ із UI («Додати сервер» → «Видати ключ»).

Advanced/offline (готовий реліз, `sudo ./install.sh --release <каталог>`) і неінтерактивний маршрут (`server-bundle/install/server.js`/`agent.js plan|apply`) лишаються для серверів без мережі й для автоматизації.

Повна інструкція (команди, що змінюється, діагностика, відновлення, секрети) — [docs/INSTALLATION.md](docs/INSTALLATION.md). Оновлення й rollback наявних інсталяцій — [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Межі: інші ОС і Docker не підтримуються; PM2 і його автозапуск Node Control не налаштовує. Фактично перевірені платформи й сценарії (зокрема те, що x86_64 ще не перевірено на справжній VM) — у PROJECT_STATUS.

## Постійний контекст розробки

- [AGENTS.md](AGENTS.md) — головні інструкції Codex та Claude.
- [Архітектура](docs/ARCHITECTURE.md) — фактичні компоненти й ціль MVP1.
- [Стан проєкту](docs/PROJECT_STATUS.md) — перевірки, проблеми та наступний етап.
- [Рішення](docs/DECISIONS.md), [правила розробки](docs/DEVELOPMENT_RULES.md), [AI workflow](docs/AI_WORKFLOW.md).
- [Встановлення](docs/INSTALLATION.md) — первинне встановлення інсталяторами.
- [Деплой і rollback](docs/DEPLOYMENT.md) — чинна процедура деплою, перевірок і rollback; історичні процедури позначені окремо.

## Архітектурні принципи

1. На поточному етапі без Docker / Docker Compose — PostgreSQL і Nginx працюють безпосередньо на хості.
2. Central API та Agent — systemd, незалежно від PM2; frontend — статична React/Vite-збірка через Nginx, без окремого Node.js-процесу. Новий код — TypeScript.
3. Setup розрахований на повторний запуск; production-готовність потребує перевірки середовища та сценаріїв помилок.
4. Перед змінами — аудит сервера (результати зберігаються поза публічним репозиторієм), після змін — перевірка працездатності.
5. Допоміжна логіка має автоматизовані тести; повне покриття orchestration/error paths скриптів не підтверджено.
6. Секрети живуть лише в `.env` (права `600`), ніколи в Git, документації чи логах.
7. Існуючі сервіси сервера (менеджер секретів, Nginx, інші БД) не змінюються.

## Системні вимоги

- Цільовий runtime: Node.js 22 LTS, npm (`package.json` наразі допускає `>=22`)
- PostgreSQL 18 (на сервері — кластер `18/main`, port 5432)
- Для `npm run db:setup` і серверних перевірок: root на хості PostgreSQL

## Структура

```text
.
├── agent/            # Node.js Agent: вихідний HTTPS heartbeat (src/, test/, dist/ — збірка)
├── backend/          # Central API: TypeScript + Fastify (src/, test/, dist/ — збірка, не в Git)
│   └── migrations/   # версійні SQL-міграції (node-pg-migrate)
├── frontend/         # React + Vite UI (src/, test/, dist/ — збірка, не в Git)
├── installer/        # інсталятори API й Agent (TypeScript, plan/apply; dist/ → server-bundle/install/)
├── e2e/              # Playwright E2E (реальний backend + UI, тестова БД)
├── deploy/           # systemd/ (unit)
├── docs/
├── scripts/
│   ├── lib/          # чиста логіка: env, пароль, SCRAM, SQL, pg_hba, план налаштування, пошук секретів
│   ├── setup-postgres.js   # npm run db:setup
│   ├── setup-test-db.js    # ізольована тестова БД/роль (root на сервері)
│   ├── db-check.js         # npm run db:check
│   ├── check-secrets.js    # npm run check:secrets
│   └── deploy/             # build-release.js (локально), server-release.js (сервер), lib/
├── tests/
│   ├── unit/         # без мережі та БД
│   ├── integration/  # реальна БД через .env
│   └── helpers/
├── .env              # не в Git
├── .env.example
├── eslint.config.js  # lint: backend, frontend, e2e, agent (npm run lint)
└── package.json
```

## PostgreSQL

Використовується вже встановлений PostgreSQL на сервері. `npm run db:setup` (root, на сервері) ідемпотентно:

1. Створює роль `node_control_user` — `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`.
   Пароль генерується (48 символів, ~285 біт), у PostgreSQL передається **лише SCRAM-SHA-256 verifier**, обчислений у Node, — відкритий пароль не потрапляє в SQL, логи PostgreSQL чи список процесів.
2. Створює базу `node_control_db` з власником `node_control_user`; забирає `CONNECT`/`TEMPORARY` у `PUBLIC`, тож інші ролі кластера до неї не підключаються.
3. Спершу записує `.env` (атомарно, `600`), потім змінює роль — згенерований пароль не загубиться.
4. Робить бекап `pg_hba.conf`, додає в кінець **одне** правило і перевіряє файл через `pg_hba_file_rules` до застосування; якщо є помилка — відновлює оригінал. Застосовує через `pg_reload_conf()` — без рестарту.

   ```text
   hostssl node_control_db node_control_user 0.0.0.0/0 scram-sha-256
   ```

Повторний запуск примусово застосовує атрибути існуючої ролі й ACL бази; пароль **не перезаписується** без ротації. Якщо роль є, а `.env` загублено — скрипт зупиниться; змінити пароль можна явно:

```bash
npm run db:setup -- --rotate-password            # новий пароль + новий .env
npm run db:setup -- --env-owner nodecontrol      # власник .env (користувач сервісу)
npm run db:setup -- --skip-hba                   # не чіпати pg_hba.conf
```

`--env-owner` діє лише коли `.env` записується; власник уже валідного файлу без ротації не зміниться. Setup не є єдиною транзакцією: після запису `.env` можливий збій SQL; recovery та HBA failure paths потребують окремої перевірки.

## `.env`

```dotenv
DB_NAME=node_control_db
DB_USER=node_control_user
DB_HOST=127.0.0.1
DB_PASS=<generated_secure_password>
DB_PORT=5432
```

- Цей `.env` — для скриптів PostgreSQL (`db:setup`, `db:check`, `test:integration`, Task 001) і локальної розробки. **Runtime API його не читає:** сервіс `node-control-api` бере конфігурацію лише з `/etc/node-control/api.env` (`600 nodecontrol`, `Environment=ENV_FILE=…` у unit) — див. DEPLOYMENT. Історичний серверний `/etc/pm2-dashboard/.env` (Task 001/002) сервісом не використовується.
- `.env` і `.env.*` ігноруються Git (крім `.env.example`); `npm run check:secrets` це перевіряє і шукає реальний пароль у всіх файлах, що можуть потрапити в коміт.

## Central API (backend)

TypeScript (strict) + Fastify 5, PostgreSQL pool, health endpoints, authentication із серверними сесіями, CSRF, RBAC, audit log, структуровані логи, обробка помилок, graceful shutdown. Реєстр серверів і machine-auth heartbeat Agent (Task 007), PM2 inventory (Task 008), керування дозволеними PM2-процесами (Task 009), обмежений перегляд логів (Task 010), користувачі: створення, зміна ролі, деактивація/активація, зміна власного пароля (Task 011; видалення, зміни email і скидання пароля адміністратором немає), Dashboard (Task 012), сповіщення (Task 013). **WebSocket і Jenkins redeploy не реалізовані.**

Runtime: **Node.js 22 LTS** (Fastify 5 офіційно підтримує Node 20/22, Vitest 5 потребує Node ≥ 22.12). Якщо локально інша версія, перевірки на 22 можна запускати через `npx -y node@22 …` (див. нижче).

```bash
npm ci                    # залежності з lockfile
npm run backend:dev       # tsx watch, src/main.ts, читає .env + process env
npm run backend:build     # tsc → backend/dist
npm run backend:start     # node backend/dist/main.js
```

### Конфігурація

| Змінна | За замовчуванням | Правило |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `API_HOST` | `127.0.0.1` | IP або hostname; loopback — API стоїть за host Nginx |
| `API_PORT` | `3100` | 1–65535 |
| `LOG_LEVEL` | `info` | `fatal` `error` `warn` `info` `debug` `trace` `silent` |
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `5432` | IP або hostname / 1–65535 |
| `DB_NAME`, `DB_USER`, `DB_PASS` | — | обов'язкові |
| `ENV_FILE` | `<repo>/.env` | шлях до dotenv-файлу; відсутній файл — не помилка |
| `API_TRUSTED_PROXIES` | порожньо | точні loopback-IP локального reverse proxy (production: `127.0.0.1`); порожньо — `trustProxy` вимкнено (ADR-014) |

Пріоритет: **process environment > `.env`**. Некоректна конфігурація зупиняє startup з exit code 1; повідомлення називає лише ключі та правила, без значень. Пул: max 5 з'єднань; таймаути connect/query/statement — 2 с, idle — 10 с, readiness — 2,5 с, shutdown — 10 с (константи в `backend/src/config.ts`). Логується лише `nodeEnv/host/port/logLevel`.

Порт `127.0.0.1:3100` затверджено й використовується на сервері (Task 003, systemd `node-control-api.service`).

### Health endpoints (публічні навмисно, без authentication)

| Запит | Відповідь |
|---|---|
| `GET /health/live` | `200 {"status":"ok"}` — не звертається до БД |
| `GET /health/ready` | `200 {"status":"ready"}` після `SELECT 1`; `503 {"status":"unavailable"}` при помилці або таймауті |
| інший маршрут/метод | `404 {"statusCode":404,"error":"Not Found","message":"Route not found"}` |

Обидва health-маршрути повертають `Cache-Control: no-store`; кожна відповідь — `x-request-id` (UUID, що генерує сервер; клієнтський заголовок ігнорується). Причина 503 пишеться лише в лог як метадані (`category` + `code` з allowlist). Недоступна БД не зупиняє процес. CORS не вмикається.

### Authentication API (контракт для frontend)

Деталі й обґрунтування — ADR-011. Усі `/api` відповіді мають `Cache-Control: no-store` і `x-request-id`. Frontend працює **same-origin** (Vite proxy у розробці, Nginx у production); CORS не вмикається.

| Запит | Доступ | Успіх | Помилки |
|---|---|---|---|
| `POST /api/auth/login` `{"email","password"}` | public + Origin | `200 {user:{id,email,role}, permissions[], csrfToken, expiresAt}` + `Set-Cookie: __Host-nc_session=…` | 400 validation, 401 `Invalid email or password` (однаково для будь-якої причини), 403 `Request origin not allowed`, 429 + `Retry-After`, 503 + `Retry-After` |
| `GET /api/auth/me` | сесія | `200` — той самий об'єкт, що й login | 401 `Authentication required` (+ очищення cookie, якщо вона була), 503 |
| `POST /api/auth/logout` (без тіла) | сесія + Origin + `x-csrf-token` | `204`, cookie очищено | 401, 403 (Origin/CSRF), 503 |
| `GET /api/audit?limit=1..100&beforeId=<id>` | `audit:read` (admin) | `200 {items:[{id,occurredAt,event,outcome,actorUserId,requestId,details,context:{actorEmail,serverName,targetUserEmail,command:{requestedBy,requestedByEmail,serviceName}\|null}}], nextBeforeId}` — `id DESC`, keyset; `context` (ADR-033) — поточні email і назви пов'язаних записів на момент перегляду, один запит на сторінку | 400, 401, 403 `Insufficient permissions`, 503 |

### Сповіщення (Task 013, ADR-021) — вимкнено за замовчуванням

| Запит | Доступ | Успіх | Помилки |
|---|---|---|---|
| `GET /api/alerts?state=active\|resolved&limit=1..100&before=<uuid>` | `monitoring:read` | `200 {items:[{id, rule, severity, status, resolution, serverId, serverName, serverStatus, processName, pmId, detail, openedAt, lastObservedAt, resolvedAt, notification}], nextBefore}`; `notification` лише для `alerts:manage`, інакше `null` | 400, 401, 403, 503 |
| `GET /api/alerts/status` | `monitoring:read` | `200 {engine:{enabled, running, lastEvaluationAt, lastEvaluationOk}, delivery:{enabled}, activeCount, admin}`; `admin` (черга, пороги, `webhookConfigured`) лише для `alerts:manage` | 401, 403, 503 |

Налаштування й Slack — у розділі «Налаштування» (admin, ADR-022); в `api.env` лише ключ шифрування й public origin. Webhook ніколи не повертається.

| Запит (усе `alerts:manage`; мутації — Origin + CSRF) | Успіх | Помилки |
|---|---|---|
| `GET /api/settings/alerts` | `200 {revision, updatedAt, engineEnabled, deliveryEnabled, rules, timing, advanced, ranges, slack:{state, error, generation, configuredAt, keyAvailable, lastTest}, queue, publicUrlConfigured}` | 401, 403, 503 |
| `PATCH /api/settings/alerts` `{revision, engineEnabled?, deliveryEnabled?, rules?, timing?, advanced?}` | `200` — новий стан | 400, 409 (застаріла `revision` / доставка без інтеграції), 429, 503 |
| `PUT /api/settings/integrations/slack` `{generation, webhookUrl}` | `200` (webhook зашифровано, не повертається; стара черга скасована) | 400 (не Slack webhook), 409 (`generation` / немає ключа), 429, 503 |
| `DELETE /api/settings/integrations/slack` `{generation}` | `200` (доставку вимкнено, черга скасована) | 409, 429, 503 |
| `POST /api/settings/integrations/slack/test` `{generation}` | `200 {operationId, generation, outcome: success\|failed\|unknown, code, at, stored}` | 409 (не та `generation` / не налаштовано / помилка ключа / тест уже триває), 429, 503 |

### Dashboard (Task 012, ADR-020)

| Запит | Доступ | Успіх | Помилки |
|---|---|---|---|
| `GET /api/dashboard` | `monitoring:read` (усі ролі); read-only, без audit | `200 {generatedAt, windows, servers, inventory, processes, attentionServers, attentionProcesses, serverList, recentActions}` — точні агрегати всіх записів + обмежені списки `{items, total, limit}`; `recentActions` лише для `processes:control` (інакше `null`) | 401, 403, 503 + `Retry-After` |

Правила (неактивні сервери, «live» процеси, «потребує уваги», ліміти, метрики лише online-серверів) — ADR-020.

### Користувачі та зміна власного пароля (Task 011, ADR-019)

| Запит | Доступ | Успіх | Помилки |
|---|---|---|---|
| `POST /api/auth/change-password` `{"currentPassword","newPassword"}` | сесія + Origin + `x-csrf-token` (усі ролі) | `204`, cookie очищено, **усі** сесії користувача завершено | 400 (політика або новий = поточний), 401, 403 (Origin/CSRF), 409 (credentials змінились паралельно), 422 (невірний поточний пароль), 429 + `Retry-After` (5/15 хв), 503 + `Retry-After` |
| `GET /api/users?limit=1..100&after=<uuid>` | `users:manage` (admin) | `200 {items:[{id,email,role,isActive,createdAt,updatedAt}], nextAfter}` — `(created_at, id)`, keyset | 400, 401, 403, 503 |
| `POST /api/users` `{"email","password","role"}` | `users:manage` + Origin + CSRF | `201 {id,email,role,isActive,createdAt,updatedAt}` | 400, 401, 403, 409 email зайнятий, 429, 503 + `Retry-After` |
| `PATCH /api/users/:id` `{"role"?, "isActive"?}` (не порожнє) | `users:manage` + Origin + CSRF | `200` — той самий об'єкт; зміна відкликає всі сесії цілі, no-op нічого не пише | 400, 401 (права актора відкликано), 403 (власний обліковий запис), 404, 409 (останній активний admin), 429, 503 |

Hash, паролі й токени не повертаються ніколи. Фізичного видалення, зміни email, admin-reset пароля, листів і self-registration немає.

Frontend flow: при старті `GET /api/auth/me` (401 → сторінка login) → `POST /api/auth/login` з `credentials: 'same-origin'` → зберегти `csrfToken` **у пам'яті** (не localStorage) → кожен POST/PUT/PATCH/DELETE з `x-csrf-token`. Після reload — знову `me`.

| Роль | Дозволи |
|---|---|
| `viewer` | `monitoring:read` |
| `operator` | `monitoring:read`, `processes:control`, `logs:read` |
| `admin` | `monitoring:read`, `processes:control`, `logs:read`, `users:manage`, `servers:manage`, `audit:read`, `alerts:manage` |

Джерело — `backend/src/auth/rbac.ts`; `processes:control` і `logs:read` незалежні.

**Доступ до ресурсів (ADR-028).** Дозвіл ролі діє лише на надані ресурси: `admin` — усі сервери й сервіси, зокрема майбутні; `operator`/`viewer` — лише сервери з призначенням («Усі сервіси» сервера — поточні й майбутні, або «Вибрані сервіси» за назвою PM2-процесу). Без призначень — нічого. Фільтр застосовується в SQL до пагінації й агрегатів для всіх списків, пошуку, огляду, сповіщень, inventory, керування, логів та історії команд. `403` — брак дозволу ролі; `404` — ресурс не надано або не існує (однаково).

| Запит | Доступ | Успіх | Помилки |
|---|---|---|---|
| `GET /api/users/:id/access` | `users:manage` (admin) | `200 {userId, email, role, isActive, global, revision, servers:[{serverId, serverName, serverActive, mode:"all"\|"selected", grantedAt, services:[{name, available}]}]}` (`global` — admin) | 400, 401, 403, 404, 503 |
| `PUT /api/users/:id/access` `{"expectedRevision", "servers":[{"serverId","mode","services":[]}]}` | `users:manage` + Origin + CSRF | `200` — новий стан; набір замінюється атомарно разом з audit `access.updated` | 400 (дубль сервера, невідомий сервер/сервіс, порожній «Вибрані», сервіси з «Усі»), 401, 403, 404, 409 (ревізія змінилась або ціль — admin), 429, 503 |
| `GET /api/access/servers?q=&limit=1..100&afterName=` | `users:manage` | `200 {items:[{id, name, isActive}], nextAfterName}` | 400, 401, 403, 503 |
| `GET /api/access/servers/:id/services?q=` | `users:manage` | `200 {serverId, items:[{name, processes}], truncated}` (≤ 500) | 400, 401, 403, 404, 503 |

Конфігурація: `AUTH_ALLOWED_ORIGINS` (точні origin через кому; порожньо → login вимкнено), `AUTH_COOKIE_SECURE` (default `true`; `false` лише для loopback-розробки), `AUTH_SESSION_TTL_MINUTES` (15–1440, default 480). Rate limits: 5 спроб / 15 хв на акаунт, 30 / 15 хв на адресу клієнта (`request.ip`; за Nginx — адреса, яку proxy записав у `X-Forwarded-For`, лише якщо peer входить до `API_TRUSTED_PROXIES`); лише в пам'яті одного процесу.

Перший адміністратор — лише CLI (DEPLOYMENT, «Bootstrap адміністратора»): `ENV_FILE=… node backend/dist/bootstrap-admin.js --email <email>` (пароль вводиться приховано двічі).

### Помилки (контракт відповіді)

Текст кинутої помилки (`message`, `name`, `cause`, `stack`) ніколи не повертається клієнту — навіть за `statusCode` 4xx.

| Випадок | Відповідь |
|---|---|
| Schema validation | `400 {"statusCode":400,"error":"Bad Request","message":"Request validation failed","validation":[{"location":"body","path":"/name","rule":"required"}]}` — `path`/`rule` зі схеми, без отриманих значень, до 10 пунктів |
| Інша помилка з 4xx `statusCode` (у т.ч. malformed JSON, 413, 415) | той самий статус; `error` = `message` = стандартний HTTP-текст (`Bad Request`, `Unsupported Media Type`, нестандартний → `Client Error`) |
| Будь-що інше (5xx, без статусу, не-`Error`) | `500 {"statusCode":500,"error":"Internal Server Error","message":"Internal Server Error"}` |

Відоме відкладене зауваження **NC-SEC-001**: Ajv `instancePath` для динамічних ключів може містити ключ із запиту, тому твердження про шляхи лише зі схеми має це обмеження. Деталі та критерії виправлення — [PROJECT_STATUS](docs/PROJECT_STATUS.md). Чинні health endpoints такого сценарію не мають.

### Логи

Fastify/pino JSON у stdout. У запиті логуються лише `method`, `path` (без query string) і `reqId`; заголовки й тіла не логуються, а `authorization`, `cookie`, `proxy-authorization`, `x-api-key`, `set-cookie` додатково редагуються.

Помилки логуються лише як `error: { category, code?, statusCode? }` (`describeError` у `backend/src/errors.ts`): `category` — `validation | client | timeout | database | system | internal | non-error`; `code` лише з allowlist (Node errno, коди Fastify, SQLSTATE з `pg.DatabaseError`). Подія (`msg`), рівень і `reqId` зберігаються. Redaction заголовків не захищає текст помилок — тому текст не логується взагалі. Startup/shutdown та fatal (`uncaughtException`/`unhandledRejection`) виводять у stderr/лог лише ці метадані; після невдалого старту процес гарантовано завершується з кодом 1 (одразу, якщо cleanup завис; інакше через unref-таймер 2 с).

### TLS до PostgreSQL

API не вмикає TLS у `pg`: підтримується лише loopback на сервері або SSH-тунель у розробці — **це не TLS-з'єднання з PostgreSQL**, захист дає SSH або локальність. `rejectUnauthorized:false` не використовується. Пряме віддалене підключення API до БД не підтримується без окремого рішення з перевіркою сертифіката.

### Тести backend

```bash
npm run typecheck           # tsc --noEmit, strict (src + test)
npm run lint                # ESLint + typescript-eslint strictTypeChecked: backend, frontend, e2e, agent
npm run test:backend        # Vitest: config, API через inject, database, lifecycle — без мережевої БД
npm run test:backend:smoke  # збирає dist і запускає скомпільований API як процес
npm run check:local         # secrets + node:test unit + typecheck + lint + test:backend + smoke + agent + frontend + installer + збірки
```

`check:local` не запускає production-connected тести (`test:integration`, `test:backend:db`). Старий `npm run check` не змінено.

Перевірка на Node.js 22, коли локально інша версія:

```bash
npx -y node@22 node_modules/vitest/vitest.mjs run --config backend/vitest.config.ts
npm run backend:build && BACKEND_TEST_SUITE=smoke npx -y node@22 node_modules/vitest/vitest.mjs run --config backend/vitest.config.ts
```

### Ізольована тестова PostgreSQL (DDL/DML-тести)

Тести із записом працюють **лише** з окремою БД `node_control_test_db` і роллю `node_control_test_user` на тому ж кластері (створює `scripts/setup-test-db.js`, Task 004). Роль: `LOGIN`, без SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS, без членства в інших ролях, без `CONNECT` до `node_control_db`; `PUBLIC` не має доступу до тестової БД. Обидва ресурси позначені `COMMENT` — однойменні чужі ресурси скрипт не перевикористовує.

Конфігурація — тільки `TEST_DB_HOST/PORT/NAME/USER/PASS` або файл, явно вказаний у `TEST_DB_ENV_FILE`; жодного fallback до `DB_*` чи `.env`. Guard (`backend/test/support/test-db.ts`) відхиляє production-імена, вимагає токен `test` в імені БД і ролі, перед DDL перевіряє `current_database()`/`current_user`. Кожен запуск працює у власній схемі `nc_test_<ms>_<hex8>` і видаляє лише її.

Credentials: на сервері `/root/.config/node-control/test-db.env` (`600 root`, каталог `700`), локально — копія `.env.test` (`600`, ігнорується Git). Не копіювати в `api.env`.

```bash
# локально: отримати credentials і відкрити тунель (окремий термінал)
(umask 077 && scp root@203.0.113.10:/root/.config/node-control/test-db.env .env.test) && chmod 600 .env.test
ssh -N -L 15432:127.0.0.1:5432 root@203.0.113.10

TEST_DB_ENV_FILE=.env.test TEST_DB_PORT=15432 npm run test:backend:db   # міграції + readiness, реальна PostgreSQL
```

Створення/перевірка тестових ресурсів (root на сервері, повторюваний, без тихої ротації): `node scripts/setup-test-db.js [--rotate-password]`.

### Міграції

`node-pg-migrate` 9.0.0, SQL-файли в `backend/migrations/` (`<13 цифр>_<name>.sql`, лише `-- Up Migration`). Tracking — таблиця `pgmigrations` у схемі `public`. `up` бере advisory lock (чекає не довше `lock_timeout` 10 с), застосовує всі pending в **одній транзакції** (помилка → `ROLLBACK`, без часткових об'єктів і записів tracking); `statement_timeout` 60 с. API міграції **не** запускає.

```bash
npm run backend:build
ENV_FILE=<config> npm run db:migrate:status    # read-only: applied / pending / unknown
ENV_FILE=<config> npm run db:migrate:up        # явне застосування
```

Немає `down`/`reset` у CLI: production-міграції лише вперед; відновлення — з backup (docs/DEPLOYMENT.md). Міграції — `backend/migrations/` (`1791900000000`…`1791900000008`: користувачі, auth, реєстр серверів, PM2 inventory, керування процесами, версія credentials, сповіщення, налаштування сповіщень, виведення `server_memory`).

### Сервери та Agent (Task 007, ADR-015)

| Запит | Доступ | Успіх | Помилки |
|---|---|---|---|
| `GET /api/servers?limit=1..100&afterId=<uuid>` | `monitoring:read` | `200 {items:[ServerSummary], nextAfterId, onlineWindowSeconds}` (keyset за `created_at, id`) | 400, 401, 403, 503 |
| `GET /api/servers/:id` | `monitoring:read` | `200 ServerDetail` = ServerSummary + `snapshot` (або `null`) | 400, 401, 403, 404, 503 |
| `POST /api/servers` `{"name"}` | `servers:manage` + Origin + CSRF | `201 ServerSummary` (`never_connected`) | 400, 401, 403, 409 (назва зайнята), 503 |
| `POST /api/servers/:id/agent-credentials` | `servers:manage` + Origin + CSRF | `201 {serverId, token, issuedAt, rotated}` — **токен лише тут, один раз** | 401, 403, 404, 409 (неактивний), 503 |
| `POST /api/servers/:id/agent-credentials/revoke` | `servers:manage` + Origin + CSRF | `200 {serverId, revoked}` | 401, 403, 404, 503 |
| `POST /api/agent/heartbeat` (snapshot) | **machine**: `Authorization: Bearer ncag_…` | `200 {status:"accepted", receivedAt (ISO-8601 UTC), intervalSeconds (ціле 5–300)}`; Agent вважає успіхом лише повністю прочитану валідну відповідь (ADR-015) | 400 (snapshot), 401, 403 (браузерний контекст), 413, 429, 503 |

`ServerSummary = {id, name, isActive, createdAt, status: online|offline|never_connected, lastSeenAt, hasActiveCredential}`. `online` — останній прийнятий heartbeat за **серверним** годинником новіший за 90 с. Snapshot (ADR-023): `agentVersion, hostname, platform, arch, loadAverage[3]` (довжина черги, не % CPU) — більше нічого; системні метрики (пам'ять, uptime ОС, ядра) не збираються — це Zabbix. Legacy-поля Agent ≤ 0.4.x приймаються в перехідний період, але не зберігаються.

Agent (`agent/`): `ENV_FILE` (600, власник — користувач агента) з `NC_AGENT_API_URL=https://…` (лише origin; HTTP — тільки `NC_AGENT_ALLOW_INSECURE_LOOPBACK=true` на loopback для dev/E2E), `NC_AGENT_TOKEN`, опційно `NC_AGENT_INTERVAL_SECONDS` (5–300), `NC_AGENT_TIMEOUT_SECONDS` (1–60), `NC_AGENT_MAX_BACKOFF_SECONDS` (30–3600). Без inbound-порту, без команд, без DB credentials.

```bash
npm run agent:build && npm run test:agent
npm run test:agent:pm2   # opt-in: справжній одноразовий PM2 у тимчасовому PM2_HOME (pm2@7.0.4 через npx)
```

### PM2 inventory (Task 008, ADR-016) — дані процесів

| Запит | Доступ | Успіх | Помилки |
|---|---|---|---|
| `GET /api/applications?limit=1..100&cursor=&serverId=&status=&q=` | `monitoring:read` | `200 {items:[ApplicationItem], nextCursor, freshWindowSeconds}` (keyset за `name, server_id, pm_id`); `q` — підрядок назви без урахування регістру, літеральний (ADR-026); cursor прив'язаний до фільтрів | 400 (у т.ч. cursor іншого списку, `q` > 128 символів), 401, 403, 503 |
| `GET /api/servers/:id/applications` | `monitoring:read` | `200 {serverId, serverStatus, inventory:{state, reason, source, capturedAt, collectedAt, reportedAt, processCount}, items, freshWindowSeconds}` | 400, 401, 403, 404, 503 |
| `POST /api/agent/inventory` | **machine** (Bearer) | `200 {status:"accepted"\|"ignored", receivedAt, intervalSeconds (30–600)}` | 400, 401, 403, 413, 429, 503 |

`ApplicationItem = {key, serverId, serverName, serverStatus, source, pmId, name, status, uptimeSeconds, restarts, cpuPercent, memoryBytes, execMode, firstSeenAt, inventoryState: current|stale|unavailable, capturedAt, collectedAt}`. `null` — метрика невідома (не 0). Звіт Agent: `{version:1, state:"ok"|"stale"|"unavailable", reason, source, capturedAt, processes}`; зайві поля → 400 (strict schemas на всіх `/api`). Inventory сам нічого не змінює; керування — окремий контракт нижче (ADR-017).

Exporter (`agent/dist/pm2-exporter.js`, від власника PM2): `NC_PM2_HOME` (абсолютний), `NC_PM2_SNAPSHOT_FILE` (поза `PM2_HOME`), `NC_PM2_SOURCE` (типово `pm2`), `NC_PM2_TIMEOUT_SECONDS` (1–60), `NC_PM2_MAX_PROCESSES` (≤500). Agent: `NC_AGENT_INVENTORY_FILE` (вмикає inventory), `NC_AGENT_INVENTORY_INTERVAL_SECONDS` (30–600, типово 60), `NC_AGENT_INVENTORY_MAX_AGE_SECONDS` (30–3600, типово 120).

### Перегляд логів сервісів (Task 010, ADR-018) — лише явно дозволені сервіси

| Запит | Доступ | Успіх | Помилки |
|---|---|---|---|
| `GET /api/servers/:id/log-targets` | `logs:read` (admin, operator) | `200 {serverId, state: supported\|not_connected\|unsupported\|broker_unavailable, reportedAt, targets:[{targetKey, name, pmId, matchStatus}]}` — лише надані сервіси; для operator/viewer зі старим Agent/broker (протокол v1) — `unsupported` | 400, 401, 403, 404 |
| `POST /api/servers/:id/log-requests` `{"targetKey","lines"?: 1..100}` | `logs:read` + Origin + CSRF | `202 {requestId, deadlineAt}` | 400, 401, 403, 404, 409 (не підтримується/не на зв'язку/не дозволено), 429, 503 |
| `GET /api/log-requests/:id` | `logs:read`, лише ініціатор | `200 {requestId, serverId, targetKey, status: pending\|done\|expired, deadlineAt, result:{outcome, reason, readAt, stdout, stderr}\|null}` (чекає ≤ 8 с). Після очікування й для готового результату сесія, активність, роль і призначення перевіряються заново: `401` (сесія/деактивація), `403` (немає `logs:read`), `404` (не надано); текст лише за чинного доступу. `reason` може бути `target_changed`/`identity_changed`/`not_authorized` — запит не виконано | 400, 401, 403, 404 |
| `POST /api/agent/logs/poll` / `POST /api/agent/logs/result` | **machine** | long-poll ≤ 25 с → `{requests:[≤4 {requestId, targetKey, lines, deadlineAt, name?, identity?}], accessModel?}` / `{status:"recorded"}`; v2: цілі з `identity`, кожен запит несе очікувані `name`/`identity` для перевірки broker; запит передається лише за чинних прав автора й незмінної цілі | 400, 401, 403, 404, 409, 413, 429 |

`stdout`/`stderr`: `{state: ok|empty|missing|unavailable|merged, text, lines, truncated, sizeBytes, modifiedAt}` — без шляхів і env. Дозвіл на ноді: `"logs": true` у записі allowlist broker (окремо від `actions`); `processes:control` не дає читання логів. Текст не зберігається.

### Керування PM2-процесами (Task 009, ADR-017/028)

| Запит | Доступ | Успіх | Помилки |
|---|---|---|---|
| `GET /api/servers/:id/control` | `monitoring:read` | `200 {serverId, enabled, serverStatus, broker:{state, daemon, allowlist, reportedAt, fresh, mode, protocol, total}\|null, targets:[{targetKey, name, pmId, actions, matchStatus}], targetFreshSeconds}` — цілі лише наданих сервісів; `total` (усі процеси власника) — лише admin і «Усі сервіси», інакше `null` | 400, 401, 403, 404, 503 |
| `POST /api/servers/:id/control-commands` `{"targetKey","action":"start"\|"stop"\|"restart","idempotencyKey":"<uuid>"}` | `processes:control` (operator/admin) + Origin + CSRF | `201 CommandView` (нова) / `200 CommandView` (повтор з тим самим ключем) | 400, 401, 403, 404, 409 (вимкнено, сервер офлайн, ціль недоступна, дія не дозволена, команда вже виконується, конфлікт ключа), 503 |
| `GET /api/servers/:id/control-commands?limit=1..50&targetKey=` | `monitoring:read` | `200 {items:[CommandView]}`; `targetKey` — лише команди цієї цілі allowlist (фільтр до limit, ADR-026) | 400, 401, 403, 404, 503 |
| `GET /api/control-commands/:id` | `monitoring:read` | `200 CommandView` | 400, 401, 403, 404, 503 |
| `POST /api/agent/control/poll` `{version:1, broker, daemon, allowlist, targets(≤50)}` або `{version:2, mode, broker, daemon, allowlist, targets(≤500, + identity), total}` | **machine** | `200 {controlEnabled, commands:[≤1 {id, attempt, targetKey, action, deadlineAt, identity?}], intervalSeconds, accessModel?}` (`accessModel:"scoped"` — лише v2) | 400, 401, 403, 413, 429, 503 |
| `POST /api/agent/control/result` `{version:1, commandId, attempt, outcome, reason, before, after}` | **machine** | `200 {status:"recorded"\|"duplicate"}` | 400, 401, 403, 404, 409, 413, 429, 503 |

`CommandView = {id, serverId, targetKey, serviceName, action, status: queued|dispatched|succeeded|failed|rejected|expired|unknown, reason, requestedBy, requestedAt, deadlineAt, dispatchedAt, completedAt, attempts, before:{status}|null, after:{status}|null}`. `succeeded` — лише після підтвердженого broker результату; `unknown` — дія могла виконатися. `PM2_CONTROL_ENABLED` типово `true` (`false` — аварійне вимкнення); на ноді — `NC_AGENT_CONTROL_SOCKET` (Agent) і broker: `auto` (усі процеси власника PM2, доступ — за ролями й «Доступами») або `allowlist` (root-owned список) — див. INSTALLATION/DEPLOYMENT. Сумісність версій API/Agent/broker — fail closed (ADR-028).

```bash
npm run test:agent:pm2   # opt-in: exporter + broker проти справжнього одноразового PM2
npm run test:e2e:pm2     # opt-in: UI → API → Agent → broker → одноразовий PM2 (окремий прогін)
```

### Production (сервер)

Central API — systemd `node-control-api.service` під `nodecontrol` на `127.0.0.1:3100`; UI — статика з того самого релізу. Публічна адреса — **https://control.example.com** (host Nginx + Let's Encrypt, `/api/` → API). `AUTH_ALLOWED_ORIGINS=https://control.example.com`, cookie `Secure`. `API_TRUSTED_PROXIES=127.0.0.1`. Перший адміністратор — лише CLI (bootstrap); подальших користувачів створює admin у розділі «Користувачі» (Task 011). Agent першої ноди — `node-control-agent.service` (DEPLOYMENT). Процедура деплою й rollback — [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md); фактичний стан і release blockers — [PROJECT_STATUS](docs/PROJECT_STATUS.md).

## Тести та перевірки

```bash
npm test                  # unit: логіка скриптів, без БД
npm run test:integration  # реальна БД з .env: доступ, права, SCRAM, pg_hba, стан сервісу
npm run check             # check:secrets + unit + integration
npm run db:check          # SELECT 1 через .env, без виводу пароля
```

`npm run test:integration` (node:test) читає production `.env` і з Task 004 лише читає: перевірки прав #9/#10 виконуються через каталоги PostgreSQL, без DDL/DML. Серверні перевірки (`pg_authid`, `pg_hba.conf`, systemd) потребують root на хості PostgreSQL; локально пропускаються. Тести із записом — тільки `npm run test:backend:db` проти ізольованої тестової БД.

## Frontend (React + Vite)

`frontend/` — React 19 + React Router 8 + Vite 8, TypeScript strict (ADR-012). Інтерфейс українською: вхід, Огляд, Сервери (дані heartbeat, сервіси сервера з діями, ключі агента для admin), Застосунки (PM2-процеси всіх серверів: пошук за назвою, фільтри, пагінація; без вибору — лише список на всю ширину; вибір відкриває деталі процесу — поруч від 1280 px, окремим видом на вужчих екранах: огляд, логи, історія команд; дії за правами; «Закрити деталі» / «← До списку застосунків» очищує вибір), Сповіщення (ADR-031: вкладки «Активні проблеми» / «Історія» зі сторінками по 25; пошук і фільтри — лише в межах поточної сторінки; деталі проблеми — у бічній панелі-діалозі тільки з даних списку; доставка видима лише адміністратору), Користувачі (`users:manage`; «Доступи» — сервери й сервіси operator/viewer), Журнал аудиту (`audit:read`, лише admin; ADR-032: порції по 25 від нових записів журналу, «Показати старіші», пошук і фільтри лише серед завантажених подій, деталі події в бічній панелі-діалозі), Налаштування (`alerts:manage`), Обліковий запис (зміна пароля), вихід. Стани loading / empty / error / forbidden / unavailable; адаптивний layout (sidebar на desktop, меню на мобільних), skip-link, видимий фокус. Тема оформлення — «Світла», «Темна» або «Як у системі» (типово): перемикач «Тема оформлення» в профілі навігації (у компактній рейці — піктограма ◐), у мобільному меню й на сторінці входу; вибір зберігається лише в цьому браузері (не в обліковому записі) і застосовується до першого показу сторінки.

- **API-клієнт** (`frontend/src/api/`): лише відносні `/api`, `credentials: 'same-origin'`, timeout 10 с і скасування, без автоматичних повторів, runtime-валідація відповідей, `Retry-After` для 429/503; повідомлення формує UI, текст сервера не показується.
- **Сесія** (`frontend/src/auth/`): стан лише в пам'яті React — без localStorage/sessionStorage/URL; cookie керує браузер (HttpOnly); `csrfToken` з `login`/`me` у пам'яті; пароль очищається після запиту. «Епохи» сесії: відповідь `me`/`login`, що прийшла після logout/expiry, ігнорується. 401 від будь-якого запиту → приватні дані скидаються.
- **Права в UI** — лише UX (приховування розділів, перевірка прямого URL); авторизацію виконує backend.
- **Дії з процесами** (сторінка сервера й «Застосунки», ADR-017/018/024): меню «Дії» рядка — «Запустити», «Зупинити», «Перезапустити» (`processes:control`) і «Переглянути логи» (`logs:read`), лише для цілі, яку broker підтвердив для того самого імені й PM2 id, коли керування увімкнене, broker свіжий, allowlist валідний, inventory актуальний. Кожна дія — після підтвердження з назвою застосунку, сервера й операції; один POST з CSRF та idempotency key, без автоматичного повтору; статус відстежується до фінального («прийнято» ≠ «виконано», `unknown` — результат невідомий). Причина, спільна для сервера (керування вимкнено аварійним вимикачем, broker недоступний чи застарів, логи не підтримуються Agent), показується один раз над таблицею; причина конкретного процесу — у меню його рядка («Дії» з неактивними пунктами або компактне «Недоступно»), без пояснень у кожному рядку; viewer таких пояснень не бачить. Одночасно відстежується до 5 незавершених команд: поки їх 5, нова команда не надсилається (пункти меню недоступні з поясненням); прийнята команда ніколи не витісняється новою; список завершених обмежено 5 останніми. У «Застосунках» можливості сервера завантажуються лише при відкритті меню (без polling на рядок) і перевіряються ще раз перед POST. Там же назва рядка розгортає панель (одна за раз): «Огляд» (дані рядка), «Логи» (той самий обмежений перегляд, вбудований), «Історія дій» (команди підтвердженої цілі allowlist на цьому сервері, до 10); пошук за назвою — по всіх застосунках на сервері API (ADR-026).

```bash
npm run frontend:dev        # Vite на 127.0.0.1:5173, /api → 127.0.0.1:3100 (той самий origin)
npm run frontend:build      # статична збірка frontend/dist (без source maps)
npm run test:frontend       # Vitest + jsdom: API-клієнт, auth-гонки, маршрути, audit, XSS
npm run test:e2e            # Playwright: реальний backend + збірка UI, лише тестова БД (див. нижче)
```

## Робота через VS Code (локальна розробка)

Розробка — у локальному checkout. **Записи лише в ізольовану тестову БД**; production `.env` для розробки не використовувати.

```bash
# 1. Тунель до тестової БД (окремий термінал) і credentials тестової ролі
ssh -N -L 15432:127.0.0.1:5432 root@203.0.113.10
(umask 077 && scp root@203.0.113.10:/root/.config/node-control/test-db.env .env.test) && chmod 600 .env.test

# 2. .env.dev (600, ігнорується Git): DB_* = значення TEST_DB_* з .env.test (DB_PORT=15432), плюс
#    NODE_ENV=development, AUTH_COOKIE_SECURE=false, AUTH_ALLOWED_ORIGINS=http://127.0.0.1:5173
npm run backend:build && ENV_FILE=.env.dev npm run db:migrate:up          # схема public тестової БД
ENV_FILE=.env.dev node backend/dist/bootstrap-admin.js --email dev@example.test

# 3. Backend + UI (два термінали), відкрити http://127.0.0.1:5173 (саме 127.0.0.1, не localhost — інший origin)
ENV_FILE=.env.dev npm run backend:dev
npm run frontend:dev
```

E2E (`npm run test:e2e`) сам створює per-run схему `nc_test_<ms>_<hex8>` у тестовій БД, застосовує міграції, створює admin/operator/viewer із випадковими паролями (лише в пам'яті процесу), запускає скомпільований backend (`127.0.0.1:41300`) і `vite preview` збірки (`127.0.0.1:41730`) та після прогону видаляє лише свою схему. Потрібні `TEST_DB_ENV_FILE=.env.test TEST_DB_PORT=15432` і `npx playwright install chromium`. Traces/screenshots/video вимкнені; `test-results/` ігнорується Git і видаляється після прогону.

Production-деплой — лише артефактом із запушеного commit (docs/DEPLOYMENT.md). Історичний rsync у `/etc/pm2-dashboard` (Task 001/002) **більше не використовується**.

Не зберігайте паролі у `.vscode/settings.json` чи конфігурації розширень (файл ігнорується Git).

## Відомі обмеження

- Node-клієнт `pg` у цьому коді не задає `ssl`: API підключається до PostgreSQL лише по loopback. SCRAM не доводить використання TLS.
- Мережевий доступ до PostgreSQL обмежується на рівні хоста/firewall; 5432 не відкривати назовні.
- API працює під системним користувачем `nodecontrol` з конфігом `/etc/node-control/api.env` (`600 nodecontrol`); історичний `/etc/pm2-dashboard/.env` (`root`) сервісом не використовується.
- Парсер `pg_hba.conf` не підтримує значення в лапках із пробілами (у перевірених конфігураціях таких немає).

## Наступні етапи

1. Узгоджений roadmap: спрощення серверного моніторингу (виконано, ADR-023) → виправлення діалогів frontend → незалежний review Slack/alerts → документація й інсталятори → фінальна production-підготовка. Історія серверних метрик виключена (системний моніторинг — Zabbix); історія метрик застосунків не погоджена. Jenkins redeploy — далекий backlog.
2. Перед публічним запуском — release blockers (PROJECT_STATUS): мережева політика PostgreSQL, NC-SEC-001, рішення щодо публічного HTTPS-сайту та `AUTH_ALLOWED_ORIGINS`, bootstrap адміністратора.
3. Довірений TLS-сертифікат для PostgreSQL і звуження мережевої політики.

Контейнеризація API/Agents — окрема фаза після стабілізації MVP за новим завданням. Зараз Docker-файли, залежності та контейнери не створювати. PostgreSQL/Nginx залишаються на хості.
