# GOIT Node Control

Централізована платформа для моніторингу та керування Node.js-проєктами на декількох серверах.

> Task 001 — сервер і PostgreSQL; Task 002/003 — Central API + деплой через systemd; Task 004 — тестова БД і міграції; Task 005 — authentication, RBAC, audit log; Task 006 — React/Vite frontend. Agent і API серверів/процесів ще не реалізовані; публічний production-запуск не погоджено.

Task 001 підтверджений файлами та локальними unit-тестами, але серверний стан незалежно не підтверджено. Актуальні результати й проблеми — [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md).

## Постійний контекст розробки

- [AGENTS.md](AGENTS.md) — головні інструкції Codex та Claude.
- [Архітектура](docs/ARCHITECTURE.md) — фактичні компоненти й ціль MVP1.
- [Стан проєкту](docs/PROJECT_STATUS.md) — перевірки, проблеми та наступний етап.
- [Рішення](docs/DECISIONS.md), [правила розробки](docs/DEVELOPMENT_RULES.md), [AI workflow](docs/AI_WORKFLOW.md).
- [Деплой і rollback](docs/DEPLOYMENT.md) — наявний процес та ще не визначені параметри.

## Архітектурні принципи

1. На поточному етапі без Docker / Docker Compose — PostgreSQL і Nginx працюють безпосередньо на хості.
2. Central API та Agent — systemd, незалежно від PM2; frontend — статична React/Vite-збірка через Nginx, без окремого Node.js-процесу. Новий код — TypeScript.
3. Setup розрахований на повторний запуск; production-готовність потребує перевірки середовища та сценаріїв помилок.
4. Перед змінами — аудит ([docs/server-audit.md](docs/server-audit.md)), після змін — перевірка працездатності.
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
├── agent/            # майбутній агент на керованих серверах
├── backend/          # Central API: TypeScript + Fastify (src/, test/, dist/ — збірка, не в Git)
│   └── migrations/   # версійні SQL-міграції (node-pg-migrate)
├── frontend/         # React + Vite UI (src/, test/, dist/ — збірка, не в Git)
├── e2e/              # Playwright E2E (реальний backend + UI, тестова БД)
├── deploy/           # systemd/ (unit)
├── docs/
│   └── server-audit.md
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
├── eslint.config.js  # lint лише для backend/
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

- На сервері: `/etc/pm2-dashboard/.env`, створюється `npm run db:setup`, права `600`, власник — користувач, від якого працює застосунок.
- `.env` і `.env.*` ігноруються Git (крім `.env.example`); `npm run check:secrets` це перевіряє і шукає реальний пароль у всіх файлах, що можуть потрапити в коміт.

## Central API (backend)

TypeScript (strict) + Fastify 5, PostgreSQL pool, health endpoints, authentication із серверними сесіями, CSRF, RBAC, audit log, структуровані логи, обробка помилок, graceful shutdown. **CRUD користувачів, Agent, process/server endpoints, WebSocket, frontend не реалізовані.**

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
| `GET /api/audit?limit=1..100&beforeId=<id>` | `audit:read` (admin) | `200 {items:[{id,occurredAt,event,outcome,actorUserId,requestId,details}], nextBeforeId}` — `id DESC`, keyset | 400, 401, 403 `Insufficient permissions`, 503 |

Frontend flow: при старті `GET /api/auth/me` (401 → сторінка login) → `POST /api/auth/login` з `credentials: 'same-origin'` → зберегти `csrfToken` **у пам'яті** (не localStorage) → кожен POST/PUT/PATCH/DELETE з `x-csrf-token`. Після reload — знову `me`.

| Роль | Дозволи |
|---|---|
| `viewer` | `monitoring:read` |
| `operator` | `monitoring:read`, `processes:control` |
| `admin` | `monitoring:read`, `processes:control`, `users:manage`, `audit:read` |

Конфігурація: `AUTH_ALLOWED_ORIGINS` (точні origin через кому; порожньо → login вимкнено), `AUTH_COOKIE_SECURE` (default `true`; `false` лише для loopback-розробки), `AUTH_SESSION_TTL_MINUTES` (15–1440, default 480). Rate limits: 5 спроб / 15 хв на акаунт, 30 / 15 хв на адресу; лише в пам'яті одного процесу.

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
npm run lint                # ESLint + typescript-eslint strictTypeChecked, лише backend/
npm run test:backend        # Vitest: config, API через inject, database, lifecycle — без мережевої БД
npm run test:backend:smoke  # збирає dist і запускає скомпільований API як процес
npm run check:local         # secrets + node:test unit + typecheck + lint + test:backend + smoke
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

Credentials: на сервері `/root/.config/goit-node-control/test-db.env` (`600 root`, каталог `700`), локально — копія `.env.test` (`600`, ігнорується Git). Не копіювати в `api.env`.

```bash
# локально: отримати credentials і відкрити тунель (окремий термінал)
(umask 077 && scp root@203.0.113.10:/root/.config/goit-node-control/test-db.env .env.test) && chmod 600 .env.test
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

Немає `down`/`reset` у CLI: production-міграції лише вперед; відновлення — з backup (docs/DEPLOYMENT.md). Міграції: `1791900000000_create-users` (ADR-010), `1791900000001_auth-foundation` (ADR-011).

### Production (сервер)

Central API — systemd `node-control-api.service` під `nodecontrol` на `127.0.0.1:3100`; UI — статика з того самого релізу. Публічна адреса — **https://control.example.com** (host Nginx + Let's Encrypt, `/api/` → API). `AUTH_ALLOWED_ORIGINS=https://control.example.com`, cookie `Secure`. Адміністратора створює оператор через CLI (DEPLOYMENT). Процедура деплою й rollback — [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md); фактичний стан і release blockers — [PROJECT_STATUS](docs/PROJECT_STATUS.md).

## Тести та перевірки

```bash
npm test                  # unit: логіка скриптів, без БД
npm run test:integration  # реальна БД з .env: доступ, права, SCRAM, pg_hba, стан сервісу
npm run check             # check:secrets + unit + integration
npm run db:check          # SELECT 1 через .env, без виводу пароля
```

`npm run test:integration` (node:test) читає production `.env` і з Task 004 лише читає: перевірки прав #9/#10 виконуються через каталоги PostgreSQL, без DDL/DML. Серверні перевірки (`pg_authid`, `pg_hba.conf`, systemd) потребують root на хості PostgreSQL; локально пропускаються. Тести із записом — тільки `npm run test:backend:db` проти ізольованої тестової БД.

## Frontend (React + Vite)

`frontend/` — React 19 + React Router 8 + Vite 8, TypeScript strict (ADR-012). Інтерфейс українською: вхід, огляд, Сервери/Застосунки (чесні порожні стани — Agent ще не підключено), Журнал аудиту (лише `audit:read`), інформація про користувача й вихід. Стани loading / empty / error / forbidden / unavailable; адаптивний layout (sidebar на desktop, меню на мобільних), skip-link, видимий фокус.

- **API-клієнт** (`frontend/src/api/`): лише відносні `/api`, `credentials: 'same-origin'`, timeout 10 с і скасування, без автоматичних повторів, runtime-валідація відповідей, `Retry-After` для 429/503; повідомлення формує UI, текст сервера не показується.
- **Сесія** (`frontend/src/auth/`): стан лише в пам'яті React — без localStorage/sessionStorage/URL; cookie керує браузер (HttpOnly); `csrfToken` з `login`/`me` у пам'яті; пароль очищається після запиту. «Епохи» сесії: відповідь `me`/`login`, що прийшла після logout/expiry, ігнорується. 401 від будь-якого запиту → приватні дані скидаються.
- **Права в UI** — лише UX (приховування розділів, перевірка прямого URL); авторизацію виконує backend.

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
(umask 077 && scp root@203.0.113.10:/root/.config/goit-node-control/test-db.env .env.test) && chmod 600 .env.test

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

- TLS PostgreSQL — self-signed сертифікат: віддалені клієнти можуть використовувати `sslmode=require`, але не `verify-full`.
- Це параметри з історичного серверного аудиту; поточний стан потребує повторної перевірки. Node-клієнт `pg` у цьому коді не задає `ssl`, а SCRAM не доводить використання TLS.
- **Мережева політика PostgreSQL потребує обмеження** (зафіксовано з Task 004: зовнішні спроби входу, відхилені HBA); host firewall — див. приватні нотатки. Обмеження джерел у firewall провайдера відкладено користувачем до фінального етапу — **release blocker**.
- API працює під системним користувачем `nodecontrol` з конфігом `/etc/goit-node-control/api.env` (`600 nodecontrol`); історичний `/etc/pm2-dashboard/.env` (`root`) сервісом не використовується.
- Парсер `pg_hba.conf` не підтримує значення в лапках із пробілами (на сервері таких немає).

## Наступні етапи

1. Agent (Node.js, systemd) і API серверів/процесів — наступне завдання.
2. Перед публічним запуском — release blockers (PROJECT_STATUS): обмеження 5432, NC-SEC-001, рішення щодо публічного HTTPS-сайту та `AUTH_ALLOWED_ORIGINS`, bootstrap адміністратора.
3. Довірений TLS-сертифікат для PostgreSQL і звуження мережевої політики.

Контейнеризація API/Agents — окрема фаза після стабілізації MVP за новим завданням. Зараз Docker-файли, залежності та контейнери не створювати. PostgreSQL/Nginx залишаються на хості.
