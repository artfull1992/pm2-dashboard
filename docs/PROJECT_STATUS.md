# Поточний стан проєкту

Оновлено: 2026-10-12 (Task 006). Початковий commit: `ccbba13dbea512d962dbea5fbeb8bd1cd8b8a5eb` (`chore: initialize node control infrastructure`), гілка `main`, remote `origin`. Початкове робоче дерево чисте. Перевірка доступної історії охопила один commit; це не підтверджує актуальний стан remote або факт попереднього push.

## Завершено за фактичними файлами

- Каркас каталогів, npm manifest/lockfile та залежність `pg`.
- Скрипти налаштування PostgreSQL, перевірки з'єднання та секретів; допоміжна логіка env/SCRAM/SQL/HBA.
- Unit та integration suites, `.env.example`, `.gitignore`, README і серверний звіт Task 001.
- Початкова інтеграція AI-контексту: AGENTS, ARCHITECTURE, DECISIONS, DEVELOPMENT_RULES, AI_WORKFLOW та цей документ. Код функцій не змінено, деплой не виконувався.

## Task 001 — частково підтверджено

Код і commit перевірені. `docs/server-audit.md` повідомляє про створення ролі/БД, HBA reload, `.env` на сервері й успіх 46 unit + 15 integration тестів. Цей серверний результат не відтворено в поточній сесії; роль, БД, HBA, systemd, firewall і відсутність впливу на сторонні сервіси незалежно не підтверджені. Task 001 не має статусу повністю технічно підтвердженого.

## Перевірки початкової інтеграції (`c6af8eb`)

| Перевірка | Результат |
|---|---|
| Середовище | Локальний macOS, Node.js v24.14.0, npm 11.9.0; ціль Node.js 22 LTS не перевірена |
| `npm run check:secrets` | Успіх до та після документування; `.env` ігнорується та не tracked |
| Доступна Git-історія | 1 початковий commit, 0 знахідок за чинними шаблонами й поточним DB_PASS; значення не виводились |
| `npm test` | 46/46 успішно |
| `npm run check` | Невдалий: integration-з'єднання заблоковано sandbox (`EPERM`) |
| Повторний `npm run test:integration` поза sandbox | 2 успішно, 10 невдало: `ECONNRESET` / `ECONNREFUSED` на `127.0.0.1:5432` |
| Привілейовані integration checks | Suite пропущено: потрібен root на хості PostgreSQL; 3 вкладені серверні тести не виконано |
| Lint/formatter, API/E2E | Інструменти lint/format не налаштовані; API та UI ще відсутні |

Звичайні integration-тести тоді не були штучно пропущені. Повний check не успішний. Початковий push було відкладено за умовою попереднього запиту. Ці результати не є новим запуском повного suite.

## Фіналізація архітектури та workflow (2026-10-12)

Completed: повторно прочитані код, тести, документація, Git history; вихідне дерево чисте, два commits (`ccbba13`, `c6af8eb`). Оновлено AGENTS, ARCHITECTURE, DECISIONS (ADR-001–005), DEVELOPMENT_RULES, AI_WORKFLOW, README та цей статус; створено DEPLOYMENT. Функціональні файли, production-конфігурації й служби не змінені; SSH-аудит сервера не виконувався.

Зафіксовано systemd для API/Agents, PM2 лише для керованих застосунків, статичний frontend через host Nginx, TypeScript для нових компонентів, Vitest за замовчуванням зі збереженням чинного node:test; контейнеризація API/Agents — окрема майбутня фаза. PostgreSQL/Nginx залишаються на хості.

| Поточна перевірка | Результат |
|---|---|
| `npm test` | 46/46 успішно, Node.js v24.14.0 / npm 11.9.0 |
| Вибрані env integration tests (`^#11\|^#12`) | 2/2: `.env` існує, валідний, права 600, власник поточний; ignored/untracked, скан секретів успішний |
| `npm run db:check` | Sandbox: EPERM; повтор поза sandbox: ECONNREFUSED на 127.0.0.1:5432; БД не підтверджена |
| Повний integration suite | Не повторювався: має DDL/DML, тестове середовище не підтверджено; нова вимога забороняє зміну production-даних |
| Lint/typecheck | Scripts/config відсутні; функціональний код не змінювався |

Актуальний запит дозволяє документаційний push за політиками гілки після успішних релевантних перевірок із чесним описом недоступності БД; попередня заборона push через повний check для цієї документаційної задачі уточнена. Commit hash і фактичний push status повідомляються у фінальному звіті; hash самого commit не записується в його власний вміст.

## Task 002 — базовий Central API (2026-10-12)

Стартовий стан: `main` = `d1c58b3`, робоче дерево чисте. Реалізовано `backend/` (TypeScript strict + Fastify 5): валідована env-конфігурація (process env > `.env`), `pg.Pool` з обмеженнями, `GET /health/live`, `GET /health/ready`, логування з redaction і request ID, 404/500 handlers, graceful shutdown. Додано Vitest, ESLint, typecheck, build, smoke і opt-in real-DB тест. Authentication/RBAC, міграції, CRUD, Agent, WebSocket, frontend і production-деплой **не реалізовані**. `.env`, production-конфігурації, БД, HBA, firewall і служби не змінювались; `db:setup` не запускався.

| Перевірка (поточна сесія) | Результат |
|---|---|
| Середовище | macOS; системний Node.js v24.14.0; перевірки на Node.js **v22.23.3** через `npx -y node@22` |
| `npm run typecheck` | Успіх (0 помилок) |
| `npm run lint` | Успіх (0 проблем) |
| `npm run backend:build` | Успіх |
| `test:backend` на Node 22 | 56/56 (config, API inject, database, lifecycle) |
| Smoke скомпільованого API на Node 22 | 5/5: live 200 / ready 503 без БД, SIGTERM/SIGINT → exit 0, подвійний SIGTERM, невалідна конфігурація → exit 1 без значень, зайнятий порт → exit 1 |
| `test:backend:db` (реальна PostgreSQL) | 1/1 успішно через SSH-тунель `127.0.0.1:15432` → сервер `127.0.0.1:5432`, `node_control_user`: `/health/ready` 200, пул після закриття 0 |
| Ручний loopback smoke | `127.0.0.1:3100` (перед стартом вільний), live 200, ready 200 (`DB_PORT=15432` з process env поверх `.env`), 404; SIGTERM → процес завершився, порт звільнено, пароль у логах відсутній. Тунель і процес закрито |
| Старі unit-тести (`npm test`) | 46/46 на Node 22 і на Node 24 |
| `npm run check:secrets`, `git diff --check` | Успіх |
| Старий `test:integration` (DDL/DML) | Не запускався свідомо — суперечить забороні змінювати production-дані |

Real-DB тест підтверджує лише: роль `node_control_user` може автентифікуватися в `node_control_db` через loopback сервера і виконати `SELECT 1`. Він не перевіряє HBA, firewall, TLS чи стан сторонніх служб — Task 001 у цій частині лишається частково підтвердженим.

## Task 002.1 — виправлення за review Codex (2026-10-12)

Review Codex (стан `36befba`) повторив 46 старих unit, 56 backend і 5 smoke тестів на Node v22.23.3, lint/typecheck/build/secrets — успішно; real-DB тест у review не повторювався. Знайдено два дефекти загальних error handlers (перевірено через тестові маршрути; health endpoints реальних credentials не розкривали):

1. 500-handler логував необроблений `Error` — синтетичний секрет із `message` потрапляв у логи.
2. 4xx-handler повертав довільні `error.name`/`error.message` — `statusCode: 400` не робить текст безпечним.

Виправлено (ADR-007): новий `backend/src/errors.ts` — у логи/stderr лише `category` + allowlisted `code`; клієнту — фіксований контракт (validation → `location/path/rule` зі схеми; інші 4xx → стандартний HTTP-текст; решта → загальний 500). `toSafeError`, що зберігав довільний `message`, видалено; `database`, `lifecycle`, `main` переведено на метадані; додано fatal handlers без message/stack. Lifecycle: `StartupError{cleanedUp}`; новий `server.ts` (`runServer`) гарантує завершення executable після невдалого старту (одразу при завислому cleanup, інакше unref-таймер). `freePort()` у тестах тепер відхиляє Promise при помилці listen і закриває сервер.

| Перевірка (поточна сесія, macOS) | Результат |
|---|---|
| `npm test` (старі node:test) | 46/46 на Node v22.23.3 і v24.14.0 |
| `npm run typecheck` / `npm run lint` / `npm run backend:build` | успіх |
| `test:backend` на Node v22.23.3 | 81/81 (було 56; нові: errors, server, helpers, lifecycle) |
| Перевірка regression-тестів на старому handler | тимчасово повернутий старий error handler → 14 тестів падають; код відновлено |
| `test:backend:smoke` на Node v22.23.3 | 7/7, у т.ч. процес із завислим cleanup та з відкритим handle завершується з кодом 1 за ~0,45 с |
| `test:backend:db` | 1/1 через SSH-тунель `127.0.0.1:15432` → сервер `127.0.0.1:5432`, лише `SELECT 1`; тунель закрито після тесту |
| `npm run check:local`, `check:secrets`, `git diff --check` | успіх |
| Старий `test:integration` (DDL/DML) | не запускався свідомо |

Production, реальний `.env`, БД, HBA, firewall і служби не змінювались; деплою не було. Окремо (до Task 002.1, на прямий запит користувача) код Task 002 був залитий у `/etc/pm2-dashboard` і зібраний там; API як сервіс не запускався. Код Task 002.1 на сервер не заливався.

## Task 003 — деплой Central API через systemd (2026-10-12)

**Active code revision на сервері: `5e7c11c8f217fc8d8161fdf023f42b593a1196d7`** (`feat: deploy central API with systemd`). Цей звіт додано пізнішим docs-commit, який на сервер не деплоївся.

Read-only аудит перед деплоєм (поточна сесія): hostname `control-server`, Ubuntu 26.04.1 LTS; `/usr/bin/node` v22.23.2 (nodesource), npm 10.9.8; порт 3100 вільний; користувача/групи `nodecontrol`, unit-ів `node-control*`, `/opt/goit-node-control`, `/etc/goit-node-control` не існувало; PM2 не встановлений; `/etc/pm2-dashboard/.env` — `600 root:root`, ключі `DB_*`; `SELECT 1` від `node_control_user` на `127.0.0.1:5432` — успіх. Baseline: `postgresql@18-main`, `nginx`, `docker` active; failed units 0; `secrets-manager`, `secrets-manager-cache` up; менеджер секретів API 200.

| Крок | Результат |
|---|---|
| Локальні перевірки перед commit | `npm test` 73/73 (46 старих + 27 deploy) на Node 22 і 24; typecheck, lint, build OK; `test:backend` 81/81 і smoke 7/7 на Node v22.23.3; `check:secrets`, `git diff --check`, `check:local` OK |
| Git | `5e7c11c` запушено в `origin/main` до деплою (без force) |
| Артефакт | `build-release.js` на Node v22.23.3 з `git archive 5e7c11c`; 14 файлів у manifest; без `.env*`, `.git`, `node_modules`, сирців, тестів, `.map`; SHA-256 архіву `2ad0ac39…3fced5b` |
| Передача | `scp` у новий `/root/node-control-deploy/<sha>/` (700); `sha256sum -c` на сервері — OK |
| Користувач | `nodecontrol` (system, `/usr/sbin/nologin`, home `/nonexistent`, без sudo) |
| Prepare | checksum → manifest → `npm ci --omit=dev` (61 пакет) → `releases/5e7c11c…` `root:root 755/644`; запис для `nodecontrol` неможливий |
| Конфіг | `/etc/goit-node-control/api.env` створено з `DB_*` legacy + `NODE_ENV=production`, `API_HOST=127.0.0.1`, `API_PORT=3100`, `LOG_LEVEL=info`; `600 nodecontrol:nodecontrol`, каталог `750 root:nodecontrol`; legacy `.env` не змінено й недоступний `nodecontrol` |
| Unit | `systemd-analyze verify` — exit 0 (попередження лише від чужих xfs units); `systemd-analyze security` — exposure 1.3 OK |
| Запуск | `activate` (previous=none) → `enable` → `restart`; `enabled`, `active`; процес `nodecontrol`, `/usr/bin/node /opt/goit-node-control/current/backend/dist/main.js` |
| Health | `/health/live` 200 `{"status":"ok"}`, `/health/ready` 200 `{"status":"ready"}`; обидва `Cache-Control: no-store`, `x-request-id`; `/nope` → 404 |
| Мережа | listener лише `127.0.0.1:3100` (без `0.0.0.0`/IPv6); з публічної адреси 3100 недоступний; SSH forwarding з Mac → ready 200 |
| Journal | рівнів warn/error/fatal — 0; входжень DB_PASS — 0 |
| Restart | `systemctl restart` → чистий shutdown, новий PID, health 200; SIGKILL власного процесу → `Restart=on-failure` підняв за ~5 с (`NRestarts=1`), ready 200 |
| Revision | `current → releases/5e7c11c…`, `RELEASE.json.revision` збігається |
| Сторонні служби після | ті самі active, failed 0, менеджер секретів 200, нових listeners крім `127.0.0.1:3100` немає; нових FATAL/ERROR у лозі PostgreSQL немає |

Rollback підготовлено до першого старту (перший деплой: `systemctl disable --now node-control-api`); не знадобився. Автозапуск після reboot забезпечено `enable` (`multi-user.target.wants`), але реальний reboot не виконувався — сервер спільний. `db:setup`, HBA, firewall, PostgreSQL/Nginx/менеджер секретів не змінювались і не перезапускались; старий integration suite не запускався.

## Task 004 — ізольована тестова БД і версійні міграції (2026-10-12)

**Active code revision на сервері: `5ec6ece9a1055afb5c7f9708e509e21c788acd94`** (`feat: add isolated database tests and versioned migrations`); previous — `5e7c11c`. Цей звіт — пізніший docs-commit, на сервер не деплоївся.

Read-only аудит перед змінами (поточна сесія): hostname `control-server`, `/usr/bin/node` v22.23.2; `node-control-api` enabled/active, current `5e7c11c`, live/ready 200; `node_control_db` — жодних об'єктів у `public`; ролей/БД `node_control_test%` не існувало; baseline: `postgresql@18-main`, `nginx`, `docker` active, failed 0, менеджер секретів up/200.

| Крок | Результат |
|---|---|
| Тестові ресурси | `scripts/setup-test-db.js` (root, з тимчасової копії `/root/node-control-tools`, 700): створено `node_control_test_user` (LOGIN, без SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS, без членств, `COMMENT`-маркер) і `node_control_test_db` (owner — тестова роль, `REVOKE ALL FROM PUBLIC`). Isolation check: немає `CONNECT` до `node_control_db`. Повторний запуск — без ротації. Credentials: `/root/.config/goit-node-control/test-db.env` `600 root`; локально `.env.test` `600`, ignored |
| Unit / regression (Node v22.23.3) | `npm test` 80/80 (node:test; також на Node 24); `test:backend` 121/121; smoke 7/7; typecheck, lint, build, `check:secrets`, `git diff --check` — OK |
| Real-DB suite | `test:backend:db` 15/15 через SSH-тунель `127.0.0.1:15432`: ізоляція (production DB → 42501, CREATE DATABASE → 42501, атрибути/членства), чистий up → структура, повторний up no-op, status, email-політика, NOT NULL/defaults/trigger, rollback помилкової міграції, 3 конкурентні up → 1 запис, cleanup лише власної схеми. Після прогону в тестовій БД 0 схем `nc_test_*` |
| Старий `test:integration` | переведено на read-only; 12/12 проти production через тимчасовий тунель (закрито) |
| Git / артефакт | `5ec6ece` запушено до деплою; `build-release.js` на Node 22: 18 файлів (+ `migrate*.js`, `migrations.js`, SQL-міграція), без тестів/fixtures/`.env*`/`.map`; SHA-256 `23521bd8…4da613a`; `sha256sum -c` на сервері OK |
| Prepare | `npm ci --omit=dev` (86 пакетів): є `node-pg-migrate`, `pg`, `fastify`; немає `tsx`/`vitest`/`typescript`; `api.env` — `kept` (не змінено) |
| Репетиція CLI з артефакту | на `node_control_test_db` (схема `public`, роль тестова): status → up → повторний up (no-op) → status; `down` → usage, exit 2. У тестовій БД лишились `users`/`pgmigrations` у `public` — очікуваний стан репетиції |
| Backup | `pg_dump -Fc node_control_db` → `/root/node-control-backups/node_control_db-20261012T160501Z-pre-5ec6ece….dump` (`600 root`, каталог 700); `pg_restore --list` читає; 0 об'єктів — БД до міграції була порожня |
| Production migration | як `nodecontrol` з `releases/5ec6ece…`, `ENV_FILE=/etc/goit-node-control/api.env`: status pending=1 → `up` застосував `1791900000000_create-users` → status applied=1 pending=0 |
| Read-only перевірка схеми | `users`: 6 колонок/типи/defaults за ADR-010; constraints `users_pkey`, `users_email_key`, `users_email_normalized`, `users_email_format`, `users_password_hash_not_empty`; тригер `users_set_updated_at`; власник об'єктів `node_control_user`; `pgmigrations` — 1 рядок; **`users` — 0 рядків** |
| Активація | `activate` (previous=`5e7c11c`) → `systemctl restart node-control-api`; enabled/active; процес `nodecontrol`; listener лише `127.0.0.1:3100`; ззовні 3100 недоступний |
| Health | live 200 `{"status":"ok"}`, ready 200 `{"status":"ready"}`, `no-store`, `x-request-id`; `/nope` 404 |
| Journal / сторонні | warn+ 0, входжень DB_PASS 0; PostgreSQL/Nginx/Docker active, failed 0, менеджер секретів up/200 |

Rollback підготовлено до production `up`: код — `server-release.js rollback` (current↔previous) + restart лише API; схема additive і сумісна з health-only `5e7c11c`, тож лишається. Не застосовувався. Restore з backup — лише окремим рішенням (DEPLOYMENT). PostgreSQL-лог після деплою: лише очікувані помилки негативних тестів у `node_control_test_db`.

## Release blockers (до публічного production-запуску)

1. **Мережева політика PostgreSQL потребує обмеження** (з Task 004: зовнішні спроби входу, відхилені HBA). Обмеження у firewall провайдера відкладено користувачем до фінального етапу; firewall/HBA не змінювались. Відкрито.
2. **NC-SEC-001** (Ajv `instancePath` для динамічних ключів) — відкрито; схеми лише з явними `properties` і `additionalProperties: false`.
3. **Публічний сайт `https://control.example.com`** налаштований власником (Nginx + Let's Encrypt, `conf.d/control.example.com.conf`); задачі Node Control його не змінюють. Рекомендовано власнику до відкриття для користувачів (ADR-013): заголовки безпеки (CSP `default-src 'self'`, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, HSTS), `no-cache` для SPA-маршрутів, `immutable` + `try_files $uri =404` для `/assets/`.
4. Адміністратора в production не створено (email/пароль не надано) — DEPLOYMENT «Bootstrap адміністратора».

## Task 006 (оновлення) — публічний HTTPS-сайт (2026-10-12)

**Active code revision на сервері: `85f047ccd86bc7b7fb90a3e614a3fec6cefe8a6a`** (`chore(deploy): serve UI via public HTTPS site, drop loopback nginx site`); previous — `fd16acb`. Runtime-код (backend/frontend) ідентичний `fd16acb`; `bfe784e` — предок (`git merge-base --is-ancestor`). Цей звіт — пізніший docs-commit, на сервер не деплоївся.

| Крок | Результат |
|---|---|
| Аудит сайту (read-only) | `conf.d/control.example.com.conf` без змін з 18:40 UTC: `root /opt/goit-node-control/current/frontend/dist`; `/api/` → `proxy_pass http://127.0.0.1:3100` (URI зберігається); 80 → 301 на HTTPS; `nginx -t` OK |
| TLS | Let's Encrypt `CN=control.example.com`, до 2027-01-10; ланцюжок перевіряється (`ssl_verify_result=0`); оновлення — `snap.certbot.renew.timer` |
| Репозиторій | loopback-шаблони Nginx видалено з репозиторію й артефакту; ADR-013; тести 82/82 (Node 22), `check:local` exit 0 |
| Артефакт | 32 файли, SHA-256 `16e1d741…c41e17bea`; production deps `fastify`, `node-pg-migrate`, `pg` |
| Конфіг API | backup `api.env.bak-20261012T190308Z`; змінено лише `AUTH_ALLOWED_ORIGINS=https://control.example.com` (атомарно, `600 nodecontrol`); `AUTH_COOKIE_SECURE=true`; інші ключі без змін; лог старту: `authOrigins:1, cookieSecure:true` |
| Міграції | applied=2, pending=0 (схема не змінювалась) |
| Активація | `current` → `85f047c`; restart лише `node-control-api`; процес `nodecontrol`; listener `127.0.0.1:3100` |
| Nginx | loopback-сайт 3101 прибрано: backup `/root/node-control-backups/nginx-remove-loopback-20261012T190332Z` (+ довідкова копія публічного конфігу), `nginx -t` → видалення лише власних 3 файлів → `nginx -t` → reload; 3101 більше не слухає. Публічний конфіг не змінювався |
| HTTPS smoke (ззовні) | `/` 200 `no-store`; `/assets/index-*.js` 200; `/servers`, `/applications`, `/audit`, `/login` → `index.html`; `/api/auth/me` 401 `no-store` + `x-request-id`; `/api/does-not-exist` → JSON 404; login із чужим Origin → 403 (без запису в БД) |
| Браузер | headless Chromium на `https://control.example.com/audit` → `/login`, `me` 401, 0 помилок консолі, 0 порушень CSP |
| Journal | поточний процес: лише штатні повідомлення + 1 власний 403-запит; паролів 0 |
| Сторонні служби | PostgreSQL/Nginx/Docker active, failed 0, менеджер секретів up/200; 3100/3101 ззовні недоступні; users/sessions/audit_log — 0 рядків |

Login із правильним Origin у production не виконувався (пише audit); адміністратора не створено — вхід можливий після bootstrap оператором. Rollback: `server-release.js rollback` (→ `fd16acb`) + restart API; `api.env` — з `api.env.bak-20261012T190308Z`; Nginx — повернути файли з backup-каталогу, `nginx -t`, reload.

## Task 006 — React/Vite frontend і спільний деплой (2026-10-12)

**Active code revision на сервері: `fd16acb9259c0bdc9f0a855fe3553cee92f4ffe6`** (`feat(frontend): add authenticated React app and static deployment`); previous — `be432c0`. `git merge-base --is-ancestor bfe784e fd16acb` — так: фікс Codex Task 005.1 (`bfe784e`, retry dummy hash) задеплоєно разом із цим релізом. Цей звіт — пізніший docs-commit, на сервер не деплоївся.

Реалізовано (ADR-012): React 19 + React Router 8 + Vite 8 UI українською — вхід, огляд, Сервери/Застосунки (чесні порожні стани), Журнал аудиту (keyset-пагінація, лише `audit:read`), користувач/роль/вихід; стани loading/empty/error/forbidden/unavailable; адаптивний layout, доступність (labels, `aria-invalid`/`aria-describedby`, фокус, skip-link). Сесія лише в пам'яті, епохи проти гонок, API-клієнт із timeout/cancel/runtime-валідацією. Артефакт тепер містить `frontend/dist` і `deploy/nginx`; ізольований loopback-сайт `127.0.0.1:3101`.

| Перевірка (поточна сесія) | Результат |
|---|---|
| `npm run check:local` (системний Node 24.14) | exit 0: secrets OK, node:test 82/82, typecheck (backend/frontend/e2e), lint, backend 234/234, smoke 10/10, frontend 50/50, збірка UI |
| Node v22.23.3 | backend 234/234, frontend 50/50, smoke 10/10, node:test 82/82 |
| `test:backend:db` (тестова БД, тунель 15432) | 27/27 |
| Playwright E2E (тестова БД, per-run схема) | 8/8: login → reload → me → audit → logout; viewer/operator — без навігації й 403 на прямий `/audit`; невірний пароль; expired і revoked сесії; прямі SPA URL; `/api/*` 404 JSON. Після прогону 0 схем `nc_test_*`; `test-results/` видалено |
| Bundle | `assertBundleClean`: без `.map`, серверних імен конфігурації й секретних шаблонів; `VITE_*` не використовується |
| Nginx-шаблон | синтаксис перевірено на сервері в ізольованому prefix до встановлення |
| Git | `fd16acb` запушено (`bfe784e..fd16acb`) |
| Артефакт | 34 файли, SHA-256 `db1e4657…8576e4ee`; `sha256sum -c` OK; production `npm ls --omit=dev`: `fastify`, `node-pg-migrate`, `pg` (порожні scope-каталоги dev-пакетів від npm, 0 файлів) |
| Міграції | `status` з нового релізу як `nodecontrol`: applied=2, pending=0 — схема не змінювалась; `api.env` не змінювався |
| Активація | `current` → `fd16acb`, previous `be432c0`; restart лише `node-control-api`; процес `nodecontrol` |
| Nginx | `nginx -t` baseline OK; нові файли (backup-каталог `/root/node-control-backups/nginx-20261012T185439Z`, змінюваних файлів не було): snippet заголовків, `sites-available/goit-node-control-loopback.conf` + symlink; `nginx -t` OK → reload |
| API | live/ready 200; `/api/auth/me` 401 `no-store` + `x-request-id` |
| Loopback-сайт `127.0.0.1:3101` | `/` 200 `no-cache` + CSP/`X-Frame-Options`/`nosniff`/`Referrer-Policy`; `/assets/*.js` `max-age=31536000, immutable`; відсутній asset 404; `/servers` → index.html; `/api/auth/me` 401; `/api/does-not-exist` → JSON 404; login з loopback-origin → 403 (fail closed) |
| Браузер через SSH forwarding | headless Chromium: `/audit` → `/login`, `me` 401, 0 помилок консолі, 0 порушень CSP |
| Мережа | listeners `127.0.0.1:3100`, `127.0.0.1:3101`; ззовні 3100/3101 недоступні; публічний `https://control.example.com/` → 200 (UI, див. release blockers) |
| Journal / логи | warn лише очікувані (порожній allowlist; власний 403-запит); паролів 0; власний error log Nginx порожній |
| Сторонні служби | PostgreSQL/Nginx/Docker active, failed 0, менеджер секретів up/200; `users` — 0 рядків |

Rollback підготовлено, не застосовувався: `server-release.js rollback` (→ `be432c0`, узгоджена пара UI/API через одну `current`; у `be432c0` немає `frontend/dist`, тож loopback-сайт віддаватиме 404 на статику) + `systemctl restart node-control-api`; для Nginx — видалити symlink `sites-enabled/goit-node-control-loopback.conf` (і за потреби snippet/site), `nginx -t`, `systemctl reload nginx`. БД/дані не змінювались.

## Task 005 — authentication, RBAC, audit (2026-10-12)

**Active code revision на сервері: `be432c0828b30aa8e8bb3916913e18b2580c2a6c`** (`feat(auth): add sessions, RBAC and audit foundation`); previous — `5ec6ece`. Цей звіт — пізніший docs-commit, на сервер не деплоївся.

Реалізовано (ADR-011): scrypt-хешування з bounded-параметрами і limiter; серверні сесії (digest у БД, абсолютний TTL, fixation-захист, logout); cookie `__Host-nc_session` (HttpOnly, SameSite=Strict, Secure); CSRF — точний Origin allowlist для всіх state-changing `/api` (включно з login) + session-bound `x-csrf-token`; ролі admin/operator/viewer, deny-by-default `config.access`; `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/audit`; rate limiting до hashing; транзакційний audit; bootstrap CLI; міграція `1791900000001_auth-foundation`. Frontend, Agent, CRUD користувачів, password reset — не реалізовано.

| Перевірка (поточна сесія) | Результат |
|---|---|
| `npm run check:local` (Node v24 системний) | exit 0: secrets OK, node:test 80/80, typecheck, lint, Vitest 233/233, smoke 10/10 |
| Node v22.23.3 | Vitest 233/233; smoke 10/10 (anonymous me 401, compiled bootstrap CLI fail-closed, dist імпортує лише `fastify`/`pg`/`node-pg-migrate`); node:test 80/80 |
| `test:backend:db` (тестова БД через тунель 15432) | 27/27: міграції, constraints/indexes, login→me→audit→logout, fixation, expiry, актуальна роль/деактивація, failed-login без email, реальний rollback сесії й bootstrap при збої audit, 5 конкурентних bootstrap → 1 адмін, CLI end-to-end; після прогону 0 схем `nc_test_*` |
| Read-only `test:integration` проти production | 12/12 (тимчасовий тунель, закрито) |
| Git | `be432c0` запушено до деплою |
| Артефакт | 29 файлів, SHA-256 `64bc712b…fecda1be`; без тестів/fixtures/`.env*`/`.map`; `npm ci --omit=dev`: `fastify`, `node-pg-migrate`, `pg`, без devDependencies |
| Backup | `pg_dump -Fc node_control_db` → `/root/node-control-backups/node_control_db-20261012T175555Z-pre-be432c0….dump` (`600 root`), `pg_restore --list` читає (users, pgmigrations, функція, тригер) |
| Конфіг | `api.env.bak-20261012T175555Z` (`600 nodecontrol`); додано лише `AUTH_COOKIE_SECURE=true`, `AUTH_SESSION_TTL_MINUTES=480`, `AUTH_ALLOWED_ORIGINS=` (порожньо); `DB_*` не змінено; `600 nodecontrol:nodecontrol` |
| Міграція (як `nodecontrol`, з релізу) | pending `1791900000001_auth-foundation` → applied; status applied=2 pending=0 |
| Схема read-only | `audit_log`, `sessions`, `users.role` з усіма constraints та індексами; users/sessions/audit_log — 0 рядків |
| Активація | current `be432c0`, previous `5ec6ece`; restart лише `node-control-api`; enabled/active; процес `nodecontrol`; listener лише `127.0.0.1:3100`; ззовні недоступний |
| HTTP | live 200; ready 200 `no-store`; `GET /api/auth/me` без сесії → 401 `no-store` + `x-request-id`; login без Origin → 403; `/api/audit` анонімно → 401 |
| Journal | warn лише очікувані (порожній allowlist; власний 403-запит); паролів 0 |
| Сторонні служби | PostgreSQL/Nginx/Docker active, failed 0, менеджер секретів up/200 |

Auth DML-smoke у production не виконувався (повний login/logout — лише в тестовій БД). Rollback підготовлено, не застосовувався: `server-release.js rollback` (→ `5ec6ece`) + за потреби відновити `api.env.bak-…` + restart API; additive-схема й дані лишаються.

## Відомі проблеми та ризики

1. Локальне підключення до PostgreSQL можливе лише через SSH-тунель: у Task 002/002.1 тунель на `127.0.0.1:15432` працював і `SELECT 1` проходив. Це не означає, що `127.0.0.1:5432` локально або тунель доступні зараз — тунель відкривається вручну й закривається після перевірки. Успішний `SELECT 1` не підтверджує HBA, firewall, TLS чи стан сторонніх служб, тому Task 001 лишається частково підтвердженим.
2. Широке IPv4 HBA-правило, історично описані `listen_addresses` (див. приватні нотатки) і відсутність host firewall створюють залежність від зовнішнього firewall, стан якого не підтверджено. Не відкривати 5432.
3. Клієнт `pg` не задає TLS; ранні loopback HBA-правила допускають `host`, тому SCRAM-тести не підтверджують шифрування. Сертифікат у старому звіті self-signed.
4. README раніше стверджував повне покриття всіх скриптів та перевірку активного HBA. Unit-тести перевіряють бібліотеки, але не всі orchestration/error paths `setup-postgres.js`; `pg_hba_file_rules` описує файл на диску, не доводить ефективну політику поточних з'єднань.
5. `--env-owner` впливає лише на запис нового `.env`; при валідному існуючому `.env` без ротації власник не зміниться. Потрібен окремий контрольований крок перед запуском сервісу.
6. Ротація пароля та setup не є єдиною транзакцією: `.env` записується раніше SQL, помилка може залишити невідповідний пароль. HBA rollback не охоплює всі винятки після запису файлу. Потрібне окреме завдання з failure-path тестами.
7. Сканер секретів пропускає файли понад 1 MiB, використовує обмежені шаблони та поточний DB_PASS. Перевірка не гарантує виявлення всіх типів секретів або старих паролів.
8. `db:setup --rotate-password` перезаписує `.env` лише DB-ключами (`formatEnv`) — `API_*`, `LOG_LEVEL`, `NODE_ENV` у тому ж файлі буде втрачено (є defaults, але кастомні значення зникнуть).
9. Локально Node.js 24; Node 22 перевірено через `npx node@22`, `npm run check:local` без нього запускає Vitest на системному Node.
10. API працює як systemd-сервіс лише на loopback; Nginx, домен і HTTPS ще не налаштовані. Health endpoints публічні за задумом, інших маршрутів немає.
11. Логи помилок містять лише `category`/`code` без тексту (ADR-007) — діагностика конкретної помилки потребує відтворення; розширення — окремим рішенням з явно безпечними полями.
12. Fatal handlers (`uncaughtException`/`unhandledRejection`) завершують процес одразу без graceful shutdown; перезапуск забезпечує systemd (`Restart=on-failure`, ≤5 разів за 5 хв).
13. `/health/ready` виконує `SELECT 1` на кожен запит без rate limit/кешу; перед публікацією через Nginx потрібне рішення.
14. Історичний `/etc/pm2-dashboard` досі містить збірку Task 002 і legacy `.env`; сервіс їх не використовує. Прибирання — окремим рішенням.
15. **NC-SEC-001 / P2 — відкладено за рішенням користувача.** Review Codex для `f4417d3`: `backend/src/errors.ts`, `validationIssues()` відображає Ajv `instancePath` у відповіді. Для схеми з динамічними ключами (`additionalProperties: { type: 'integer' }`) секретний ключ із запиту потрапляє у `validation[].path`. Відтворено тестовим маршрутом із синтетичним маркером; чинні health endpoints не мають такого сценарію. Виправлення: перевірені статичні шляхи, узагальнення/приховування динамічних ключів, regression-тести. Закрити до додавання endpoint зі схемою, що допускає динамічні ключі, або публікації такого endpoint. Відкладення не означає виправлення. Стан на Task 005: **відкрито**; задеплоєний API не має endpoint із динамічними ключами (усі схеми з явними properties).
16. Reboot-тест автозапуску не виконувався (спільний сервер); `enable` перевірено.
17. Старі релізи не прибираються автоматично; `/root/node-control-deploy/<sha>` зберігає артефакт для повторного prepare/діагностики.
18. Перед кожним деплоєм `build-release.js` вимагає чистий каталог і commit в `origin/main`; деплой не-`main` гілок не передбачено.
19. **мережевий доступ до PostgreSQL потребує обмеження.** У лозі PostgreSQL 2026-10-12 16:00 UTC — спроба `user "test"` з `198.51.100.7`, відхилена HBA (`no pg_hba.conf entry … no encryption`). Тобто зовнішній firewall пропускає 5432 не лише для конкретних IP. Node Control не змінював firewall/HBA; рекомендовано обмежити джерела в firewall провайдера (і переглянути `host secrets-manager … 0.0.0.0/0` без TLS) окремим рішенням.
20. Тестова БД на тому ж кластері, що й production: ізоляція — на рівні ролей/ACL, не ресурсів (CPU/IO/connections спільні). У `public` тестової БД лишились об'єкти репетиції CLI.
21. Authentication реалізована в backend (Task 005), але в production немає адміністратора й allowed origins — вхід неможливий до Task 006 + Nginx/HTTPS і bootstrap оператором.
22. Rate limiting — у пам'яті одного процесу, скидається при рестарті; за майбутнім reverse proxy ліміт за адресою стане глобальним (trustProxy вимкнено) — переглянути з конфігурацією proxy.
23. Масове очищення старих сесій — ручний SQL (DEPLOYMENT); автоматично лише для користувача при його login.
24. Failed-login / authz.denied audit — best effort: при збої запису подія втрачається (логується), доступ не надається.

Повторний review Codex для `f4417d3`: 46 старих unit, 81 backend і 7 compiled smoke тестів успішні (backend/smoke на Node.js v22.23.3 поза sandbox); typecheck/lint/build/secrets/diff check успішні. Попередні витоки 500 logs і довільного 400 response усунені, startup cleanup обмежено в часі. Real-DB і сервер у цьому review не перевірялись.

## Task 005.1 — виправлення dummy hash після review Codex

Review відтворив P2: відхилений Promise першої ініціалізації `dummyHash` кешувався до рестарту. Після перевантаження hashing limiter невідомі акаунти продовжували отримувати 503 навіть після звільнення ресурсу; це порушувало однакову поведінку перевірки credentials.

Виправлення: успішна ініціалізація лишається спільною, але помилка очищає кеш і повторно передається поточним викликам; наступний запит може повторити ініціалізацію. Regression-тест із новим екземпляром модуля перевіряє два одночасні відхилені виклики при заповненому limiter, звільнення ресурсу та дві наступні успішні dummy-перевірки (результат `false`). Схема БД та API-контракт не змінені. Серверний revision цього виправлення ще не підтверджено.

Перевірки Codex для Task 005.1: `check:local` на Node.js v22.23.3 — успішно (80 node:test, 234 backend, 10 compiled smoke; typecheck, lint, build, secrets). Real-DB suite та сервер у цьому виправленні не перевірялись; SQL не змінювався.

## Активне та заплановане

In Progress: Task 006 задеплоєно на `85f047c` (публічний HTTPS-сайт, `AUTH_ALLOWED_ORIGINS` налаштовано); очікує review Codex. Підтвердження серверної частини Task 001 — відкрите.

Next Task: bootstrap адміністратора оператором (email/пароль від користувача); після review — Agent і API серверів/процесів. Перед production-запуском — release blockers (5432, NC-SEC-001, hardening публічного сайту).

Planned: узгодити вузьку мережеву політику/TLS і усунути setup-ризики окремим завданням; окремий користувач сервісу й systemd; Fastify API та версійні міграції; агент; React/Vite + Nginx/TLS; авторизація й аудит для кожної адміністративної операції; Jenkins, менеджер секретів, Slack. Після стабілізації MVP — окрема оцінка контейнеризації API/Agents. Це план, а не реалізовані компоненти.
