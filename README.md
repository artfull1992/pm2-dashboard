# GOIT Node Control

Централізована платформа для моніторингу та керування Node.js-проєктами на декількох серверах.

> Етап 1 (Task 001): підготовка сервера та PostgreSQL. Етап 2 (Task 002): базовий Central API — лише health endpoints, без authentication, схеми БД і production-деплою. Frontend і агент ще не реалізовані.

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
├── frontend/         # майбутній UI
├── deploy/systemd/   # node-control-api.service (systemd unit)
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

Мінімальна основа API: TypeScript (strict) + Fastify 5, PostgreSQL pool, health endpoints, структуровані логи, обробка помилок і graceful shutdown. **Authentication, RBAC, схема БД/міграції, CRUD, Agent, WebSocket і production-деплой не реалізовані.** Адміністративних endpoints немає.

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

Порт 3100 обрано як непривілейований і вільний на машині розробника (перевірено `lsof` перед запуском); на сервері порт ще не узгоджено.

### Health endpoints (публічні навмисно, без authentication)

| Запит | Відповідь |
|---|---|
| `GET /health/live` | `200 {"status":"ok"}` — не звертається до БД |
| `GET /health/ready` | `200 {"status":"ready"}` після `SELECT 1`; `503 {"status":"unavailable"}` при помилці або таймауті |
| інший маршрут/метод | `404 {"statusCode":404,"error":"Not Found","message":"Route not found"}` |

Обидва health-маршрути повертають `Cache-Control: no-store`; кожна відповідь — `x-request-id` (UUID, що генерує сервер; клієнтський заголовок ігнорується). Причина 503 пишеться лише в лог як метадані (`category` + `code` з allowlist). Недоступна БД не зупиняє процес. CORS не вмикається.

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

Немає `down`/`reset` у CLI: production-міграції лише вперед; відновлення — з backup (docs/DEPLOYMENT.md). Перша міграція `1791900000000_create-users` створює таблицю `users` (контракт — ADR-010). **Authentication ще не реалізована**: немає хешування, створення адміністратора, сесій чи endpoints.

### Production (сервер)

Central API працює на `control-server` як systemd-сервіс (з Task 003) `node-control-api.service` під користувачем `nodecontrol`, лише на `127.0.0.1:3100`; конфіг — `/etc/goit-node-control/api.env`, релізи — `/opt/goit-node-control/releases/<sha>`. Публічного доступу немає (Nginx — наступний етап). Фактичний стан деплою — [PROJECT_STATUS](docs/PROJECT_STATUS.md). Процедура збирання, передачі, активації та rollback — [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#central-api-deployment-contract-task-003). Доступ з VS Code / локальної машини:

```bash
ssh -N -L 3100:127.0.0.1:3100 root@203.0.113.10
curl -s http://127.0.0.1:3100/health/live
```

## Тести та перевірки

```bash
npm test                  # unit: логіка скриптів, без БД
npm run test:integration  # реальна БД з .env: доступ, права, SCRAM, pg_hba, стан сервісу
npm run check             # check:secrets + unit + integration
npm run db:check          # SELECT 1 через .env, без виводу пароля
```

`npm run test:integration` (node:test) читає production `.env` і з Task 004 лише читає: перевірки прав #9/#10 виконуються через каталоги PostgreSQL, без DDL/DML. Серверні перевірки (`pg_authid`, `pg_hba.conf`, systemd) потребують root на хості PostgreSQL; локально пропускаються. Тести із записом — тільки `npm run test:backend:db` проти ізольованої тестової БД.

## Робота через VS Code

Проєкт розробляється в локальному checkout. За історичним звітом сервер не мав доступу до GitHub; поточний доступ не перевірено. Наявний workflow перенесення коду наведено нижче; перед `--delete` обов'язково перевірити dry-run, backup і scope. Поточна інтеграція AI-контексту не включає деплой:

```bash
# деплой коду (без .env, node_modules, .git)
# --include має стояти ДО --exclude '.env.*' (rsync застосовує перше правило, що збіглося)
rsync -az --delete --no-owner --no-group --include .env.example \
  --exclude .git --exclude node_modules --exclude backend/dist --exclude '.env' --exclude '.env.*' \
  ./ root@203.0.113.10:/etc/pm2-dashboard/
ssh root@203.0.113.10 'cd /etc/pm2-dashboard && npm ci && npm run backend:build'
# Повний npm run check — лише у виділеному тестовому середовищі, не проти production-даних.
```

Отримати `.env` локально — лише через SSH, ніколи через Git чи месенджери:

```bash
(umask 077 && scp root@203.0.113.10:/etc/pm2-dashboard/.env .env) && chmod 600 .env
```

Локальне підключення до БД — через SSH-тунель (порт 5432 ззовні закритий, і так має лишатися):

```bash
ssh -N -L 5432:127.0.0.1:5432 root@203.0.113.10
npm run db:check
```

Не зберігайте паролі у `.vscode/settings.json` чи конфігурації розширень (файл ігнорується Git).

## Відомі обмеження

- TLS PostgreSQL — self-signed сертифікат: віддалені клієнти можуть використовувати `sslmode=require`, але не `verify-full`.
- Це параметри з історичного серверного аудиту; поточний стан потребує повторної перевірки. Node-клієнт `pg` у цьому коді не задає `ssl`, а SCRAM не доводить використання TLS.
- Віддалений доступ (`hostssl ... 0.0.0.0/0`) підготовлено, але **не активовано**: 5432 ззовні фільтрується (ймовірно, firewall провайдера); host firewall — див. приватні нотатки. Відкривати порт — лише окремим рішенням і бажано для конкретних IP.
- `.env` на сервері належить `root`, бо окремого користувача сервісу ще немає.
- Парсер `pg_hba.conf` не підтримує значення в лапках із пробілами (на сервері таких немає).

## Наступні етапи

1. Окремий системний користувач для backend + systemd unit; перевласнити `.env`.
2. Authentication/RBAC + Audit Log, схема БД і версійні міграції (базовий API з health endpoints реалізовано в Task 002).
3. Агент для збору стану Node.js/PM2-процесів на серверах.
4. Frontend, Nginx reverse proxy з TLS.
5. Довірений TLS-сертифікат для PostgreSQL і звуження мережевої політики. Зовнішній доступ до 5432 не відкривати без окремого підтвердження.

Контейнеризація API/Agents — окрема фаза після стабілізації MVP за новим завданням. Зараз Docker-файли, залежності та контейнери не створювати. PostgreSQL/Nginx залишаються на хості.
