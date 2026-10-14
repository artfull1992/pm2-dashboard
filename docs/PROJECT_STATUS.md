# Поточний стан проєкту

Оновлено: 2026-10-15 (Task 013.2 UI). Початковий commit: `ccbba13dbea512d962dbea5fbeb8bd1cd8b8a5eb` (`chore: initialize node control infrastructure`), гілка `main`, remote `origin`. Початкове робоче дерево чисте. Перевірка доступної історії охопила один commit; це не підтверджує актуальний стан remote або факт попереднього push.

## Незалежний review Codex — Task 011 (2026-10-14)

Переглянуто фінальний code commit `20896dd` та docs-звіт `2ce89c7`; початкове дерево чисте. Review незавершеного робочого дерева раніше було зупинено користувачем; він не є висновком щодо фінального commit.

Знайдено два P2:

1. **Запізнілий успіх зміни пароля змінює глобальний стан авторизації після unmount.** `frontend/src/pages/AccountPage.tsx:72` після await не перевіряє controller.signal.aborted та викликає passwordChanged(); apiRequest також не перевіряє abort на успішному 204. Відтворено із synthetic deferred response: pending зміна пароля → logout → новий login → Огляд → успішна відповідь старої форми; нова сесія UI скидається, з’являється «Пароль змінено». Потрібні перевірка актуальності/скасування перед побічними ефектами, захист меж сесій і regression-тест. Перевірити також успішні гілки create/update users. Це клієнтська гонка, не доказ обходу авторизації backend.
2. **Після перших 100 користувачів UI не дозволяє керувати рештою.** usersApi.list завжди запитує limit=100 без after; `frontend/src/pages/UsersPage.tsx:194` лише повідомляє про перші 100. API cursor реалізований, але frontend не використовує nextAfter. Потрібні пагінація/завантаження наступних сторінок, коректне оновлення після мутацій і regression для понад 100 користувачів, включно зі щойно створеним.

Незалежні перевірки фінального коду на Node.js 22: check:local exit 0 (89 node:test, 380 backend, 10 smoke, 164 agent +3 opt-in пропущені, 136 frontend; lint/typecheck/secrets/збірки). Окремо real-DB db/users: 12/12 у per-run схемах ізольованої тестової БД через власний тимчасовий SSH-тунель; тунель автоматично закрито. Перевірено CAS password changes, login проти committed/uncommitted changes, concurrent admin changes, audit rollback. Повний real-DB/E2E фінального commit не повторювався; результати Claude нижче історичні. Тимчасовий frontend reproduction-тест підтвердив перший P2 і видалений; після видалення check:local повторено успішно.

Read-only SSH: control-server current `20896ddcb0c70f22cb101ba539cac048c333513a`, API/Nginx active, ready 200. Production-користувачі, паролі, конфігурації та PM2-процеси не змінювалися. Функціональний код reviewer не змінював; запис підготовлено локально без commit/push/deploy. Task 011 потребує виправлень; після них наступна задача — Dashboard, Jenkins лишається далеким backlog.

## Незалежний review Codex — Task 011.1 (2026-10-14)

Переглянуто `ac4d967` і docs-звіт `034794c`; початкове дерево чисте. Обидва попередні P2 виправлені: відповіді прив’язані до auth epoch/abort, користувачі доступні через cursor-пагінацію.

**Новий P2 — успіх створення користувача перезавантажує покинуту сторінку списку.** `frontend/src/pages/UsersPage.tsx:67`: pending CreateUserForm зберігає старий onCreated; пагінація дозволена під час створення, форма не unmount. Callback використовує data/reload старого cursor (`UsersPage.tsx:203`). Відтворено synthetic deferred POST: створення на сторінці 1 → «Далі» → рядки сторінки 2 → успішний POST → GET першої сторінки без after. Номер лишається «Сторінка 2», але рядки зникають до наступного polling: keyed resource отримує owned data старого ключа. Це не виправляється auth binding, оскільки сесія не змінилася. Потрібно застосовувати callback/reload актуальної сторінки або не дозволяти зміну cursor під час pending створення; додати regression для цього сценарію й помилки створення після переходу.

Незалежний check:local на Node.js 22 exit 0: 89 node:test, 380 backend, 10 smoke, 164 agent +3 opt-in пропущені, 151 frontend; lint/typecheck/secrets/збірки. UI Playwright із synthetic API: 2/2 desktop/mobile. Новий окремий reproduction-тест підтвердив дефект і видалений. Real-DB та повні user E2E цього разу не повторювалися (backend не змінено).

Read-only SSH: control-server current `ac4d967679a723db04185f04f2cdd4e1b6a1d259`, API/Nginx active, ready 200. Production-користувачі/паролі/конфігурації не змінювались. Task 011.1 потребує одного додаткового frontend-виправлення перед переходом до Dashboard. Запис review локальний, без commit/push/deploy; функціональний код reviewer не змінював.

## Незалежний review Codex — Task 011.2 (2026-10-14)

Переглянуто фінальний code commit `0b85151` і docs-звіт `cd48ef8`; початкове дерево чисте. Попередній P2 закрито: CreateUserForm викликає актуальний onCreated, що використовує data/reload поточного cursor. Нових блокувальних дефектів у переглянутому diff не знайдено. Це закриває зауваження review Task 011/011.1 у межах реалізованих сценаріїв.

Незалежно на Node.js 22: 157/157 frontend-тестів (включно з шістьма новими create-while-paging regression), typecheck, lint, frontend build, check:secrets і diff check успішні; UI Playwright із synthetic API 2/2 desktop/mobile. Початковий frontend-прогін був розпочатий перед перериванням review й завершився успішно; порівняння підтвердило той самий фінальний код. Повний check:local, real-DB і user E2E цього разу незалежно не повторювалися; результати Claude вище є історичними. Backend/схема/Agent не змінені.

Read-only SSH: control-server current `0b851511612096c05ba7825b15ab6c51f50975e7`, API/Nginx active, ready 200. Production-користувачі, паролі й конфігурації не змінювались. Запис review підготовлено локально без commit/push/deploy; функціональний код не змінено. Наступна задача — Dashboard за погодженим roadmap, потім Slack, історія метрик і production-підготовка.

## Незалежний review Codex — Task 012 (2026-10-14)

Переглянуто завершений code commit `1c6c58d` і docs-звіт `fe25d5e`; початкове робоче дерево чисте. Перевірено агрегати, freshness, виключення неактивних серверів, розділення live/notLive, bounded списки, permission-aware recentActions і read-only узгоджений snapshot. Нових блокувальних дефектів у переглянутих змінах Dashboard не знайдено.

Незалежно на Node.js 22: check:local exit 0 (89 node:test, 387 backend, 10 smoke, 164 agent +3 opt-in пропущені, 165 frontend; lint/typecheck/secrets/збірки). Окремі real-DB dashboard-тести — 6/6 у per-run схемах ізольованої тестової БД: порожня система, рахунки/JOIN, межі свіжості, обмежені списки й totals, права/overdue/read-only, READ ONLY транзакція. Власний тимчасовий SSH-тунель автоматично закрито. Локальні UI Playwright regression — 2/2 desktop/mobile зі synthetic API. Повний real-DB suite, dashboard E2E і real-PM2 E2E у цьому review не повторювались; їхні результати Claude вище є історичними.

Read-only SSH: control-server current `1c6c58df90083438cf2000a60c63ebe1c38e7eaa`, API/Nginx active, ready 200. Production-користувачі, passwords, серверні дані, Agent/broker і PM2-процеси reviewer не змінював. Відомий timeout graceful shutdown із long-poll описано у звіті деплою; у цьому review не відтворювався і не закритий — потрібна окрема перевірка/виправлення до фінальної production-підготовки.

Dashboard пройшов review; наступна задача за погодженим roadmap — Slack/alerts, потім історія метрик і production-підготовка. Запис review локальний без commit/push/deploy, функціональний код не змінено.

## Завершено за фактичними файлами

- Каркас каталогів, npm manifest/lockfile та залежність `pg`.
- Скрипти налаштування PostgreSQL, перевірки з'єднання та секретів; допоміжна логіка env/SCRAM/SQL/HBA.
- Unit та integration suites, `.env.example`, `.gitignore`, README і серверний звіт Task 001.
- Початкова інтеграція AI-контексту: AGENTS, ARCHITECTURE, DECISIONS, DEVELOPMENT_RULES, AI_WORKFLOW та цей документ. Код функцій не змінено, деплой не виконувався.

## Task 001 — частково підтверджено

Код і commit перевірені. Історичний серверний звіт Task 001 (роль/БД, HBA reload, `.env`, 46 unit + 15 integration тестів) винесено з публічного репозиторію; цей результат не відтворено незалежно. Task 001 не має статусу повністю технічно підтвердженого.

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

1. **Мережева політика PostgreSQL** production-сервера потребує окремої перевірки й обмеження (деталі — лише в приватних операційних нотатках). Відкрито.
2. **NC-SEC-001** (Ajv `instancePath` для динамічних ключів) — відкрито; схеми лише з явними `properties` і `additionalProperties: false`.
3. **Публічний сайт `https://control.example.com`** налаштований власником (Nginx + Let's Encrypt, `conf.d/control.example.com.conf`); задачі Node Control його не змінюють. Рекомендовано власнику до відкриття для користувачів (ADR-013): заголовки безпеки (CSP `default-src 'self'`, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, HSTS), `no-cache` для SPA-маршрутів, `immutable` + `try_files $uri =404` для `/assets/`.
4. ~~Адміністратора не створено~~ — 2026-10-12 створено першого адміністратора (`admin@example.com`) через bootstrap CLI як `nodecontrol`; пароль згенеровано на сервері (20 символів), передано через stdin і повідомлено користувачу один раз; у репозиторії/логах його немає. Audit: `admin.bootstrap` success. **Потрібна функція зміни пароля** (наступне завдання) — до неї пароль тимчасовий.

## Task 013.2 (UI) — спрощений layout «Правил сповіщень» (2026-10-15)

Номер 013.2 вже використано для виправлення egress (розділ нижче); це окреме UI-завдання з тим самим номером. Стан на початок: `main` = `26cca5b`, дерево чисте. Лише frontend: API, payload, валідація, permissions, optimistic concurrency, webhook, worker і backend не змінювались.

**Зроблено** (`frontend/src/pages/SettingsPage.tsx`, `frontend/src/styles.css`):
- Одна картка до 1080 px; групи «Загальний стан», «Навантаження», «Процеси», «Цикл і повтори», «Додаткові параметри» (згорнуті) розділені лінією, без вкладених рамок.
- Кожен рядок має однакову сітку: назва й одне пояснення ліворуч; праворуч один контрол або пара однакових («Проблема / Відновлення», «Кількість / За період»). Одиночний контрол займає першу колонку пари, тож ширина всюди однакова.
- Поля мають висоту 44 px і одиницю як суфікс. Видимі підписи короткі; повні доступні імена збережено (`aria-label`, напр. «CPU процесу — поріг відновлення, %»).
- Межі й типові значення показуються кнопкою «Показати межі й типові» (`aria-pressed`, не hover), прив'язаною через `aria-describedby`. Помилка замінює підказку під своїм полем і не зсуває пару.
- Пояснення зберігають зміст: CPU PM2 може перевищувати 100 %; пам'ять ОС — не пам'ять застосунку.
- Рушій і нагадування — перемикачі (native checkbox, `role="switch"`). Інтервал нагадувань лишається редагованим і валідованим, коли нагадування вимкнені, — як раніше; це пояснено в тексті рядка, тож прихованих полів, що блокують збереження, немає.
- Унизу одна панель дій: повідомлення результату/конфлікту («Перечитати стан»), компактний індикатор «Є незбережені зміни.», «Скасувати зміни», «Зберегти». Панель **не sticky**: у full-page перевірці sticky-панель перекривала вміст, тому лишено звичайний потік (дозволено умовою «sticky лише без перекриття»).
- Мобільна версія (≤ 760 px): пояснення над контролами, пари поруч, без горизонтального скролу, кнопки 44 px.

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 438/438, smoke 10/10, agent 164/164 (+3 opt-in), frontend 184/184 (+1 тест layout: короткі підписи з повними іменами, межі за кнопкою, помилка замість підказки, «Скасувати зміни», перемикачі дають той самий payload), typecheck, lint, збірки, `check:secrets` OK |
| UI Playwright (синтетичний API) | 6/6, новий `settings-layout.spec.ts` (1440/390 × light/dark): 15 полів однакової висоти (40–46 px) і ширини, пари на одній лінії, форма ≤ 1100 px, без горизонтального скролу, помилка біля поля без зсуву пари, додаткові параметри відкриті |
| Real-DB (`test:backend:db`) | 94/94. Перший прогін — 92/94: `control` deadlines (15 с) і `servers` revoke race (6 с) впали через затримки SSH-тунелю; backend не змінювався, повтор цих файлів 22/22 і всього набору 94/94 |
| E2E (тестова БД) | 18/18 (+1 opt-in), зокрема `settings.spec.ts` з новою розміткою |
| Real-PM2 E2E | 1/1 |
| `git diff --check`; залишки | OK; 0 схем `nc_test_*`; PM2 daemon і `~/.pm2` відсутні |

Screenshots до/після — лише синтетичні дані (scratchpad, не в репозиторії). Реальних Slack-повідомлень не надсилалось.

**Деплой (2026-10-15).** Code revision **`3153abcf52996ddfc563a3dbf30c873ebbaa3d00`** (`refactor(settings): simplify alert rules layout and align controls`).

| Крок | Результат |
|---|---|
| Артефакт | `sha256sum -c` OK, manifest revision збігається; юніт ідентичний установленому (`cmp`), `daemon-reload` не потрібен |
| Міграції | немає (`migrate.js status`: усі applied, pending відсутні); backup БД не знадобився |
| Реліз | `current` → `3153abc`, `previous` → `9e7f71b` (ціль rollback); restart лише `node-control-api` |
| Після | active, `User=nodecontrol`, `IPAddressDeny` порожній, listener лише `127.0.0.1:3100`; live/ready 200 локально й HTTPS; анонімні `/api/settings/alerts` і `/api/auth/me` → 401; HTTPS віддає новий bundle з `current/frontend/dist`; 0 error у журналі після restart; `nginx -t` OK |
| Agent/broker | не змінювались (`2fe4d95`) |

Production-налаштування сповіщень, webhook, стан доставки й користувачі не змінювались: реліз лише frontend, без міграцій, жодних мутуючих запитів під час перевірок, Slack-тест не натискався. Пряме read-only звіряння таблиць `alert_settings`/`alert_slack_integration` не виконано — читання production БД заблоковане політикою дозволів сесії.

**Rollback:** `server-release.js rollback` → `9e7f71b`, restart `node-control-api` (міграцій і змін юніта немає).

## Task 013.2 — Slack-тест завершувався тайм-аутом: egress API-юніта (2026-10-15)

**Симптом.** Після налаштування webhook в UI тестове повідомлення не надходило в Slack. Audit показав обидва тести (22:09 і 22:10 UTC) як `integration.slack_test_result` з `unknown/timeout` — рівно 5 с, без відповіді.

**Діагностика** (лише метадані, без значення webhook):
- DNS `hooks.slack.com` резолвиться; TLS-з'єднання з сервера встановлюється за ~0,06 с (`curl -4` до кореня хоста, 302);
- `fetch` Node.js від користувача `nodecontrol` поза systemd — відповідь за 0,3 с;
- у юніті `node-control-api` (з Task 003) стояло `IPAddressDeny=any` + `IPAddressAllow=localhost`: systemd тихо відкидав вихідні пакети API-процесу до будь-якої не-loopback адреси.

Автотести цього не виявили: Slack у них мокається, а E2E-backend запускається не під systemd.

**Рішення користувача:** відкрити вихідні з'єднання. Egress-фільтр знято з `deploy/systemd/node-control-api.service`. Вхідний доступ не змінився: listener лише `127.0.0.1:3100`. Призначення обмежує код (лише `https://hooks.slack.com/services/…`, `redirect: 'error'`). ADR-022 і DEPLOYMENT оновлено.

**Деплой (~22:14 UTC).** Code revision **`9e7f71bdf9317a152e972fe85c09e1f773b85f11`** (`fix(alerts): allow outbound HTTPS from the API unit for Slack delivery`).

| Крок | Результат |
|---|---|
| Backup юніта | `/root/node-control-backups/node-control-api.service.bak-20261014T221443Z` |
| Юніт | `systemd-analyze verify` OK, `daemon-reload` |
| Реліз | `current` → `9e7f71b`, `previous` → `325cc91` (ціль rollback); міграцій немає; restart лише API, старий процес завершився штатно |
| Стан юніта | `IPAddressDeny`/`IPAddressAllow` порожні; `RestrictAddressFamilies` і `User=nodecontrol` без змін |
| Після | ready 200 локально й HTTPS; 0 error; `hooks.slack` у журналі немає |
| Стан сповіщень | доставку admin увімкнув, рушій вимкнений; outbox порожній; інцидентів немає; останній тест — ще старий `unknown/timeout`, admin має повторити тест |

**Підтверджено (22:16:20 UTC):** повторний тест admin — `success` (generation 1); користувач підтвердив, що повідомлення надійшло в Slack. Рушій поки вимкнено, доставку ввімкнено.

Під час деплою скрипт зупинився на `diff` юніта (`set -e` + `pipefail`, код 1 при відмінностях) ще до встановлення юніта. Сервер лишався на `325cc91`, далі кроки виконано окремо.

**Rollback:**
1. Відновити юніт із backup.
2. `daemon-reload`.
3. `server-release.js rollback` → `325cc91`.
4. Restart API.

Після цього Slack знову стане недоступним.

## Task 013.1 — admin UI для Slack-інтеграції й правил сповіщень (2026-10-15)

Стан на початок: `main` = `6bf0c6e`, робоче дерево чисте. Task 013 ще **не має** незалежного review Codex — ця задача його розширює й не вважає Task 013 підтвердженим. Рішення — ADR-022; міграція `1791900000007_alert-settings`.

**Реалізовано:**
- **Джерело конфігурації.**
  - Singleton `alert_settings` з `revision` і `rules_revision`; DB CHECK для всіх меж і для правила «поріг відновлення нижче порогу проблеми».
  - `ALERTS_*` прикладні змінні env — лише одноразові початкові значення; збережені налаштування не перезаписуються. `ALERTS_ENABLED`, `ALERTS_DELIVERY_ENABLED` і `ALERTS_SLACK_WEBHOOK_URL` ігноруються з попередженням без значення; webhook з env не імпортується.
  - В env лишились `ALERTS_SECRET_KEY` (+ `_VERSION`) і `ALERTS_PUBLIC_URL`.
- **Секрет.**
  - Webhook шифрується AES-256-GCM: випадковий 12-байтний nonce; AAD прив'язує запис до generation; у таблиці `alert_slack_integration` зберігаються ciphertext, tag і `key_version`.
  - Ключ — лише в `api.env`. Немає ключа, інша версія або дешифрування не вдається → fail-closed зі станом `error` (`key_missing` | `key_version_mismatch` | `decrypt_failed`), без fallback.
  - Webhook не повертається, не логується й не потрапляє в audit; frontend-парсер відкидає відповідь, схожу на секрет.
- **API** (`alerts:manage`, Origin + CSRF, строгі схеми, мутації 30/хв на актора):
  - `GET` і `PATCH /api/settings/alerts` з optimistic concurrency за `revision` (409);
  - `PUT` і `DELETE /api/settings/integrations/slack` з `generation` (409);
  - `POST /api/settings/integrations/slack/test` — 5/хв на актора, один тест у польоті, синхронний результат `success` | `failed` | `unknown`.
  - Audit — у тій самій транзакції, лише метадані.
- **Hot reload.**
  - Worker створюється, коли API запущено з конфігурацією alerts. Кожні 5 с він читає узгоджений знімок налаштувань та інтеграції; оцінювання — коли рушій увімкнено й минув інтервал.
  - Новий `AbortController` на кожен `start()`.
  - Зміна правил скидає серії `pending`/`recovering` (`alert_conditions.rules_revision`); відкриті інциденти, cooldown і baseline рестартів лишаються.
- **Черга.**
  - Записи outbox прив'язані до `generation`; worker захоплює лише поточну generation.
  - Заміна чи видалення webhook, а також вимкнення доставки скасовують `queued`/`sending` записи (`cancelled`: `integration_changed` | `delivery_disabled`) — без пересилання новому адресату й без «вибуху» після повторного ввімкнення.
  - Запит, що вже в польоті, може дійти старому адресату — це задокументовано.
  - Зменшення ліміту черги нічого не видаляє.
- **Тестове повідомлення.**
  - Лише для збереженої інтеграції; незбережене поле — «Спочатку збережіть webhook».
  - Працює при вимкненій доставці й рушії; не створює інцидент; позначене як тестове; без автоповтору.
  - Тайм-аут або abort → `unknown`. Результат зберігається лише для поточної generation.
- **UI.**
  - Розділ «Налаштування» (лише `alerts:manage`; прямі routes захищені) з вкладками «Інтеграції» та «Правила сповіщень». Чинний дизайн, одиниці й межі біля кожного поля, «Додаткові параметри» в згортанні.
  - Клієнтська валідація, dirty/saving/success/error/conflict; попередження про незбережені зміни (`beforeunload` + підтвердження при зміні вкладки); поле webhook очищається.
  - Мутації прив'язані до сесії й abort.
  - На «Сповіщеннях» для admin — кнопка «Налаштувати».

**Офіційна документація Slack (docs.slack.dev), звірено:** webhook прив'язаний до одного каналу, обраного при встановленні; для приватного каналу встановлювач має бути його учасником; payload не змінює канал; `channel_is_archived`, `no_service`, `no_active_hooks`; URL — секрет. Поля вибору каналу немає.

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 438/438, smoke 10/10, agent 164/164 (+3 opt-in), frontend 183/183, typecheck, lint, збірки, `check:secrets` OK |
| Нові backend | `settings-api` 14: доступи, Origin/CSRF, валідація й міжпольові правила, stale revision/generation, відкат при збої audit, шифрування й прив'язка до generation, SSRF/невалідні URL, відсутній ключ, тест success/400/410/429/network/timeout→unknown, другий клік → 409, rate limit, результат старої generation не позначає нову. `alerts-delivery` +3: hot reload й інтервал, claim лише поточної generation та fail-closed, enable → disable → enable |
| Real-DB (`test:backend:db`) | 94/94, нові `db/settings` 7: одноразова ініціалізація; конкурентні оновлення (рівно один); відкат налаштувань при збої audit; лише ciphertext і виявлення tamper/wrong key/version; скасування черги й claim за generation; скидання серій при зміні правил; результат тесту лише для поточної generation |
| Frontend | нові `settings` 12 |
| UI Playwright | 2/2 |
| E2E (`test:e2e`, тестова БД, випадковий ключ на прогін) | 18/18 (+1 opt-in), нові `settings.spec.ts` 2: admin зберігає синтетичний webhook (у сторінці й audit його немає, у БД лише ciphertext) і правила; operator → 403; 390 px. Кнопка тесту в E2E **не натискалась**: дочірній backend звернувся б до справжнього Slack; тест покритий mock-транспортом |
| Real-PM2 E2E | 1/1 |
| Залишки | 0 схем `nc_test_*`; PM2 daemon і `~/.pm2` відсутні |

Обмеження:
- Попередження про незбережені зміни — `beforeunload` і підтвердження між вкладками; перехід через бічне меню всередині SPA його не показує (BrowserRouter без data-router blocker).
- Один тест у польоті — на процес API (single instance).
- Доставка лишається at-least-once.

**Деплой (2026-10-14, ~21:43 UTC, лише центральний сервер).** Deployed code revision: **`325cc91d5ee7abb125e0cbc955e330e2ddd16cfc`** (`feat(settings): add admin-managed Slack integration and alert rules`). Цей запис — пізніший docs-commit, на сервер не деплоївся. Agent/broker не передеплоювались.

| Крок | Результат |
|---|---|
| Baseline | `control-server`; current `e8f61c5` (ціль rollback), previous `1c6c58d`; API active, ready 200; Nginx/PostgreSQL active, failed 0; `api.env` `nodecontrol:nodecontrol 600`, ключів `ALERTS_*` не було |
| Артефакт | 62 файли, SHA-256 `6430ca14…d56e48ee` OK, manifest `325cc91`; unit без змін |
| Backup | `api.env.bak-20261014T214333Z` (600); `node_control_db-20261014T214333Z-pre-325cc91….dump` (600, `pg_restore --list` OK) — лише `node_control_db` |
| Міграція | applied=7, pending=1 (`1791900000007_alert-settings`) → `up` → applied=8, pending=0 |
| Ключ шифрування | Згенеровано на сервері (32 випадкові байти, base64), **значення ніде не виводилось**; дописано в `api.env` (`ALERTS_SECRET_KEY`, `ALERTS_SECRET_KEY_VERSION=1`, `ALERTS_PUBLIC_URL=https://control.example.com`), права `600 nodecontrol`. Окрема копія ключа: `/root/node-control-keys/alerts-secret-key-20261014T214333Z.env` (каталог 700, файл 600). Оператору рекомендовано зберегти ключ і поза сервером (менеджер секретів): backup БД без ключа не відновлює інтеграцію |
| Активація | `current` → `325cc91`, `previous` → `e8f61c5`; restart лише `node-control-api`; журнал: `alertsSecretKey:true`, `alertsPublicUrl:true`; «Alert settings initialised from defaults» (рядок створено один раз); legacy-попереджень немає |
| Чистий shutdown | Обидва рестарти (`e8f61c5` → новий і контрольний рестарт нового коду з утримуваним long-poll Agent) — `Shutdown complete`, ~0,1 с, без `Failed` |
| Після деплою | API active (`nodecontrol`, лише `127.0.0.1:3100`); live/ready 200 локально й HTTPS; HTTPS `/settings/integrations` 200; бандл = `current/frontend/dist`, містить «Налаштування». Анонімні `GET/PATCH /api/settings/alerts`, `PUT /api/settings/integrations/slack`, `POST …/slack/test`, `/api/alerts/status` → 401; чужий Origin → 403 (1 warn — саме ця перевірка). Журнал: 0 error/fatal; ні ключа, ні `hooks.slack` у журналі; `nginx -t` OK |
| Стан сповіщень | `alert_settings`: revision 1, **рушій вимкнено, доставку вимкнено**, типові пороги; Slack: generation 0, **не налаштовано**; інцидентів/outbox/умов — 0. Тестових повідомлень не надсилалось |
| Agent / PM2 | heartbeat 0 с, control 9 с — звіти надходять; керуючих дій не було; користувачі без змін (2, 1 активний admin) |
| Rollback | не застосовувався. Спершу вимкнути доставку в UI (якщо ввімкнена), далі `server-release.js rollback` → `e8f61c5` + restart лише API. Старий реліз читає лише `ALERTS_*` з env (`ALERTS_ENABLED`/`DELIVERY`/`WEBHOOK` відсутні) — рушій і доставка там вимкнені, старий webhook не з'являється. Ключ і нові таблиці лишаються; secrets/outbox не видаляються |

Подальші кроки — admin у UI: «Налаштування» → «Інтеграції» → зберегти webhook приватного каналу → «Надіслати тестове повідомлення» → за успіху увімкнути доставку; «Правила сповіщень» → увімкнути рушій.

## Task 013 — Alerts Engine, Slack і виправлення graceful shutdown (2026-10-14)

Стан на початок: `main` = `fe25d5e`; у робочому дереві — незакомічений запис review Codex (угорі документа), збережено й закомічено разом із задачею. Рішення — ADR-021; міграція `1791900000006_alerts`.

**Graceful shutdown (відомий дефект із Task 011.1) — дві причини, обидві виправлено:**
1. `LogHub.close()` викликався в `onClose`, тобто вже після того, як Fastify дочекався активних запитів. Тепер він у `preClose`; `onClose` лишився ідемпотентним; закритий hub відповідає на нові long-poll одразу.
2. Знайдено під час regression-тесту: навіть звільнений long-poll лишає keep-alive сокет, який став idle вже після старту `close()`. Fastify такі сокети не закриває, і сервер тримався ще ~72 с (keep-alive timeout). Тепер після старту закриття кожна відповідь іде з `Connection: close`.

Regression: справжній HTTP, Agent long-poll і очікувач результату логів у польоті, `lifecycle.shutdown('SIGTERM')` з тайм-аутом 3 с. На старому коді — `false` (тайм-аут), на новому — `true` менш ніж за 2 с, обидва запити отримують 200. Окремо перевірено shutdown із завислою Slack-доставкою: abort, запис повертається в чергу (`aborted`), закриття чисте.

**Alerts:**
- Правила: `server_offline`, `inventory_stale`, `process_down`, `process_cpu`, `server_memory`, `process_restarts` і відновлення для кожного.
- Debounce й гістерезис; вибірка, яку вже оцінювали, не рахується вдруге; відсутність даних ніколи не означає відновлення; поки сервер offline, діє лише його alert; рестарти — лише дельта.
- Durable інциденти, cooldown проти flapping, необов'язкові нагадування.
- Outbox: lease, `SKIP LOCKED`, межа черги, backoff і `Retry-After`, at-least-once.
- Slack Incoming Webhook: лише `text`, екранування, allowlist host, без redirect, обмежене читання відповіді.
- Worker живе в API-процесі: старт в `onReady`, зупинка в `preClose`.
- API `GET /api/alerts`, `GET /api/alerts/status`; новий permission `alerts:manage` (admin).
- UI «Сповіщення»:
  - стан рушія й доставки — без «усе добре», коли вимкнено або невідомо;
  - активні інциденти й історія закритих зі сторінками;
  - стан доставки й панель конфігурації — лише для admin, значення webhook не показується.

**Перевірка документації Slack.** Перед реалізацією звірено з офіційною документацією docs.slack.dev: payload, успіх `200 ok`, коди помилок, ~1 повідомлення/с, 429 + `Retry-After`, екранування `& < >`, згадки.

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 421/421 (нові: `alerts-rules` 18, `alerts-delivery` 10, `alerts-api` 5, shutdown-regression 1), smoke 10/10, agent 164/164 (+3 opt-in), frontend 171/171 (нові `alerts` 6), typecheck, lint, збірки, `check:secrets` OK |
| Real-DB (`test:backend:db`) | 87/87, нові `db/alerts` 9: атомарні інцидент і outbox; повторна оцінка й «перезапущений» рушій нічого не додають; recovery; never_connected та неактивні сервери не дають alert; cooldown без сповіщення; доставка вимкнена → без outbox; переповнена черга → `dropped`; 6 паралельних оцінювань → без дублікатів; rollback через тригер; роздільні захоплення записів, повторне захоплення після простроченого lease, захист від запису застарілим власником; retention лише власних таблиць; сторінки списку; у таблицях немає webhook |
| UI Playwright | 2/2 |
| E2E (`test:e2e`, тестова БД, рушій увімкнено, доставку вимкнено) | 16/16 (+1 opt-in), новий `alerts.spec.ts`: справжній оцінювач створює інцидент для синтетичного сервера, що перестав звітувати; operator бачить його без деталей доставки; `admin: null`; outbox порожній; 390 px |
| Real-PM2 E2E | 1/1 |
| Залишки | 0 схем `nc_test_*`; PM2 daemon і `~/.pm2` відсутні |

Під час перевірок:
- Перший повний E2E упав у двох чинних тестах. Нова специфікація лишала синтетичний сервер, тепер прибирає його в `afterAll`. Також вичерпувався ліміт входів viewer (5/15 хв), тож вона входить як operator. Після виправлення — 16/16.
- Справжніх Slack-повідомлень не надсилалось: лише mock transport.

Обмеження:
- Доставка — at-least-once, можливі дублікати (короткий id інциденту в тексті).
- Стан рушія (час останньої оцінки) — у пам'яті процесу, після рестарту `null` до першого циклу.
- Ідентичність процесу для рестартів — `source:pm_id:name` + `first_seen_at`.
- Acknowledgement, silencing і редагування правил в UI не реалізовано.

**Деплой (2026-10-14, ~20:46 UTC, лише центральний сервер).** Deployed code revision: **`e8f61c56bd6028284865bdeb713c4b2715d05213`** (`feat(alerts): add persistent incidents and Slack notifications`). Цей запис — пізніший docs-commit, на сервер не деплоївся. Agent/broker не передеплоювались.

| Крок | Результат |
|---|---|
| Baseline | `control-server`; current `1c6c58d` (ціль rollback), previous `0b85151`; API active, ready 200; Nginx/PostgreSQL active, failed 0; `api.env` без змін (ключів `ALERTS_*` немає) |
| Артефакт | 57 файлів, SHA-256 `0641b18f…85492e` OK, manifest `e8f61c5`; unit без змін |
| Міграція | status: applied=6, pending=1 (`1791900000006_alerts`) → backup лише `node_control_db` (`node_control_db-20261014T204620Z-pre-e8f61c5….dump`, 600, `pg_restore --list` OK) → `up` → applied=7, pending=0; створено `alert_conditions`, `alert_incidents`, `alert_outbox` |
| Активація | `current` → `e8f61c5`, `previous` → `1c6c58d`; restart лише `node-control-api` |
| Graceful shutdown у production | Рестарт старого процесу (`1c6c58d`) знову дав `Shutdown failed or timed out` і `Failed with result 'exit-code'` (10 с) — це старий код. **Контрольний рестарт нового коду** через ~20 с роботи, з утримуваним long-poll Agent: 0,1 с, `Shutdown complete`, без `Failed` |
| Після деплою | API active (`nodecontrol`, лише `127.0.0.1:3100`); live/ready 200 локально й HTTPS; HTTPS `/`, `/alerts` 200; бандл = `current/frontend/dist`, містить «Сповіщення». Анонімні `/api/alerts`, `/api/alerts/status`, `/api/dashboard` → 401. Журнал нового процесу: 0 error/warn; `pm2ControlEnabled:true`, **`alertsEnabled:false`, `alertsDeliveryEnabled:false`**; у журналі немає `hooks.slack`; `nginx -t` OK |
| Стан alerts | Рушій і доставка вимкнені; `alert_incidents` = 0, `alert_outbox` = 0, `alert_conditions` = 0. Webhook не налаштовано, повідомлень не надсилалось |
| Agent / PM2 | Після двох рестартів API Agent відновився (heartbeat 4 с, control 0 с, inventory ~40 с); керуючих дій не було; production-користувачі без змін (2, 1 активний admin) |
| Rollback | не застосовувався. Спершу `ALERTS_DELIVERY_ENABLED=false`, якщо доставку вмикали, потім `server-release.js rollback` → `1c6c58d` + restart лише API; таблиці alerts лишаються, дані не видаляються |

Увімкнення — після погодження Slack-каналу й адресатів, за кроками розділу «Сповіщення» в [DEPLOYMENT](DEPLOYMENT.md): спершу лише `ALERTS_ENABLED=true` (інциденти в UI), потім доставка з webhook у `api.env`.

## Task 012 — Dashboard поточного стану системи (2026-10-14)

Стан на початок: `main` = `cd48ef8`; у робочому дереві — незакомічений запис review Codex (угорі документа), збережено й закомічено разом із задачею. Рішення — ADR-020. Міграцій немає.

**Backend.** `GET /api/dashboard` (`monitoring:read`, read-only, без audit):
- Один узгоджений знімок: транзакція `REPEATABLE READ READ ONLY`, усі вікна свіжості від одного `now()` = `generatedAt`.
- Точні агрегати всіх записів: сервери за статусами, неактивні окремо; inventory за станами; live-процеси за групами; `notLive`.
- Обмежені списки з точним `total`: `attentionServers` ≤ 20, `attentionProcesses` ≤ 20, `serverList` ≤ 50.
- `recentActions` ≤ 10 лише для `processes:control`: для viewer — `null`, і запит до команд не виконується. Без id чи email ініціатора (лише `requestedByMe`), результатів PM2, логів і audit details. `overdue` для pending після дедлайну, без мутацій.
- SQL параметризований; з'єднання 1:1 за PK `server_id`; лічильники процесів сервера — `LEFT JOIN LATERAL`; без N+1. Нових індексів немає (обґрунтування в ADR-020).
- Строга response-схема: nullable-об'єкти через `type: ['object', 'null']`, бо з `anyOf` зайве поле давало 500 замість відкидання. Помилка БД → 503 + `Retry-After` без тексту.

**Frontend.** «Огляд» (`DashboardPage`, замість статичного привітання):
- Шапка з часом останньої успішної відповіді й «Оновити».
- 5 підсумкових карток:
  - сервери онлайн з активних (неактивні — окремою приміткою);
  - «не звітують» = офлайн + без першого звіту;
  - PM2-процеси зараз (лише live);
  - проблемні сервіси;
  - неактуальні дані.
- «Потребують уваги»: сервери з причиною словами й сервіси з проблемним статусом, без дублювання; «Показано N з M».
- Таблиця серверів:
  - стан, останній сигнал, uptime;
  - load average 1/5/15 з поясненням «не відсоток CPU»;
  - пам'ять ОС зі смужкою знімка (не історія);
  - сервіси PM2 зі свіжістю.

  Метрики офлайн-сервера — «—»; `totalBytes = 0` → пам'ять невідома.
- «Останні керуючі дії» для operator/admin.
- Polling 15 с, лише коли вкладка видима. Хук polling тепер дає `refreshing` і локальний `receivedAt`. Після помилки показуються останні відомі дані з явною позначкою; дані, старші за online-вікно, приглушуються й позначаються як неактуальні.
- Колір не єдиний носій статусу (текстові бейджі). Скриншоти з синтетичними даними: `dashboard.spec.ts` за `NC_E2E_SCREENSHOT_DIR`; за замовчуванням вимкнено.

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 387/387 (нові `dashboard-api` 7), smoke 10/10, agent 164/164 (+3 opt-in), frontend 165/165 (нові `dashboard` 8), typecheck, lint, збірки, `check:secrets` OK |
| Real-DB (`test:backend:db`) | 78/78, зокрема нові `db/dashboard` 6: порожня система; статуси, стани inventory, live/notLive, неактивні виключено, без множення рахунків; межі свіжості 85/95 с і 175/185 с; 60+ серверів і 30 проблемних процесів — точні `total`, обмежені списки, детермінований порядок; дії лише за запитом, `requestedByMe`, `overdue`, GET нічого не змінює; READ ONLY транзакція |
| UI Playwright (1440/390) | 2/2 |
| E2E (`test:e2e`, тестова БД) | 15/15 (+1 opt-in), нові `dashboard.spec.ts` 2: operator бачить синтетичні сервери, метрики, «Потребують уваги», останні дії й переходи; viewer — без деталей дій в UI та API (`recentActions: null`), 390 px без горизонтального скролу |
| Real-PM2 E2E | 1/1 (керування й логи без регресій) |
| Залишки | 0 схем `nc_test_*`; PM2 daemon і `~/.pm2` відсутні |

Під час розробки один прогін E2E упав на `pg` «timeout expired» у global-setup: SSH-тунель до тестової БД завис. Після перепідключення тунелю — зелено. Це проблема середовища, не коду.

Обмеження:
- `recentActions` сортує `control_commands` без окремого індексу: таблиця мала; за зростання додати `(requested_at DESC, id DESC)`.
- Таблиця серверів показує ≤ 50 активних за назвою; повний список — «Сервери».
- Історії метрик немає (наступні задачі).

**Деплой (2026-10-14, ~19:25 UTC, лише центральний сервер).** Deployed code revision: **`1c6c58df90083438cf2000a60c63ebe1c38e7eaa`** (`feat(dashboard): add live system overview and attention lists`). Цей запис — пізніший docs-commit, на сервер не деплоївся. Agent/broker не передеплоювались.

| Крок | Результат |
|---|---|
| Baseline | `control-server`; current `0b85151` (ціль rollback), previous `ac4d967`; API active, ready 200; Nginx/PostgreSQL active, failed 0; `api.env` без змін |
| Артефакт і активація | 51 файл, SHA-256 `b5e750d5…b074bc` OK, manifest `1c6c58d`; unit без змін; міграції applied=6, pending=0 (нових немає). `current` → `1c6c58d`, `previous` → `0b85151`; restart лише `node-control-api` |
| Після деплою | API active (`nodecontrol`, лише `127.0.0.1:3100`); live/ready 200 локально й HTTPS; HTTPS `/` 200; бандл = `current/frontend/dist`, містить Dashboard. Анонімний `GET /api/dashboard` → 401, bearer → 401, `POST /api/dashboard` → 404 (маршруту немає); `/api/auth/me` → 401; `pm2ControlEnabled:true` без змін; `nginx -t` OK. Новий процес — 0 error/warn |
| Agent / PM2 | heartbeat 5 с, control status 10 с, inventory 29 с — звіти надходять; керуючих дій не було |
| Відоме | Старий процес (`0b85151`) знову не завершився за 10 с (`Shutdown failed or timed out`, systemd `Failed with result 'exit-code'`). Це той самий дефект long-poll Agent у graceful shutdown (див. Task 011.1), не код Task 012; новий процес стартував штатно. Окрема задача з `preClose` — рекомендована перед production-підготовкою |
| Production-дані | Користувачі, паролі, сервери й процеси не змінювались (2 користувачі, 1 активний admin). Автентифікований smoke Dashboard у production не виконувався (без production credentials); агрегати перевірено real-DB і E2E на тестовій БД |
| Rollback | не застосовувався. `server-release.js rollback` → `0b85151` + restart лише API; схема й дані без змін |

## Task 011.2 — оновлення актуальної сторінки після створення користувача (2026-10-14)

Стан на початок: `main` = `034794c`; у робочому дереві — незакомічений запис review Codex (Task 011.1, угорі документа), збережено й закомічено разом із виправленням. Backend, SQL і міграції не змінювались.

**P2 — успіх створення перезавантажував покинуту сторінку.**
- Причина: `CreateUserForm` після `await` викликав `onCreated`, захоплений у render, де стартував POST. Його `data` і `reload` належали старому курсору. Пагінація під час створення дозволена, форма лишається змонтованою, сесія та сама — тож auth binding і abort цього не ловили. Старий `reload` записував дані попереднього ключа в keyed resource: номер «Сторінка 2», а рядки зникали до наступного polling.
- Виправлення (мінімальне, без блокування пагінації): форма тримає **актуальний** callback у ref, що оновлюється після кожного render, і після успіху викликає саме його.
  - Рішення «новий користувач видно тут чи потрібне „Показати"» приймається за даними поточної сторінки.
  - `reload` — keyed reload поточного курсора.
  - Session binding, abort, відсутність автоповторів, bounded «Показати» (≤ 50 сторінок) і поведінку після PATCH збережено.
- Інші callbacks того самого класу перевірено:
  - `UsersPage.submit` (PATCH): пагінація й закриття діалогу заблоковані, поки він pending.
  - «Показати»: пагінація заблокована під час пошуку; курсори додаються функціональним оновленням.
  - `ServersPage`: ключ ресурсу фіксований.
  - `ProcessControl` і `CredentialControls`: перемонтовуються з ключем сервера.
  - `ServerDetailPage`: бере актуальний `reload` через effect.
  - Змін там не потрібно.

**Regression-тести (`users-paging.test.tsx`, «create while paging», 6, deferred POST):**

| Тест | Старий код (`ac4d967`) | Виправлений |
|---|---|---|
| Сторінка 1 → pending create → «Далі» → пізній успіх: рядки сторінки 2 на місці, перезавантажено лише її курсор, «Показати» веде на сторінку 3 | падає (GET без `after`) | ✓ |
| Сторінка 2 → pending create → «Назад» → пізній успіх: оновлено сторінку 1 | падає (GET зі старим курсором) | ✓ |
| Помилка створення після переходу: список той самий, жодного reload чи вигаданого рядка | ✓ (захисний) | ✓ |
| Logout і нова сесія під час POST: немає callback, повідомлення чи reload | ✓ (захисний) | ✓ |
| Перехід на останню сторінку з місцем → пізній успіх: показано там після reload цієї сторінки, без «Показати», один POST | падає (рішення за старими даними) | ✓ |
| «Показати» обходить обмежену кількість сторінок і зупиняється на останній | ✓ (захисний) | ✓ |

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 380/380, smoke 10/10, agent 164/164 (+3 opt-in), frontend 157/157, typecheck, lint, збірки, `check:secrets` OK |
| UI Playwright (1440/390) | 2/2 |
| E2E (`test:e2e`, тестова БД) | 13/13 (+1 opt-in), зокрема 3/3 `users.spec.ts` |
| Real-DB, real-PM2 E2E | не повторювались: backend, Agent і broker не змінювались |
| Залишки | 0 схем `nc_test_*`; PM2 daemon відсутній |

Межі: гонку «POST затримано, поки користувач гортає сторінки» відтворено детерміновано лише у frontend-тестах з deferred-відповіддю. У справжньому E2E затримку POST не моделювали.

**Деплой (2026-10-14, ~18:07 UTC, лише центральний сервер).** Deployed code revision: **`0b851511612096c05ba7825b15ab6c51f50975e7`** (`fix(users): refresh the current page after user creation`). Цей запис — пізніший docs-commit, на сервер не деплоївся. Agent/broker не передеплоювались.

| Крок | Результат |
|---|---|
| Baseline | `control-server`; current `ac4d967` (ціль rollback), previous `20896dd`; API active, ready 200; Nginx/PostgreSQL active, failed 0; `api.env` без змін |
| Артефакт і активація | 49 файлів, SHA-256 `ee0fa434…bc196a` OK, manifest `0b85151`; unit без змін; міграції applied=6, pending=0; `backend/dist` ідентичний попередньому релізу (лише frontend). `current` → `0b85151`, `previous` → `ac4d967`; restart лише `node-control-api` (старий процес завершився штатно за ~1 с) |
| Після деплою | API active (`nodecontrol`, лише `127.0.0.1:3100`); live/ready 200 локально й HTTPS; HTTPS `/`, `/users` 200; бандл = `current/frontend/dist`. Анонімні `GET/POST /api/users`, `PATCH /api/users/:id`, `POST /api/auth/change-password` → 401. Журнал із restart: 0 error/fatal, 0 warn; `pm2ControlEnabled:true` без змін; `nginx -t` OK (конфіг не змінювався). Heartbeat Agent — 20 с |
| Production-дані | Користувачі й паролі не змінювались (2 користувачі, 1 активний admin — як до деплою) |
| Rollback | не застосовувався. `server-release.js rollback` → `ac4d967` + restart лише API; БД, паролі й сесії не відкочуються |

Відкрите з Task 011.1: graceful shutdown API чекає на long-poll Agent (`LogHub.close()` в `onClose`). Пропозиція — окрема задача із закриттям у `preClose`.

## Task 011.1 — запізнілі відповіді між сесіями та пагінація користувачів (2026-10-14)

Стан на початок: `main` = `2ce89c7`; у робочому дереві — незакомічений запис review Codex (Task 011, угорі документа), збережено й закомічено разом із виправленням. Backend і схема не змінювались.

**P2-1 — запізнілий успіх зміни пароля скидав нову сесію.**
- Причина: `AccountPage` після `await` викликав `passwordChanged()` без перевірки скасування та актуальності сесії. `apiRequest` повертав успішний 204/JSON навіть тоді, коли відповідь надійшла вже після abort: реальний `fetch` зазвичай відхиляє Promise, але transport може завершитися пізніше.
- Виправлення:
  - `apiRequest` перевіряє abort і timeout після відповіді, після читання й валідації тіла та перед поверненням результату;
  - `AuthContext.bindSession()` фіксує auth epoch; logout, завершення сесії й новий вхід його змінюють;
  - `passwordChanged(binding)` для застарілої прив'язки нічого не робить;
  - `AccountPage`, `CreateUserForm`, `UsersPage.submit` і новий пошук сторінки перевіряють `aborted || !binding.current()` після **кожного** `await` перед будь-яким побічним ефектом (стан, callback, reload, `sessionExpired`).
- Abort лише перестає чекати; серверна мутація могла відбутися, і UI цього не заперечує. Штатна зміна пароля працює як раніше.

**P2-2 — недоступні користувачі після перших 100.**
- Причина: `usersApi.list` не передавав курсор, а UI лише повідомляв про перших 100.
- Виправлення:
  - `usersApi.list(after)` з валідованим UUID-курсором (не email).
  - Сторінки по 100: «Назад»/«Далі» з номером сторінки, стек курсорів; останню сторінку видно за вимкненим «Далі».
  - Ресурс keyed за курсором: дані попередньої сторінки не показуються як нова, запізніла відповідь покинутої сторінки відкидається, помилка сторінки має «Спробувати ще раз».
  - Мутації перезавантажують ту саму сторінку.
  - Створення: якщо новий користувач не на поточній сторінці, повідомлення каже «наприкінці списку» з кнопкою «Показати <email>» — вона проходить ≤ 50 сторінок від поточної (bounded, скасовується при виході) і відкриває сторінку з ним. Невдале створення рядка не додає.
  - Одна таблиця з меню «Дії»; власний рядок без дій; logout чи нова сесія починають зі сторінки 1 без діалогів. Backend-контракт не змінено.

**Regression-тести — спершу проти старого коду, потім виправленого:**

| Тест | Старий код (`20896dd`) | Виправлений |
|---|---|---|
| `client.test.ts` «cancellation on the success path» (3: 204 після abort, JSON після abort, успіх після timeout) | 3/3 падають (успіх повертається) | 3/3 |
| `users.test.tsx` «stale responses across sessions» (4: unmount → пізній успіх; logout → новий вхід → пізній успіх старої форми; пізня помилка 409; create/update після виходу зі сторінки) | 3/4 падають (сесію скинуто; reload після unmount). Пізня помилка вже була захищена — тест лишено як regression | 4/4 |
| `users-paging.test.tsx` (8: 230 користувачів, курсор, остання сторінка, «Назад»; запізніла відповідь покинутої сторінки; помилка наступної сторінки й retry; керування на сторінці 2 й reload тієї ж сторінки; створення при повній першій сторінці + «Показати»; невдале створення без вигаданого рядка; власний рядок і нова сесія зі сторінки 1; клавіатура) | 7/8 падають (немає пагінації). Тест невдалого створення проходить і на старому коді | 8/8 |
| E2E `users.spec.ts` «more than 100 users» (105 синтетичних користувачів у per-run схемі; 1440 і 390 px; сторінка 2, деактивація там, «Назад», створення + «Показати», клавіатура) | — (новий сценарій) | 1/1 |

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 380/380, smoke 10/10, agent 164/164 (+3 opt-in), frontend 151/151, typecheck, lint, збірки, `check:secrets` OK |
| UI Playwright (1440/390) | 2/2 |
| E2E (`test:e2e`, тестова БД) | 13/13 (+1 opt-in). Перший прогін нового сценарію впав через помилку самого тесту: `goto('/users')` переривав ще не завершений вхід. Додано очікування завершення входу; повторно — 13/13 |
| Real-DB, real-PM2 E2E | не повторювались: backend, транзакції, Agent і broker не змінювались (останні результати — Task 011: 72/72 і 1/1) |
| Залишки | 0 схем `nc_test_*`; PM2 daemon відсутній |

**Деплой (2026-10-14, ~17:49 UTC, лише центральний сервер).** Deployed code revision: **`ac4d967679a723db04185f04f2cdd4e1b6a1d259`** (`fix(users): guard stale mutations and paginate user administration`). Цей запис — пізніший docs-commit, на сервер не деплоївся. Agent/broker не передеплоювались.

| Крок | Результат |
|---|---|
| Baseline | `control-server`; current `20896dd` (ціль rollback), previous `2fe4d95`; API active, ready 200; Nginx/PostgreSQL active, failed 0; `api.env` без змін |
| Артефакт і активація | 49 файлів, SHA-256 `82cb05ec…57f29f` OK, manifest `ac4d967`; unit без змін; міграції applied=6, pending=0 (нових немає); `backend/dist` ідентичний попередньому релізу (змінено лише frontend). `current` → `ac4d967`, `previous` → `20896dd`; restart лише `node-control-api` |
| Після деплою | API active (`nodecontrol`, лише `127.0.0.1:3100`); live/ready 200 локально й HTTPS; HTTPS `/`, `/users`, `/account` 200; бандл = `current/frontend/dist`, містить пагінацію. Анонімні `GET /api/users` (з курсором), `POST /api/users`, `PATCH /api/users/:id`, `POST /api/auth/change-password`, `/api/auth/me` → 401; чужий Origin → 403 (1 warn — саме ця перевірка); `pm2ControlEnabled:true` без змін; `nginx -t` OK. Новий процес — 0 error |
| Agent | Після restart Agent короткочасно отримав `unavailable` і відновився (heartbeat accepted, control і logs poll ok); heartbeat 8 с при повторній перевірці |
| Знайдено | **Старий процес (`20896dd`) не завершився за 10 с** (`Shutdown failed or timed out`, exit 1, systemd `Failed with result 'exit-code'`); новий стартував штатно. Причина: на момент зупинки був відкритий long-poll Agent `/api/agent/logs/poll` (утримання до 25 с). `LogHub.close()` викликається в `onClose`, а Fastify викликає `onClose` лише після завершення активних запитів, тож shutdown чекає на long-poll. Дефект існує з Task 010; із 9 рестартів у журналі з 2026-10-13 проявився лише цей. Виправлення (звільняти long-poll/waiters у `preClose`) — окремою задачею; на роботу нового релізу не впливає |
| Production-дані | Деплой і перевірки не змінювали користувачів. Між деплоями Task 011 і 011.1 через UI створено одного користувача (operator, 17:20 UTC, audit `user.created`) — дія користувачів системи, не цієї задачі. Зараз 2 користувачі, 1 активний admin |
| Rollback | не застосовувався. `server-release.js rollback` → `20896dd` + restart лише API; БД, hashes і відкликані сесії не відкочуються |

## Task 011 — користувачі, ролі та зміна власного пароля (2026-10-14)

Стан на початок: `main` = `f0b320c`; у робочому дереві — незакомічений запис повторного review Codex (Task 010.1), збережено й закомічено разом із задачею. Рішення — ADR-019.

**Реалізовано:**
- **API.**
  - `GET/POST /api/users`, `PATCH /api/users/:id` (`users:manage`, Origin + CSRF).
  - `POST /api/auth/change-password` (будь-яка сесія, Origin + CSRF).
  - Строгі схеми; UUID у params; whitelist ролі й полів PATCH; порожній PATCH → 400. `isActive` — лише справжній JSON boolean: Ajv-коерсію `"false"` відсікає `preValidation`.
  - Keyset-пагінація `(created_at, id)`. Чинна політика email/пароля. Відповідь — лише `{id,email,role,isActive,createdAt,updatedAt}`.
- **Гонки.** Нова колонка `users.credential_version`; зміна пароля, ролі чи активності в одній транзакції збільшує версію, відкликає всі сесії користувача й пише audit.
  - Зміна пароля: scrypt поза транзакцією через спільний limiter, потім compare-and-set на прочитаній версії. Із двох одночасних змін проходить одна, друга отримує 409.
  - Вхід: створення сесії під `FOR SHARE` перевіряє активність і версію. Запізнілий вхід після зміни пароля, ролі чи деактивації → 401 `stale_credentials`.
  - Адмінські мутації — під `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`, з повторною перевіркою актора (сесія + активний admin) під блокуванням. Взаємне пониження двох admin: один отримує 401, лишається один активний admin. Власну роль чи активність змінити не можна (403). Останнього активного admin зняти не можна (409). No-op нічого не пише.
- **Audit.**
  - Успіх — у тій самій транзакції: `user.created`, `user.role_changed`, `user.deactivated`/`user.activated`, `auth.password_change` (success).
  - Відмови — best-effort: `user.create_rejected`, `user.update_rejected`, `auth.password_change` (failure), `auth.login` failure `stale_credentials`.
  - Лише id, ролі, лічильник `sessionsRevoked` і server-defined reason; без email, паролів і hash.
- **Ліміти.** Зміна пароля — 5 спроб / 15 хв на користувача; адмінські мутації — 30/хв на актора; hashing — спільний bounded limiter (переповнення → 503 + `Retry-After: 1`).
- **UI.**
  - «Обліковий запис» для всіх ролей: email, роль, форма з трьох полів, autocomplete, кнопка показу (`aria-pressed`), inline-валідація, попередження про завершення сесій. Після успіху — login з повідомленням «Пароль змінено…».
  - «Користувачі» лише з `users:manage` (прямий route — «Недостатньо прав»): одна таблиця в стилі сервісів, створення, меню «Дії» → зміна ролі або деактивація/активація з підтвердженням. Власний рядок позначено «Ви», без дій, з поясненням.
  - Мутації не повторюються; pending блокує повтор і закриття діалогу; запізнілі відповіді після unmount ігноруються.
  - Спільний `ActionMenu` винесено з `ProcessControl`. Журнал аудиту показує нові події.
- **Міграція** `1791900000005_user-credential-version` — additive (колонка з default 1 + індекс). Сумісна з попереднім релізом.

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 380/380 (нові `users-api` 22), smoke 10/10, agent 164/164 (+3 opt-in), frontend 136/136 (нові `users` 21), typecheck, lint, збірки, `check:secrets` OK |
| Real-DB (`test:backend:db`) | 72/72, зокрема нові `db/users` 12: міграція й default, атомарність і rollback через тригер, що ламає audit; гонка дублікатів; взаємне пониження й деактивація двох admin; цикл трьох admin; дві одночасні зміни пароля (CAS); вхід проти закомітченої та **незакомітченої** зміни (утримання row lock); вхід, що закомітився раніше, відкликається; деактивація проти запізнілого входу; HTTP-гонка змін пароля |
| UI Playwright (1440/390) | 2/2 |
| E2E (`test:e2e`) | 12/12 (+1 opt-in), нові 2: admin створює користувача → вхід у двох сесіях → зміна пароля → обидві сесії завершено → старий пароль відхилено, новий працює → зміна ролі та деактивація завершують сесії → audit без паролів і email; mobile 390 px, клавіатура, Escape, фокус |
| Real-PM2 E2E | 1/1 (керування й логи без регресій) |
| Залишки | PM2 daemon і `~/.pm2` відсутні; 4 схеми `nc_test_*` від перерваного прогону видалено (лише тестова БД, за шаблоном), лишилось 0 |

Аномалія: в одному з проміжних прогонів real-DB три тести `db/control` впали з тайм-аутами 15 с, а хуки `db/auth` і `db/users` не відпрацювали — звідси 4 залишкові схеми. Зависших транзакцій у тестовій БД не було. У двох наступних повних прогонах — 72/72; причину (ймовірно, мережа SSH-тунелю) не встановлено.

Обмеження: UI показує перші 100 користувачів (API підтримує keyset-курсор, «показати ще» не реалізовано). Admin-reset пароля, MFA, зміна email і фізичне видалення — поза scope.

**Деплой (2026-10-14, ~16:07 UTC, лише центральний сервер).** Deployed code revision: **`20896ddcb0c70f22cb101ba539cac048c333513a`** (`feat(users): add user administration and self-service password change`). Цей запис — пізніший docs-commit, на сервер не деплоївся. Код Agent/broker не змінювався — ноду не передеплоєно (Agent/broker лишаються на `2fe4d95`).

| Крок | Результат |
|---|---|
| Baseline | `control-server`; current `2fe4d95` (ціль rollback), previous `401667e`; API active, ready 200; Nginx/PostgreSQL active, failed 0; `api.env` без змін (mtime 2026-10-13 13:41:44) |
| Артефакт | 49 файлів, SHA-256 `de925478…22a0f85` OK, manifest `20896dd`; unit без змін |
| Міграція | status: applied=5, pending=1 (`1791900000005_user-credential-version`) → backup лише `node_control_db` (`/root/node-control-backups/node_control_db-20261014T160708Z-pre-20896dd….dump`, 600, `pg_restore --list` OK) → `up` → applied=6, pending=0; 1 наявний користувач отримав `credential_version = 1` |
| Активація | `current` → `20896dd`, `previous` → `2fe4d95`; restart лише `node-control-api` |
| Після деплою | API active (`nodecontrol`, лише `127.0.0.1:3100`); live/ready 200 локально й HTTPS; HTTPS `/`, `/users`, `/account` 200; бандл = `current/frontend/dist`, містить нові сторінки. Анонімні `GET/POST /api/users`, `PATCH /api/users/:id`, `POST /api/auth/change-password` (з Origin), `/api/auth/me`, `…/log-targets` → 401; `POST /api/users` без Origin або з чужим Origin → 403. Журнал із restart: 0 error/fatal, 2 warn — це саме ті дві навмисні відмови за Origin; `pm2ControlEnabled:true` без змін; `nginx -t` OK (конфіг не змінювався) |
| Agent / PM2 | Agent, broker і exporter timer active; під час restart API Agent короткочасно отримав `unavailable` і відновився (heartbeat, control і logs poll ok, 0 warn/error). Свіжість у БД: heartbeat 7 с, control 5 с, inventory 24 с. 5 PM2-процесів online, restarts 0; керуючі дії не виконувались |
| Без змін | Production-користувачі й паролі не створювались і не змінювались (1 користувач, 1 активний admin, 0 подій `user.*`/`auth.password_change`); allowlist, credentials Agent, HBA/firewall і сторонні служби не змінювались |
| Rollback | не застосовувався. `server-release.js rollback` → `2fe4d95` + restart лише API; колонка `credential_version` лишається (старий реліз її не читає); змінені паролі не повертаються, відкликані сесії не відновлюються |

Ручна перевірка оператора (під власною сесією): «Обліковий запис» — email/роль; «Користувачі» — таблиця з одним рядком «Ви». Мутації в production не виконувати без потреби.

## Task 010.1 — ресурсні ліміти перегляду логів (2026-10-14)

Стан на початок: `main` = `de7d395`; у робочому дереві — незакомічений запис review Codex (Task 010) і узгоджений roadmap; збережено й закомічено разом із виправленням. Read-only перевірка ноди: allowlist 5 targets, 5 з `logs: true`, змінено 2026-10-14 12:48:29 UTC — це ввімкнення на запит користувача, задокументоване в `de7d395` (початковий звіт деплою `af89119` описував стан до нього). Allowlist і дозволи в цій задачі не змінювались.

**P2-1 — broker звільняв слот до завершення читання.** Причина: `handleLogs` робив `Promise.race(readLogs, timeout)` і зменшував лічильник у `finally`. Timeout відповідав клієнту, але файлові/PM2-виклики `readLogs` тривали (вони не скасовуються), тож після кожного timeout могло стартувати ще одне читання понад ліміт. Виправлення (`agent/src/control/broker.ts`):
- слот звільняється у `finally` самого `readLogs` — рівно один раз, при resolve або reject;
- timeout лише відповідає клієнту `timeout` (≤ 5 с, без змін);
- осиротілий Promise має `.catch`: пізній reject не стає unhandled і не дає другої відповіді;
- поки обидва слоти зайняті — `broker_busy`, черги немає; керування процесами (окремий ланцюжок) не зачеплене;
- зависання видно як metadata: `log read overdue` (requestId, inFlight, overdue) і `log read settled late` (durationMs); `createBroker` повертає `logStats()` {inFlight, overdue}.

**P2-2 — необмежені очікувачі результату в API.** Причина: `LogHub.get` додавав waiter і таймер на кожен GET без ліміту, а маршрут не прибирав waiter при відключенні клієнта. Виправлення (`backend/src/servers/logs.ts`, `logs-routes.ts`):
- `LOG_LIMITS.maxWaitersPerRequest = 2` (UI тримає ≤ 1 GET на відкритий переглядач без перекриття; 2 — запас на reconnect), `maxWaitersPerActor = 3` (друга вкладка), `maxWaiters = 100` (глобально; таймери/сокети з запасом над очікуваною кількістю операторів);
- ліміти перевіряються після перевірки власника (чужий/невідомий запит → 404 без деталей) і до створення waiter/таймера: 429 + `Retry-After: 1` (запит/актор), 503 + `Retry-After: 2` (глобально);
- кожен waiter завершується ідемпотентно (result, дедлайн, власний timeout, disconnect, shutdown) і звільняє таймер і лічильники рівно один раз;
- disconnect — `reply.raw` 'close' (не `request.raw`); спільний запит не скасовується, інші очікувачі не зачеплені;
- `stats()` — лише кількості (waiters, waitingActors, waitersInRequests).

**Regression-тести — спершу проти старого коду, потім виправленого:**

| Тест | Старий код (`401667e`) | Виправлений |
|---|---|---|
| Agent `broker log-read concurrency`: 2 завислі читання → timeout → 10 повторів; 5 циклів timeout; пізні resolve/reject; нове читання допускається; ліміт цілий; 0 unhandled; таймери не ростуть; журнал без тексту | падає: третє читання запустилося (`timeout` замість `broker_busy`) | 1/1 |
| Backend `result waiters (bounded)`, 6 тестів: 1000 GET одного запиту; per-actor/global, чужий/невідомий; disconnect/timeout/дедлайн/повторний cleanup; 50 циклів без накопичення; HTTP 429 + Retry-After, viewer 403, anonymous 401, чужий 404; справжній HTTP abort звільняє waiter до 8 с, наступний GET працює | 6/6 падають (зокрема зайвий GET → 200 замість 429; немає відмови `limit_request`) | 6/6 |

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 358/358, smoke 10/10, agent 164/164 (+3 opt-in), frontend 115/115, typecheck, lint, збірки, `check:secrets` OK |
| UI (`playwright -c e2e/ui.config.ts`) | 2/2 (1440/390 px) |
| Real-DB (`test:backend:db`) | 60/60 |
| E2E (`test:e2e`) | 10/10 (+1 opt-in) |
| Real-PM2 E2E (`test:e2e:pm2`, синтетичні логи, одноразовий `PM2_HOME`, тестова БД) | 1/1 |
| Залишки | 0 схем `nc_test_*`; PM2 daemon і `~/.pm2` відсутні |

Обмеження: операції `logTargets` і `list` (керування) не мають окремого ліміту на завислий PM2 `list()`; Agent викликає їх послідовно, по одній на цикл. Це поза scope задачі. Фронтенд не змінювався: 429 і 503 уже показуються без автоповтору.

**Деплой (2026-10-14).** Deployed code revision: **`2fe4d953f69bcf901bfaa73cc3d715a28264d446`** (`fix(logs): enforce read concurrency and result waiter limits`) — API/UI, Agent і broker. Цей запис — пізніший docs-commit, на сервери не деплоївся.

| Крок | Результат |
|---|---|
| Центральний (`control-server`) | Baseline current `401667e` (ціль rollback), previous `3ff4653`; API active, ready 200; Nginx/PostgreSQL active, failed 0. Артефакт API 46 файлів, SHA-256 `35e0ce51…261e9` OK, manifest `2fe4d95`; міграції pending=0; unit і `api.env` без змін. `current` → `2fe4d95`, `previous` → `401667e`; restart лише `node-control-api`. Agent-реліз центрального сервера активовано, unit вимкнений — не запускався |
| Після деплою (центральний) | API active (`nodecontrol`, лише `127.0.0.1:3100`); `/health/live`, `/health/ready` 200 локально й HTTPS; HTTPS `/` 200, бандл = `current/frontend/dist`; анонімні `…/log-targets`, `GET /api/log-requests/:id`, `POST …/log-requests` (з Origin), `/api/auth/me` → 401; `POST /api/agent/logs/poll` без токена → 401; журнал з restart: 0 error/fatal, `pm2ControlEnabled:true` без змін; `nginx -t` OK (конфіг не змінювався) |
| Нода `app-server` | Baseline Agent current `401667e` (ціль rollback), previous `b4ada6d`; allowlist 5 targets, 5 з `logs: true`. Артефакт Agent SHA-256 `01d7e5c2…b32c9` OK; `prepare --no-install`, 4 unit-файли без змін; `current` → `2fe4d95`, `previous` → `401667e`; restart broker, потім Agent |
| Після деплою (нода) | broker active (`logDirs:1`); Agent 0.4.0 active; heartbeat/inventory accepted; control poll ok (broker ok, targets 5); logs poll ok (broker ok, targets 5); 0 warn/error у журналах Agent і broker; exporter timer active |
| Без змін | SHA-256 allowlist, broker env і `agent.env` збігаються з baseline; God Daemon 3807, PID і час старту 5 PM2-процесів, статуси online і restarts 0 — без змін; `pm2` не запускався; listeners ноди без змін. Production-текст логів не читався |
| Rollback | не застосовувався. API: `server-release.js rollback --base /opt/goit-node-control` → `401667e` + restart API. Agent/broker: `rollback --base /opt/goit-node-control-agent` → `401667e` + restart broker і Agent (allowlist з `logs` сумісний із `401667e`; журнал дедуплікації broker не видаляти, БД не відкочувати) |

## Task 010 — обмежений авторизований перегляд логів сервісів (2026-10-14)

Стан на початок: `main` = `7eece06`; у робочому дереві — незакомічений запис незалежного review Codex (нижче, «Незалежний review Codex — об'єднана таблиця сервісів»). Його збережено й закомічено разом із задачею. Застарілі твердження ARCHITECTURE, на які вказав review, актуалізовано.

**Реалізовано (ADR-018):**
- **Канал.** UI → `POST /api/servers/:id/log-requests` (`logs:read` + Origin + CSRF) → запит у пам'яті API → вихідний long-poll Agent `POST /api/agent/logs/poll` (≤ 25 с) → broker (нові операції `logTargets`/`logs`) → `POST /api/agent/logs/result` → `GET /api/log-requests/:id` (лише ініціатор, чекає ≤ 8 с). Окремо від команд керування; не залежить від `PM2_CONTROL_ENABLED`; чинні контракти не змінено.
- **Права.** Новий permission `logs:read` (admin, operator; viewer — ні). Локально — `"logs": true` у записі allowlist (старий формат валідний; `"actions": []` можливий лише з `logs: true`).
- **Broker.**
  - Шляхи лише з `pm_out_log_path`/`pm_err_log_path` у `NC_BROKER_LOG_DIRS` (типово `<PM2_HOME>/logs`); відхиляються `..`, `/proc`, `/sys`, `/dev`, symlink у будь-якому компоненті (realpath), FIFO, не-файли.
  - `O_NOFOLLOW|O_NONBLOCK` і перевірка inode відкритого дескриптора; хвіст ≤ 256 KiB; ≤ 100 рядків; ≤ 8 KiB разом; кадр ≤ 32 KiB з урахуванням escaping.
  - Санітизація ANSI/керівних символів, обрізання довгих рядків, маскування відомих форматів секретів; ≤ 2 читання одночасно, ≤ 5 с.
- **API.** Bounded memory: ≤ 200 запитів, ≤ 2 очікуючих і ≤ 30/хв на актора, дедлайн 15 с, TTL результату 60 с, після restart усе втрачається. Audit `logs.view_opened` (не частіше ніж раз на 10 хв), `logs.view_denied`; текст ніде не зберігається й не логується. Ліміт machine-запитів на токен 20 → 90/хв.
- **Agent 0.4.0.** Окремий цикл logs (незалежний від heartbeat/inventory/control); старий broker → `unsupported`; старий API (404) → довга пауза; мінімум 1 с між порожніми poll.
- **UI.**
  - «Переглянути логи» у меню «Дії» рядка: лише з `logs:read` і для явно дозволеної цілі з тим самим ім'ям і PM2 id.
  - Діалог із вкладками stdout/stderr, ручним оновленням, автооновленням кожні 5 с (лише видима вкладка, без перекриття, зупиняється при помилці), часом отримання й поясненням обрізання.
  - Закриття, зміна сервера чи цілі та logout скасовують запити й очищають текст.
- **Попутно.** Журнал аудиту показує `targetKey`/`action` у details.

**Знайдено й виправлено під час перевірок:**
- **Busy loop у long-poll.** У Fastify `request.raw` 'close' спрацьовує одразу після читання тіла, тож long-poll завершувався миттєво. Agent опитував без пауз, вичерпував спільний ліміт на токен, і цикл керування переставав звітувати (real-PM2 E2E: «Broker давно не звітував»). Тепер відключення слухається на `reply.raw`. Додано регресійний тест через справжній HTTP: зі старим кодом падає. Агент тримає ≥ 1 с між порожніми poll.
- **Підказка про логи** не показувалась операторові (гілка керування).
- **`check:secrets`** спрацював на синтетичних фікстурах тесту маскування — вони тепер збираються під час виконання, сканер не послаблено.

| Перевірка (Node v22.23.3) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 352/352, smoke 10/10, agent 163/163 (+3 opt-in), frontend 115/115, typecheck, lint, збірки, `check:secrets` OK. Один попередній прогін дав 3 падіння frontend із аномальною тривалістю (141 с на тест) під навантаженням; у 4 наступних прогонах (окремо й у складі `check:local`) не відтворилося |
| Agent/broker (`agent/test/logs.test.ts`, 41) | старий/новий allowlist; 12 випадків guard шляхів; symlink файлу і каталогу, FIFO, каталог, відсутній, без прав; хвіст великого файлу; ANSI/OSC/керівні, довгі рядки, surrogate, некоректний UTF-8, CRLF, неповні рядки; 11 форматів маскування + PRIVATE KEY; бюджети й кадр з escaping; `readLogs` без шляхів/env/секретів; відмови (немає дозволу, не в allowlist, fingerprint, ambiguous, cluster, daemon, allowlist, дедлайн); реальний сокет; старий broker → unsupported; 404 → 900 с; захист від busy loop |
| API (`backend/test/logs-api.test.ts`, 10) | viewer 403 (+authz.denied), anonymous 401, operator/admin; Origin/CSRF; bearer на browser-маршруті; строгий body; not connected/unsupported/не дозволено → 409 (+view_denied); повний цикл; чужий користувач → 404; чужий сервер → 404; дубль → 409; oversize → 413; дедлайн → expired, пізній результат → 409; TTL і cleanup; ліміти 503/429; троттлінг audit; long-poll утримується через справжній HTTP; текст відсутній у логах і audit |
| Frontend (`frontend/test/logs.test.tsx`, 12) | меню і діалог; текст як текст (XSS); CSRF; вкладки; ручне й автооновлення раз на 5 с; вимкнення; viewer без колонки; 5 станів без пункту з поясненням; 409 без повтору; закриття під час запиту — запізніла відповідь не з'являється; A→B закриває; кінець сесії; жодних записів у storage |
| Браузер (`playwright -c e2e/ui.config.ts`) | 2/2 (1440/390 px): меню → логи → текст, вкладки, без горизонтального скролу, Escape, фокус на тригері, жодних команд |
| Real-DB (`test:backend:db`) | 60/60 (схема не змінювалась). Перший прогін упав через обрив SSH-тунелю й лишив 9 схем `nc_test_*` — видалено (лише тестова БД, за шаблоном), прогін повторено з keepalive |
| E2E (`test:e2e`) | 10/10 (+1 opt-in) |
| Real-PM2 E2E (`test:e2e:pm2`, тестова БД, одноразовий `PM2_HOME`) | 1/1: керування як раніше + оператор відкриває логи дозволеного процесу (stdout з замаскованим паролем, stderr), інший процес «Логи не дозволені», viewer: API → 403, audit — лише `logs.view_opened` без тексту, 0 збігів тексту/секрету в audit |
| Залишки | 0 схем `nc_test_*`; PM2 daemon і `~/.pm2` відсутні |

Не покрито автотестом: детермінована підміна inode між `lstat` і `open` (гонка; код її відсікає порівнянням inode/dev відкритого дескриптора).

**Деплой (2026-10-14, ~12:2x–12:4x UTC).** Deployed code revision: **`401667e653ed80f395a17a2ffa1c12657b9c9079`** (`feat(logs): add bounded authorized service log viewing`) — API/UI, Agent і broker (один артефакт). Цей запис — пізніший docs-commit, на сервери не деплоївся. Production-читання логів **вимкнене**: жодного `logs: true` в allowlist (окремого погодження сервісів у сесії не було).

| Крок | Результат |
|---|---|
| Центральний (`control-server`) | Baseline current `3ff4653`, previous `b4ada6d`. Артефакт API 46 файлів, SHA-256 `9a656028…7d692` OK; міграції pending=0; unit без змін. `current` → `401667e`, `previous` → `3ff4653`; restart лише `node-control-api`; `pm2ControlEnabled:true` (без змін). Agent-реліз центрального сервера активовано, unit вимкнений — не запускався |
| Після деплою (центральний) | `/health/live`, `/health/ready` 200 (локально й HTTPS); HTTPS `/` 200; публічний бандл = `current/frontend/dist`, містить «Переглянути логи»; анонімні `GET …/log-targets`, `GET /api/log-requests/:id`, `POST …/log-requests` (з Origin) → 401, без Origin → 403; `POST /api/agent/logs/poll` без токена → 401; журнал API: 0 error/fatal |
| Нода `app-server` | Baseline Agent `b4ada6d`; backup `agent.env` (600), broker env і allowlist (`*.bak-20261014T123303Z`); allowlist без `logs`. Артефакт Agent SHA-256 `7a95410a…be9b6` OK; `prepare --no-install`, 4 unit-файли без змін; `current` → `401667e`, `previous` → `b4ada6d`; restart broker, потім Agent |
| Після деплою (нода) | broker active, `broker started` з `logDirs:1`; Agent active, `version 0.4.0`; heartbeat/inventory accepted; control poll ok, broker ok, targets 5; logs poll ok, broker ok, **targets 0**; 0 warn/error у журналах Agent і broker; exporter timer active |
| PM2 без змін | God Daemon 3807; PID і час старту 5 процесів (6 жовтня) збігаються з baseline; статуси online, restarts 0 — без змін; `pm2` не запускався; listeners ноди без змін |
| Rollback | не застосовувався. API: `server-release.js rollback --base /opt/goit-node-control` → `3ff4653` + restart API. Agent/broker: якщо в allowlist уже з'явилось `logs` — спершу повернути allowlist із backup, потім `rollback --base /opt/goit-node-control-agent` → `b4ada6d` + restart broker і Agent |

**Увімкнення читання логів (2026-10-14, ~12:48 UTC).** Користувач погодив логи для проєктів `app-server` («включи логи для проектів»). Backup `ubuntu.allowlist.json.bak-20261014T124829Z`; усім 5 записам (catalog-api, billing-api, orders-api-v2, orders-api, public-api) додано `"logs": true`, `actions` без змін; файл `root:root 644`. Broker перечитав allowlist без restart: logs poll ok, broker ok, targets 5; 0 warn/error у журналах Agent і broker. Production-текст логів не читався. Rollback: повернути allowlist із backup (без restart).

Увімкнення читання (оператор, після погодження конкретних сервісів) — розділ «Перегляд логів» у [DEPLOYMENT](DEPLOYMENT.md): backup allowlist → `"logs": true` для погоджених `targetKey` → `install -m 644 -o root -g root`; restart не потрібен. Ручна перевірка UI під сесією — за оператором; production-текст логів у звіти не копіювати.

## Frontend: одна таблиця сервісів із діями (2026-10-13)

Зміни підготував Codex за запитом користувача; я переглянув їх, виправив недоліки й перевірив. API, Agent, broker, міграції й production-конфігурація не змінювались.

**Що змінилось:**
- На сторінці сервера inventory і керування об'єднані в одну таблицю «Сервіси сервера» з колонкою «Дії» (лише для `processes:control`). Окремого списку керування немає.
- Зведення «Усього / Працюють / Потребують уваги» за останнім збором; оновлені кольори й бейджі; mobile-верстка.
- Меню «Дії» з'являється лише для рядка, якому відповідає рівно одна ціль broker з тим самим **ім'ям і PM2 id**. Ціль ніколи не виводиться з inventory.
- Меню вимкнене, якщо inventory не `current`, сервер не онлайн, broker недоступний чи застарілий, daemon або allowlist не `ok`, триває запит або є незавершена команда. Показуються лише `target.actions`.
- Меню — звичайний потік (не absolute), тож не обрізається на mobile. Escape і клік поза меню закривають його з поверненням фокуса.
- Збережено підтвердження з сервером/процесом/ціллю, CSRF, ключ idempotency на діалог, жодних автоповторів і відстеження команди до підтвердженого статусу.

**Виправлено після перевірки:**
- **Lint:** `@typescript-eslint/no-unnecessary-type-assertion` у `control.test.tsx` (2 місця) — generic `getByRole<HTMLButtonElement>`, правило не вимикалось.
- **Фокус після підтвердження:** меню рядка стає `disabled`, поки команда не фінальна, і `Dialog` повертав фокус на вимкнений тригер (фокус губився). Тепер фокус переходить на статус команди (`role=status`, `tabIndex=-1`); додано тест.
- **Хибна причина в рядку:** без звіту broker (недоступний/застарілий/керування вимкнене) рядок показував «Не дозволено керування». Тепер — «Керування зараз недоступне». Знайдено real-PM2 E2E.
- **Скриншот UI-тесту** писався в `/tmp`; тепер у вихідну теку Playwright.
- **Локатори E2E:** ім'я процесу тепер є і в таблиці, і в історії команд, тож перевірка viewer іде через `rowheader`.

| Перевірка (Node v22.23.3) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 342/342, smoke 10/10, agent 122/122 (+3 opt-in пропущено), frontend 103/103, typecheck, lint, збірки |
| `npx playwright test -c e2e/ui.config.ts` (фінальна збірка, синтетичні API-відповіді, без БД/PM2) | 2/2: 1440 і 390 px, меню → «Перезапустити» → підтвердження з правильним процесом → «Скасувати» → команда не надсилається, фокус на тригері, без горизонтального скролу і помилок сторінки |
| `npm run test:e2e:pm2` (ізольована тестова БД через SSH-тунель, одноразовий `PM2_HOME`) | 1/1: inventory з одноразового PM2 (exporter); процес поза allowlist видно в таблиці без меню; оператор через меню зупиняє й запускає дозволений процес (стан PM2 підтверджено); viewer без меню, API → 403; broker зупинено → «Broker недоступний», меню немає, у рядку «Керування зараз недоступне» |
| `npm run test:e2e` | 10/10 (+1 opt-in пропущено) |
| `git diff --check`, `npm run check:secrets` | OK |
| Залишки | 0 схем `nc_test_*`; сторонніх PM2 daemon і `~/.pm2` немає |

Межі: production-процеси в тестах не використовувались; UI на production перевіряється без виконання дій.

**Деплой (центральний сервер, ~14:2x UTC).** Deployed code revision: **`3ff465367b99991a148d4475d773736d2ce5aca1`** (`feat(frontend): unify service inventory and process actions`); previous — `b4ada6d` (ціль rollback). Цей запис — пізніший docs-commit, на сервер не деплоївся.

| Крок | Результат |
|---|---|
| Baseline | `control-server`; current `b4ada6d`, previous `ffb32b0`; API active, ready 200; Nginx/PostgreSQL/Docker active, failed 0 |
| Артефакт | 44 файли, SHA-256 `c8b8a14e…82e7ae1`, `sha256sum -c` OK, manifest revision `3ff4653`; `backend/dist` ідентичний попередньому релізу; міграції pending=0 (нових немає); unit-файл без змін |
| Активація | `current` → `3ff4653`, `previous` → `b4ada6d`; restart лише `node-control-api` (процес `nodecontrol`, listener лише `127.0.0.1:3100`) |
| Після деплою | live/ready 200; HTTPS `/`, `/servers/<id>`, `/applications` → 200; JS/CSS assets 200, публічний бандл = `current/frontend/dist` і містить нову таблицю й меню; анонімні `/api/auth/me`, `…/control`, `POST …/control-commands` → 401; журнал: `pm2ControlEnabled:true` (без змін), 0 error/fatal, 0 секретів, 0 відповідей 4xx агенту; `nginx -t` OK (конфіг не змінювався) |
| Без змін керування/PM2 | `api.env` не змінювався (mtime 13:41:44, з моменту ввімкнення); allowlist `root:root 644`, 5 записів, не змінювався; broker/Agent/exporter active (Agent `b4ada6d` — не передеплоювався); 0 команд у БД, 0 виконаних broker; God Daemon 3807 і 5 PM2-процесів із часом старту 6 жовтня — без змін |
| Rollback | не застосовувався (за потреби: `server-release.js rollback` → `b4ada6d` + restart лише API) |

Ручна перевірка оператора (потрібна сесія): «Сервери» → `app-server` → «Сервіси сервера» — 5 рядків, колонка «Дії», меню відкривається; дію не виконувати, якщо вона не потрібна.

## Task 009 — production enable керування на app-server (2026-10-13, ~13:39–13:43 UTC)

Користувач попросив виконати потрібні дії на сервері й обрав allowlist «Усі 5, start/stop/restart». Код не змінювався (API/UI і Agent — `b4ada6d`, Agent уже 0.3.0).

| Крок | Результат |
|---|---|
| Baseline | Agent `b4ada6d` active; God Daemon 3807, 5 PM2-процесів (PID і час старту 6 жовтня); listener-и записані. Fingerprint через `pm2-broker.js fingerprint` від `ubuntu` (лише існуючий daemon, без шляхів/env): усі 5 — `fork_mode`, `instances 1`, імена унікальні |
| Broker | група `nc-pm2-control`; `/etc/goit-node-control-pm2-broker/ubuntu.env` і allowlist `root:root 644`; unit із релізу, `systemd-analyze verify` OK; `node-control-pm2-broker@ubuntu` enabled/active, процес `ubuntu` / група `nc-pm2-control`; `/run/goit-node-control-pm2-broker` `750`, сокет `660 ubuntu:nc-pm2-control`, журнал `/var/lib/goit-node-control-pm2-broker` `700`. Спершу з порожнім allowlist |
| Agent | `nodecontrol-agent` додано лише до `nc-pm2-control` (доступу до `rpc.sock` немає — перевірено); backup `agent.env.bak-20261013T133958Z`; додано лише `NC_AGENT_CONTROL_SOCKET` (600 `nodecontrol-agent`, токен не змінювався); restart лише Agent → `control: enabled`, `control poll ok, broker ok`; heartbeat/inventory `accepted` |
| Allowlist | backup попередньої (порожньої) версії; 5 цілей (`targetKey` = ім'я PM2): `catalog-api`, `billing-api`, `orders-api-v2`, `orders-api`, `public-api`, дії `start/stop/restart`, fingerprint з baseline |
| API | backup `api.env.bak-20261013T134144Z` (600 `nodecontrol`); додано `PM2_CONTROL_ENABLED=true`; restart лише `node-control-api`; лог старту `pm2ControlEnabled:true`, `trustedProxies:1`, `authOrigins:1`; 0 error/fatal, 0 відповідей 4xx агенту |
| Результат | у БД: broker `ok`, daemon `ok`, allowlist `ok`, 5 цілей `match_status ok` (pm_id 0–4); команд — 0 (жодна дія не виконувалась); PM2-процеси й час їх старту без змін; нових listener-ів немає; exporter timer active |

Ручна перевірка оператора: «Сервери» → `app-server` → «Керування PM2» — 5 цілей «готовий до керування»; перша дія (наприклад, перезапуск некритичного процесу) з підтвердженням → «Виконано й підтверджено»; audit `process.command_*`.

Rollback / аварійне вимкнення: `PM2_CONTROL_ENABLED` прибрати або `false` в `api.env` (backup є) + restart API; або спорожнити allowlist (backup є) — діє без перезапуску; або `systemctl disable --now node-control-pm2-broker@ubuntu`; або прибрати `NC_AGENT_CONTROL_SOCKET` (backup `agent.env.bak-20261013T133958Z`) + restart Agent. PM2-процеси при цьому не зупиняються; журнал broker не видаляти.

## Task 009 — керування явно дозволеними PM2-процесами (2026-10-13)

**Active code revision:** центральний API/UI і реліз Agent — `b4ada6d07bcdc834959f889de37620688c756a15` (`feat(pm2): add allowlisted process control with audited commands`; previous API `ffb32b0`, Agent `7cdc50e`); `app-server` Agent — `b4ada6d` (0.3.0, previous `7cdc50e`). Предки: `7cdc50e`, `0ba0824`, `005fa62`, `bfe784e`. Цей звіт — пізніший docs-commit. **Production control вимкнений.**

Стан на початок: `main` = `6ef1343`, дерево чисте. Центральний сервер: API/UI `ffb32b0`, реліз Agent `7cdc50e`. `app-server`: Agent 0.2.0 (`7cdc50e`), exporter `@ubuntu`, inventory `ok`.

**Реалізовано (ADR-017).** Операції `start`/`stop`/`restart` лише для процесів із root-owned allowlist на ноді; створення/видалення/reload/deploy, логи, shell, «all», cluster — ні.
- **Broker** (`agent/dist/pm2-broker.js`, `node-control-pm2-broker@<owner>`):
  - працює від власника PM2, лише unix-сокет `0660 <owner>:nc-pm2-control`, без мережі;
  - викликає тільки `startProcessId`/`stopProcessId`/`restartProcessId({id})` (тип `Pm2Method` дозволяє ще `getMonitorData` — нічого більше);
  - ідентичність: ім'я + fork/1 instance + fingerprint definition (pm_id не є ідентичністю);
  - перевірка перед дією і пост-перевірка; дії строго послідовні;
  - durable журнал дедуплікації (`started` до PM2-виклику, `completed` після; повторна доставка → збережений результат; збій під час дії → `unknown/interrupted`).
- **Agent 0.3.0:** окремий цикл опитування (10 с, лише якщо задано `NC_AGENT_CONTROL_SOCKET`), передача команди broker, повтор лише підтвердження результату; heartbeat/inventory незалежні.
- **API** (міграція `1791900000004_process-control`, additive):
  - `control_commands` (стани `queued → dispatched → succeeded|failed|rejected|expired|unknown`, idempotency `(actor, key)`, одна активна команда на ціль);
  - `server_control_status`/`server_control_targets`;
  - browser: `GET …/control`, `POST …/control-commands` (`processes:control` + Origin + CSRF), `GET` команд;
  - machine: `POST /api/agent/control/poll|result`;
  - claim: `FOR UPDATE SKIP LOCKED`, lease 45 с, ≤ 3 доставки тієї самої команди, повторна перевірка ролі/активності актора й цілі, неблокувальний advisory-lock на сервер;
  - дедлайн 120 с; без результату до дедлайн + 120 с → `unknown/no_result` (пізній підтверджений результат замінює його);
  - кожен перехід + audit `process.command_*` — одна транзакція;
  - `PM2_CONTROL_ENABLED` (типово `false`).
- **UI:** секція «Керування PM2» на сторінці сервера:
  - кнопки лише для `processes:control` і лише для свіжих, збіжних цілей на онлайн-сервері;
  - підтвердження із сервером/процесом/ціллю; ключ idempotency на діалог; жодних автоповторів;
  - статус до фінального (успіх — лише після підтвердження);
  - чесні тексти для `failed`/`rejected`/`expired`/`unknown`; історія команд; прив'язка до сервера і сесії.
- Не гарантується exactly-once через мережу: якщо журнал broker втрачено до дедлайну, повторна доставка може виконати дію ще раз (описано в ADR-017).

| Перевірка (Node v22.23.3) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 342/342, smoke 10/10, agent 122/122 (+3 opt-in), frontend 97/97, typecheck, lint, збірки |
| Agent/broker (`agent/test/control.test.ts`, 23) | tampered allowlist (власник, права, symlink, дублікати, wildcard, розмір); ідентичність (pm_id reuse, дублікати імен, cluster, змінений fingerprint); виконавець (усі відмови до PM2-виклику, дедлайн, без daemon — без auto-start, pm2_error, timeout → unknown, identity_changed, verification_failed); дедуплікація і crash; журнал; сокет 0660, сміття відкидається, послідовне виконання, `broker_busy`; Agent: «не надіслано» vs «надіслано без відповіді», повтор лише підтвердження, heartbeat не блокується |
| Real-DB (`test:backend:db`, тестова БД) | 60/60 (+11 control): constraints; умови створення; idempotency і конкурентні запити; audit-збій → команди немає; claim/lease/один виконавець; прив'язка до сервера і revoked credential; повторна перевірка актора/цілі; expired / redelivery ×3 / unknown / пізнє підтвердження; конкурентні poll |
| API (`backend/test/control-api.test.ts`, 20) | viewer 403 (+authz.denied), operator/admin 201; сесія/Origin/CSRF/Bearer; вимкнено → 409 без звернення до store; 10 спроб передати pm_id/шлях/env/shell/delete/reload/all/wildcard → 400; machine/browser separation; strict poll/result |
| Frontend (`frontend/test/control.test.tsx`, 11) | viewer без кнопок; 5 причин вимкнених кнопок; підтвердження і тіло запиту; успіх лише після підтвердженого статусу; `unknown`; 409 без автоповтору; повтор із тим самим ключем; A→B під час запиту |
| Справжній PM2 (`npm run test:agent:pm2`, pm2@7.0.4, тимчасовий `PM2_HOME`) | 3/3: exporter (як раніше) + broker: stop/start/restart дозволеного процесу з перевіркою стану, повторна доставка без другого restart, `start` online → `invalid_state`, недозволений процес незмінний, після `pm2 kill` → `failed/daemon_unavailable` без нового daemon |
| E2E (`npm run test:e2e`) | 10/10 (+1 opt-in пропущено); `servers.spec`/`inventory.spec` — точний збіг «Онлайн» (новий текст «Сервер не онлайн» інакше давав хибний збіг) |
| E2E зі справжнім PM2 (`npm run test:e2e:pm2`, окремий прогін) | 1/1: оператор у браузері зупиняє й запускає дозволений процес через API → Agent → broker → одноразовий PM2; стан PM2 підтверджено, інший процес online; audit 2×(requested, dispatched, succeeded); viewer без кнопок, API → 403; broker зупинено → «Broker недоступний», кнопки вимкнені |
| Залишки | 0 схем `nc_test_*`; сторонніх PM2 daemon і `~/.pm2` немає; тимчасові каталоги видалено |

| Деплой | Результат |
|---|---|
| Артефакти `b4ada6d` | API/UI: 44 файли, SHA-256 `aebac85b…5f20111`, prod deps `fastify`, `node-pg-migrate`, `pg`; Agent (вкл. broker і unit-шаблон): `eae3e6d5…6329ba4b`; `sha256sum -c` OK на обох серверах |
| Baseline центральний | API `ffb32b0`, реліз Agent `7cdc50e` (unit disabled); служби active, failed 0; `api.env` без `PM2_CONTROL_ENABLED` (перевірено за назвами ключів) |
| Backup | `/root/node-control-backups/node_control_db-20261013T130647Z-pre-b4ada6d….dump` (`600 root`), `pg_restore --list` читається |
| Міграція | як `nodecontrol`: pending 1 → applied=5, pending=0; нові таблиці `control_commands`, `server_control_status`, `server_control_targets` |
| API/UI | unit-файл без змін; `current` → `b4ada6d`; restart лише `node-control-api`; `nodecontrol`, listener лише `127.0.0.1:3100`; лог старту `pm2ControlEnabled:false`, `trustedProxies:1`, `authOrigins:1`; `api.env` не змінювався |
| Реліз Agent (центральний) | `current` → `b4ada6d`, unit disabled/inactive (без змін) |
| `app-server` | baseline: Agent `7cdc50e` active, exporter timer active, God Daemon 3807, 5 PM2-процесів; backup `agent.env.bak-20261013T130714Z` (600 `nodecontrol-agent`); `prepare --no-install` + `activate` → `b4ada6d`; unit-файли Agent/exporter без змін; restart лише Agent → 0.3.0, `"control":{"enabled":false}`, heartbeat і inventory `accepted`. `agent.env` без змін (ключі `NC_AGENT_API_URL`, `NC_AGENT_TOKEN`, `NC_AGENT_INVENTORY_FILE`); broker, група `nc-pm2-control` і `/run/goit-node-control-pm2-broker` — відсутні |
| Після деплою (центральний) | live/ready 200; HTTPS `/`, `/servers/<id>`, `/applications` → 200; анонімно `GET …/control`, `GET …/control-commands` → 401, `POST …/control-commands` з Origin → 401, без Origin → 403; `POST /api/agent/control/poll` без токена / з невідомим токеном → 401, `…/result` без токена → 401; journal: 0 error/fatal, 0 секретів, 0 відповідей 4xx агентам; `nginx -t` OK; Nginx/PostgreSQL/Docker active, failed 0; migrations pending=0 |
| Доказ fail closed | API `pm2ControlEnabled:false`; у БД 0 команд, 0 станів/цілей керування, 0 подій `process.*`; Agent не опитує керування (0 `control poll` у журналі); broker не встановлений |
| Без рестартів / портів | God Daemon 3807 і всі 5 дочірніх PID із часом старту — ідентичні baseline; список listener-ів ідентичний; exporter продовжує (3 запуски за 2 хв); у БД: Agent 0.3.0, heartbeat 1 с, inventory `ok`, 5 процесів, збір 43 с тому |

Rollback (не застосовувався): API — `server-release.js rollback` (→ `ffb32b0`) + restart; нові таблиці лишаються (additive), команд немає. Agent на `app-server` — `server-release.js rollback --base /opt/goit-node-control-agent` (→ `7cdc50e`) + restart Agent; `agent.env` не змінювався (backup є). Exporter/PM2 не зачіпаються.

**Для production enable потрібні від оператора:** перелік процесів (ім'я в PM2), `targetKey` і дозволені дії для кожного; підтвердження, що це fork-процеси з унікальними іменами; рішення увімкнути `PM2_CONTROL_ENABLED=true`. Далі — процедура в DEPLOYMENT («Керування PM2»).

## Task 008.2 — перевірка підключення PM2 inventory та виправлення рекомендованої ревізії (2026-10-13)

Підключення `app-server` уже виконано в межах Task 008.1 (11:33–11:38 UTC, деталі нижче). У Task 008.2 повторно, read-only, підтверджено стан і виправлено документацію: у Task 008 рекомендувався `ffb32b0` з дефектним unit. Історичні записи про задеплоєний `ffb32b0` (центральний API/UI) лишаються фактами.

- **Ревізія для встановлення:** реліз Agent `7cdc50eb0acf5070fe829670e4bcd2830375b5b7`; `git merge-base --is-ancestor 7cdc50e 7cdc50e` — так. Артефакт: sha256 `32d8b3b4…cff3367a`, `sha256sum -c` OK; копія в `/root/node-control-deploy/7cdc50e…/` на центральному сервері.
- **Центральний сервер:** `current` реліз Agent `ffb32b0` → `7cdc50e` (prepare `--no-install` + activate). Unit Agent там disabled/inactive, без restart, unit-файл без змін. Мета — щоб `current` більше не містив дефектного шаблону. API/UI лишився на `ffb32b0` (код не змінювався, без restart).

| Перевірка (read-only, ~11:5x UTC) | Результат |
|---|---|
| Agent | release `7cdc50e` (previous `81e1933`), 0.2.0, enabled/active, процес `nodecontrol-agent`, групи `nodecontrol-agent nc-pm2-inventory` |
| Node.js | `/usr/bin/node` v22.15.0 (не змінювалась) |
| Unit exporter | `ConditionUser` — 0 рядків, `User=%i`; з моменту встановлення 0 записів «unmet condition» |
| Виконання від PM2 owner | рядки «inventory exported» у журналі мають `_UID=1000` (`ubuntu`); `_UID=0` — лише службові повідомлення systemd |
| Timer | `node-control-pm2-exporter@ubuntu.timer` enabled/active; 18 запусків за 10 хв, 0 warn/error |
| Snapshot | `state ok`, 5 процесів, вік 6 с; лише allowlist-ключі; каталог `ubuntu:nc-pm2-inventory 2750`, файл `640`; конфіг exporter `root 644` |
| Доступ Agent | читає файл; запису у файл і каталог немає; доступу до `/home/ubuntu/.pm2/rpc.sock` немає |
| `agent.env` | `nodecontrol-agent 600`; ключі `NC_AGENT_API_URL`, `NC_AGENT_TOKEN`, `NC_AGENT_INVENTORY_FILE`; у журналі Agent за 10 хв: 0 warn/error, 0 збігів `ncag_` |
| Центральна БД | heartbeat 18 с тому (0.2.0); inventory `ok`, 5 процесів, збір 52 с тому → «Актуально» |
| Без рестартів | God Daemon PID 3807 (6 жовтня) і 5 дочірніх PID із часом старту 6 жовтня — як у baseline |
| Порти | listener-и ідентичні baseline; у Agent/exporter їх немає |

**Ручна перевірка оператора (одна):** увійти на https://control.example.com → «Застосунки»: 5 процесів сервера `app-server` з позначкою «Актуально», заповнені аптайм, рестарти, CPU і RAM. Сторінка сервера → «Застосунки PM2» → «Актуально: зібрано …». Адмінські credentials у цій роботі не використовувались.

Rollback і невиконане: див. Task 008.1. Відкритих блокерів для inventory немає.

## Task 008.1 — виправлення unit exporter після review Codex (2026-10-13)

Стан на початок: `main` = `8e28579`, дерево чисте. Центральний сервер — API/UI і реліз Agent `ffb32b0`, unit-шаблони exporter ніде не встановлені. `app-server` — Agent 0.1.0, inventory немає.

**P1.** `ConditionUser=!root` у `node-control-pm2-exporter@.service` перевіряє користувача system manager (root), а не `User=%i`. Через це кожен instance пропускався. **Виправлення:** умову прибрано, `User=%i` залишено. Заборона root — лише в коді: `loadExporterConfig` перевіряє фактичний UID до будь-якого доступу до `PM2_HOME`, `@root` завершується з exit 2. Hardening unit без змін. Додано статичний regression-тест `tests/unit/systemd-units.test.js`: на старому unit він падає, на новому проходить.

**Runtime-перевірка systemd на центральному сервері** (ізольована тимчасова конфігурація: тестовий системний користувач `nc-pm2-systest`, порожній `PM2_HOME` без daemon, `/var/lib/goit-node-control-pm2`; після перевірки все видалено, `/etc/systemd/system` повернуто до стану без exporter units):

| Сценарій | Результат |
|---|---|
| Старий unit (`ffb32b0`) | `systemctl start` → «skipped, unmet condition check ConditionUser=!root», snapshot не записано — дефект відтворено |
| Новий unit, `@nc-pm2-systest` | `systemd-analyze verify` OK; «Finished …»; snapshot `nc-pm2-systest:nc-pm2-systest 640`, `unavailable/daemon_not_running`, 0 процесів; `PM2_HOME` лишився порожнім (daemon не створено) |
| `@root` | exporter відмовив сам: `Result=exit-code`, `ExecMainStatus=2`; snapshot не змінився |
| Timer `@nc-pm2-systest` | active; 4 запуски «inventory exported» за 80 с; `capturedAt` оновився (11:02:25 → 11:03:31 UTC); `PM2_HOME` порожній |

| Перевірка (Node v22.23.3) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 88/88 (+3 unit-тести systemd), backend 322/322, smoke 10/10, agent 99/99 (+2 opt-in), frontend 86/86, typecheck, lint, збірки |
| `npm run test:agent:pm2` (справжній pm2@7.0.4, тимчасовий `PM2_HOME`) | 2/2. Перші запуски через `npx -p node@22 -- npm run` падали з exit 127: вкладений `npx` успадковував `npm_config_package=node@22`. Тест тепер очищує `npm_*` env; тимчасові каталоги створюються лише в opt-in режимі |
| Real-DB (тестова БД) | 49/49 |
| E2E | 10/10; 0 схем `nc_test_*` після прогону |
| `git diff --check`, `check:secrets` | OK |

**Підключення PM2 inventory на `app-server` (2026-10-13, ~11:33–11:38 UTC).** Доступ і параметри надав оператор: SSH `ubuntu@203.0.113.20`, sudo є. PM2 owner і `PM2_HOME` визначено read-only з аргументів процесу God Daemon, `pm2`-команди не запускались.

| Крок | Результат |
|---|---|
| Read-only аудит | Ubuntu 24.04, systemd 255, `/usr/bin/node` v22.15.0 (не змінювалась). PM2 6.0.5 God Daemon PID 3807 від `ubuntu`, `PM2_HOME=/home/ubuntu/.pm2` (`ubuntu:ubuntu 775`, `rpc.sock` 775). Agent: release `81e1933` (зібраний оператором із `/home/ubuntu/node-control-source`), enabled/active, `nodecontrol-agent` лише у власній групі, `agent.env` з ключами `NC_AGENT_API_URL`, `NC_AGENT_TOKEN`. Baseline: 5 PM2-процесів (PID і час старту — 6 жовтня; аргументи не друкувались), listener-и записані |
| Agent → `7cdc50e` | артефакт sha256 `32d8b3b4…cff3367a`, `sha256sum -c` OK; backup `agent.env.bak-20261013T113342Z` (600 `nodecontrol-agent`); `prepare --no-install` + `activate`, реліз `root:root 755`; unit-файл без змін; restart лише Agent → 0.2.0, heartbeat `accepted` |
| Exporter | група `nc-pm2-inventory` (лише `nodecontrol-agent`); `/var/lib/goit-node-control-pm2` `ubuntu:nc-pm2-inventory 2750`; `/etc/goit-node-control-pm2-exporter/ubuntu.env` `root 644` (без секретів); unit-шаблони з релізу (без `ConditionUser`), `systemd-analyze verify` OK. Пробний запуск: «Finished», `state ok`, 5 процесів, 35 мс. `connect()` до `rpc.sock` працює під `ProtectHome=read-only`, hardening не послаблювався. Файл `ubuntu:nc-pm2-inventory 640`, 885 байт, лише allowlist-ключі |
| Активація | `node-control-pm2-exporter@ubuntu.timer` enabled/active; в `agent.env` додано лише `NC_AGENT_INVENTORY_FILE` (600 `nodecontrol-agent` збережено, токен не змінювався); restart Agent → `inventory: enabled`, перший звіт `accepted, state ok, processCount 5` |
| Acceptance (через ~2 хв) | exporter: 6 запусків за 3 хв, 0 помилок, snapshot `ok` віком 26 с; Agent: inventory і heartbeat `accepted`, 0 warn/error, 0 `insecure`/`permission`; центральна БД: Agent 0.2.0, heartbeat 13 с, inventory `ok`, 5 процесів (усі `online`, CPU/RAM відомі), збір 44 с тому → «Актуально» |
| Без рестартів / портів | God Daemon PID 3807 і всі 5 дочірніх PID із часом старту 6 жовтня — без змін; список listener-ів ідентичний baseline; у Agent/exporter listener-ів немає |

Перевірку в UI («Застосунки», сторінка сервера) виконує оператор під своєю сесією; адмінські credentials у цій сесії не використовувались.

Rollback (не застосовувався): `sudo systemctl disable --now node-control-pm2-exporter@ubuntu.timer`; `agent.env` ← `agent.env.bak-20261013T113342Z`; `server-release.js rollback --base /opt/goit-node-control-agent` (→ `81e1933`); `systemctl restart node-control-agent` — heartbeat продовжиться. PM2 і проєкти не зачіпаються; дані в БД лишаються.

**Інцидент на локальній машині розробника (не сервер).** Під час діагностики exit 127 я виконав `npx pm2@7.0.4 --version` без `PM2_HOME`. Це запустило PM2 daemon у `~/.pm2` на Mac розробника — саме та поведінка auto-start, від якої захищає exporter. Каталог створено в момент діагностики, він не містив процесів (`module_conf.json = {}`, порожні `pids`/`logs`). Daemon зупинено через `pm2 kill`, `~/.pm2` видалено; сторонніх PM2 daemon немає. Висновок для процедур: **не запускати жодних `pm2`-команд поза тимчасовим `PM2_HOME`**, навіть `--version`.

## Task 008 — read-only PM2 inventory і застосунки (2026-10-13)

**Active code revision на центральному сервері: API/UI і реліз Agent — `ffb32b0ef7269c3c37ecefa20d181fc333632d08`** (`feat(pm2): add read-only process inventory and applications UI`); previous — `0ba0824`. `0ba0824`, `005fa62`, `bfe784e` — предки. Цей звіт — пізніший docs-commit, на сервер не деплоївся. **Exporter ніде не встановлений і процеси PM2 ще не збираються.** На `app-server` працює Agent 0.1.0 без inventory.

Стан на початок: `main` = `81e1933`, дерево чисте. Виправлення Task 007.1 у коді й тестах підтверджено: прив'язка стану до id, `CredentialControls` з key, `readBoundedBytes`/`parseAcceptedBody`. На сервері API/UI і Agent — `0ba0824`. Підключено окремий сервер `app-server` (hostname `app-server`, Agent 0.1.0, heartbeat надходить). SSH-доступу до нього в цій сесії немає. Локальний Agent центрального сервера — disabled.

**Реалізовано (ADR-016):**
- **PM2 exporter** (`agent/src/pm2/`, `agent/dist/pm2-exporter.js`): власний клієнт протоколу PM2 лише для `getMonitorData` до **існуючого** daemon, без пакета pm2 і без auto-start; allowlist-санітизація (секрети `pm2_env` не виходять за межі пам'яті exporter); атомарний snapshot-файл; systemd-шаблони `node-control-pm2-exporter@<owner>.service|.timer` (не root, лише AF_UNIX, без мережі).
- **Agent 0.2.0:** окремий незалежний цикл inventory (`NC_AGENT_INVENTORY_FILE`), безпечне читання файлу, звіт `ok|stale|unavailable`, строгий контракт відповіді, пауза після 404 старого API.
- **API:** міграція `1791900000003_pm2-inventory` (additive: `server_inventories`, `server_applications`); `POST /api/agent/inventory` (machine auth, identity з credential, ≤ 500 процесів / 512 KiB, конкурентність 4+8); `GET /api/applications` (keyset, фільтри server/status) і `GET /api/servers/:id/applications` (`monitoring:read`). Reconciliation: заміна набору, `unavailable`/`stale` зберігають останні дані з позначкою, старіший snapshot ігнорується, той самий — без оновлення свіжості.
- **Strict schemas на всіх `/api`:** Ajv `removeAdditional: false`. Зайві поля тепер дають 400, а не мовчки обрізаються. Наслідок: heartbeat із підробленим `serverId` → 400 (тест оновлено). Чинні клієнти не зачеплені.
- **UI:**
  - «Застосунки»: реальні процеси, фільтри й курсор в URL (identity-safe), явна свіжість (актуально / застарілі / exporter недоступний / сервер офлайн), «—» для невідомих метрик;
  - секція «Застосунки PM2» на сторінці сервера зі станом інтеграції;
  - кнопок керування немає; імена рендеряться лише як текст.
- **Не реалізовано:** start/stop/restart/delete, логи, redeploy, Jenkins, кілька PM2 owners на сервер.

| Перевірка (Node v22.23.3) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 85/85, typecheck, lint, backend 322/322, smoke 10/10, agent 99/99 (+2 opt-in пропущено), збірка agent, frontend 86/86, збірка UI |
| Agent/exporter (`agent/test/inventory.test.ts`, 28) | санітизація з синтетичними секретами в усіх полях `pm2_env`; `null` замість штучного 0; дублікати/ліміти; протокол на фейковому daemon (по 1 байту, error/чужий id/завеликий frame/сміття/тиша → protocol_error/timeout); відсутній daemon → `daemon_not_running` без змін у `PM2_HOME`; статична перевірка: без `pm2`/`child_process`, лише `getMonitorData`; атомарний запис 0640, відмова при symlink/group-writable/чужому каталозі; читання — відмова при власному файлі Agent, symlink, writable, oversize, malformed; stale без процесів; 404 → 900 с; heartbeat не блокується зависанням inventory |
| Справжній PM2 (`npm run test:agent:pm2`, pm2@7.0.4, тимчасовий `PM2_HOME`) | 2/2: без daemon → `daemon_not_running`, `PM2_HOME` лишився порожнім (daemon не стартував); з daemon → процес `online`, у файлі немає секрету з argv/env; після `pm2 kill` → `daemon_not_running`, `rpc.sock`/`pm2.pid` не з'явились |
| API (`backend/test/inventory-api.test.ts`, 31) | identity лише з credential (зайвий `serverId` → 400); 401/403 machine/browser separation; revoked → 401; 16 невалідних payload → 400 без запису; 413; 503 (ліміт/збій) без секретів у логах; права viewer/operator/admin; пагінація/фільтри/валідація курсора; маршрутів керування немає (404) |
| Real-DB (`test:backend:db`, тестова БД, per-run schema) | 49/49 (+11 inventory): constraints, заміна набору, повторне використання `pm_id`, порожній ≠ unavailable, stale, зміна source без orphans, старіший snapshot ігнорується, свіжість за серверним годинником, конкурентні звіти (найновіший перемагає), revoked/inactive → unauthorized, keyset через 3 сторінки |
| Frontend (`applications.test.tsx`, 13) | дані/stale/offline/unavailable/порожньо/помилка/403/401; XSS-ім'я лише текстом; немає кнопок керування; фільтр не показує рядки попереднього фільтра; A→B на сторінці сервера (повільно/503) без даних A; відповідь для чужого сервера відхиляється |
| E2E (Playwright, тестова БД) | 10/10: новий сценарій — справжні backend+UI+скомпільований Agent із синтетичним snapshot → «Актуально», фільтр, viewer, `unavailable` зберігає 3 процеси з позначкою |

| Деплой (центральний сервер) | Результат |
|---|---|
| Baseline | API/UI `0ba0824` (prev `97d1c06`), реліз Agent `0ba0824`, локальний Agent disabled/inactive, `agent.env` відсутній; служби active, failed 0; heartbeat `app-server` (0.1.0) — 20 с тому |
| Артефакти `ffb32b0` | API/UI: 40 файлів, SHA-256 `8ad8e388…98dfac`, prod deps `fastify`, `node-pg-migrate`, `pg`; Agent: 20 файлів (вкл. exporter і unit-шаблони), `f2816219…205c5f`; `sha256sum -c` OK |
| Backup | `/root/node-control-backups/node_control_db-20261013T104828Z-pre-ffb32b0….dump` (`600 root`), `pg_restore --list` читається |
| Міграція | як `nodecontrol`: pending 1 → applied=4, pending=0; нові таблиці порожні; servers=1, активний credential 1, audit 5 — без змін |
| API/UI | unit-файл без змін; `current` → `ffb32b0`; restart лише `node-control-api`; `nodecontrol`, listener лише `127.0.0.1:3100`; `api.env` не змінювався (`trustedProxies:1`, `authOrigins:1`, `cookieSecure:true`) |
| Реліз Agent | `/opt/goit-node-control-agent/current` → `ffb32b0`; unit-файл без змін; локальний unit лишився disabled/inactive. Шаблони exporter проходять `systemd-analyze verify` (у тимчасовому каталозі, на `/etc/systemd/system` не встановлювались) |
| Після деплою | live/ready 200; HTTPS `/`, `/applications`, `/servers/<id>` → 200, bundle = `current`; анонімні `/api/auth/me`, `/api/applications`, `/api/servers/:id/applications` → 401; `POST /api/agent/inventory` без токена/з невідомим токеном → 401, з Origin → 403; **старий Agent 0.1.0 продовжує heartbeat** (останній — 27 с, 0 відповідей 4xx після strict schemas); journal: 0 error/fatal, 0 збігів секретів; `nginx -t` OK; Nginx/PostgreSQL/Docker active, failed 0; migrations pending=0 |

**Віддалена активація (`app-server`) — не виконана.** Немає SSH-доступу й не відомі PM2 owner та `PM2_HOME`. Потрібно: оновити Agent до `ffb32b0` (реліз + restart, `agent.env` і токен не змінюються) і встановити exporter за DEPLOYMENT («PM2 inventory exporter»). До цього UI показує для сервера «Агент ще не передавав inventory PM2».

> **Виправлення (Task 008.2):** рекомендація вище застаріла — `ffb32b0` містить дефектний unit exporter (`ConditionUser=!root`, instance пропускався). Встановлювати лише запушений реліз, що містить `7cdc50e` (`git merge-base --is-ancestor 7cdc50e <release-sha>`). Фактично `app-server` активовано з релізом `7cdc50e` — див. Task 008.1/008.2.

Rollback (не застосовувався): API — `server-release.js rollback` (→ `0ba0824`) + restart `node-control-api`; таблиці inventory лишаються (additive), відновлення БД не потрібне. Реліз Agent — `server-release.js rollback --base /opt/goit-node-control-agent` (→ `0ba0824`), unit лишається disabled. Exporter ніде не активовано, тож і вимикати нічого.


## Task 007.1 — виправлення після review Codex (2026-10-13)

**Active code revision на сервері: API/UI і Agent — `0ba08240d7c5b5a51472553fba422d20fa45fcdb`** (`fix: isolate server credential UI state and validate heartbeat responses`). Previous: API/UI `97d1c06`, Agent `e2ac0c9`. `bfe784e` і `005fa62` — предки. Цей звіт — пізніший docs-commit, на сервер не деплоївся.

Стан до початку: `main` = `5605221`, дерево чисте. На сервері API/UI `97d1c06`, Agent `e2ac0c9`. Оператор уже створив сервер і видав ключ (1 сервер, 1 активний credential), але `agent.env` ще не записано: Agent disabled/inactive, heartbeat-ів 0. Цей стан зберігається.

**P1 — дії з ключем могли піти на попередній сервер.** `usePolledResource` тримав дані останнього успішного завантаження незалежно від id. Після переходу `/servers/A` → `/servers/B` без reload і 503 для B сторінка B показувала сервер A з його `CredentialControls`, і «Видати ключ» надсилав `POST /api/servers/A/agent-credentials`.

Виправлення (ADR-015, «Ідентичність ресурсу в UI»):
- `usePolledResource(load, resourceKey)` зберігає стан разом із ключем. Для іншого ключа в тому самому render повертається `loading`. Помилка нового ресурсу не підставляє дані попереднього; last known data зберігаються лише при refresh того самого ключа.
- `ServerDetailPage` показує дані лише якщо `data.id === id` із URL.
- `CredentialControls` монтується з `key = id + сесія`, тому підтвердження, помилка й виданий токен не переживають зміну сервера, logout чи нову сесію.
- Мутації мають `AbortSignal` і скасовуються при unmount. Результат після скасування ігнорується: токен не показується, reload не запускається. Відповідь із чужим `serverId` — помилка, токен не показується.
- Скасування не вважається відкатом: сервер міг уже виконати дію; автоматичних повторів немає.

**P2 — Agent повертав `accepted` при помилці читання body.** `response.text().catch(() => '')` при HTTP 200 давав `{kind:'accepted', intervalSeconds:null}` навіть після обриву потоку. Timeout не охоплював читання body; відповідь не перевірялась.

Виправлення (ADR-015, «Контракт відповіді heartbeat»):
- Один дедлайн і сигнал скасування охоплюють fetch і читання body. Body обмежено 4096 байтами за фактичним потоком; завеликий `Content-Length` відхиляється без читання; декодування — строгий UTF-8.
- `accepted` лише для `200` + `{status:'accepted', receivedAt: ISO-8601 UTC (round-trip toISOString), intervalSeconds: ціле 5–300}`.
- Новий outcome `invalid_response` (порожній, завеликий, не-JSON, `null` або порушений контракт) дає звичайний експоненційний backoff, лічильник збоїв не скидається. Обрив потоку → `network`, дедлайн → `timeout`, скасування → `aborted`.
- Для не-200 body не читається, класифікація лише за статусом.
- Контракт backend не змінювався (30 с, ISO): backend-тест тепер явно фіксує ключі, формат `receivedAt` і діапазон інтервалу. Схема БД, endpoints і міграції не змінювались.

| Перевірка (Node v22.23.3) | Результат |
|---|---|
| Regression P1 (`frontend/test/server-identity.test.tsx`, MemoryRouter + `useNavigate`, той самий route з новим параметром) | 12/12 з виправленням. На старому коді падають 6: B повільний; B 503; pending issue A → B; підтвердження A; token dialog A; чужий `serverId` |
| Regression P2 (`agent/test/agent.test.ts`, «heartbeat response body») | 36/36 з виправленням (асинхронні `ReadableStream`, реальний HTTP-сервер з обривом і зависанням body). На старому коді падає 18, зокрема відтворення Codex (stream error → accepted), body timeout, cancel і oversized |
| `npm run check:local` | exit 0: node:test 85/85, typecheck, lint, backend 291/291, smoke 10/10, agent 71/71, збірка agent, frontend 74/74, збірка UI |
| `test:backend:db` (ізольована тестова БД через тунель) | 38/38. Перший запуск: ECONNREFUSED, бо впав SSH-тунель; після перепідключення успішно |
| `test:e2e` (тестова БД) | 9/9; 0 схем `nc_test_*` після прогону |
| `check:secrets`, `git diff --check` | OK |

| Деплой | Результат |
|---|---|
| Артефакти `0ba0824` | API/UI: 36 файлів, SHA-256 `68fa4f9a…62d877bc`; Agent: 11 файлів, `e1d57263…6a43389`; `sha256sum -c` OK; prod deps як раніше (89 пакетів; scope-каталоги dev-залежностей порожні, як і в `97d1c06`) |
| Стан до | API `97d1c06` (prev `005fa62`); Agent `e2ac0c9` (prev `97d1c06`), unit disabled/inactive, `agent.env` відсутній |
| Міграції | не потрібні: applied=3, pending=0; backup БД не робився (схема й дані не змінюються) |
| API/UI | unit-файл без змін; `current` → `0ba0824`; restart лише `node-control-api`; процес `nodecontrol`; listener лише `127.0.0.1:3100`; `api.env` не змінювався (лог старту `trustedProxies:1`, `authOrigins:1`, `cookieSecure:true`) |
| Agent | unit-файл без змін; `current` → `0ba0824`; був inactive → не запускався; стан після: disabled/inactive, `agent.env` відсутній, без конфігу exit 2, listener-ів 0 |
| Після деплою | live/ready 200; HTTPS `/`, `/servers`, `/servers/<id>` → 200; bundle UI збігається з `current/frontend/dist`; анонімні `/api/auth/me`, `/api/servers` і heartbeat без токена → 401; journal API: 0 error/fatal, 0 збігів секретів; `nginx -t` OK; Nginx/PostgreSQL/Docker active, failed units 0; у БД без змін (1 сервер, 1 активний credential, 0 heartbeat) |
| Egress-smoke Agent | одноразово як `nodecontrol-agent` з фіктивним токеном через env → `unauthorized`; записів у БД 0. Штатний `accepted` не перевірявся: оператор ще не записав `agent.env` |

Rollback (не застосовувався): API — `server-release.js rollback` (→ `97d1c06`) + restart `node-control-api`; Agent — `server-release.js rollback --base /opt/goit-node-control-agent` (→ `e2ac0c9`), unit лишається disabled. Схема, конфіг і credentials не змінювались, тому відновлювати їх не потрібно.

Окремого E2E-сценарію для переходу A → B не додано: його покриває real-router тест frontend. Наявний E2E servers.spec (видача/відкликання ключа, Agent online/unauthorized) успішний.

## Task 007 — реєстр серверів, Agent heartbeat, UI серверів (2026-10-12)

**Active code revision на сервері:** API/UI — `97d1c0624cb3c4e382df1f90822cdde15086a97a` (`feat(agent): add server registry and authenticated heartbeat`), previous — `005fa62`; Agent — `e2ac0c91879f6e672cdfed4fd6e30102c9809557` (`fix(agent): treat missing env file as configuration error`), previous — `97d1c06`. `e2ac0c9` змінює лише `agent/` (backend/frontend ідентичні `97d1c06`), тому API не передеплоювався. `bfe784e` і `005fa62` — предки. Цей звіт — пізніший docs-commit, на сервер не деплоївся.

**Реалізовано (ADR-015).** Міграція `1791900000002_server-registry` (additive): `servers`, `agent_credentials` (SHA-256 digest токена, partial unique index — один активний credential на сервер, `revoked_at >= created_at`), `server_heartbeats` (останній snapshot ≤ 2048 байт). Admin-only (`servers:manage`) створення сервера, видача/ротація (атомарно, транзакційний audit `agent.credential_issued{rotated}`), відкликання (`agent.credential_revoked`); перегляд — усі ролі. Machine auth `POST /api/agent/heartbeat`: `Bearer ncag_…` (32 байти), відмова з Origin/Sec-Fetch-* (403) або session cookie (401); browser-маршрути відхиляють `Authorization`. Ліміти: 120/хв на IP, 20/хв на токен, конкурентність 8 (+16 у черзі, далі 503), body ≤ 4096 байт, строгий snapshot (`additionalProperties:false`). Agent (TypeScript strict, лише built-ins): тільки вихідний HTTPS з перевіркою TLS, `redirect:'error'`, без HTTP fallback, послідовний цикл, backoff із jitter, Retry-After, graceful shutdown; exit 2 на помилку конфігурації (без restart-циклу). UI: список/деталі з polling 15 с (лише видима вкладка), статус онлайн (вікно 90 с), діалоги створення/видачі/ротації/відкликання, одноразовий показ ключа.

**Виправлення під час деплою.** На сервері без `agent.env` Agent завершувався з кодом 1 (ENOENT від `statSync`), і systemd перезапускав би його до StartLimit. Тепер це `AgentConfigError` → exit 2 (`RestartPreventExitStatus=2`). Додано regression-тест; commit `e2ac0c9`.

| Перевірка | Результат |
|---|---|
| Node v22.23.3 (`97d1c06`) | backend 291/291, frontend 62/62, agent 34/34, compiled smoke 10/10, node:test 85/85; `check:local` exit 0 |
| Real-DB (тестова БД, per-run schema) | 38/38: обмеження схеми, один активний credential, конкурентна ротація, монотонний `received_at`, transactional audit; 0 схем `nc_test_*` після прогону |
| E2E (Playwright, тестова БД) | 9/9: admin створює сервер і видає ключ → скомпільований Agent «Онлайн»; viewer → 403; відкликання → Agent `unauthorized`, `received_at <= revoked_at`; audit-події |
| `e2ac0c9` | agent 35/35, node:test 85/85, typecheck, lint, `check:secrets` OK |
| Артефакти | API `97d1c06`: 36 файлів, SHA-256 `d423cbe6…acf0b99`; Agent `97d1c06`: 11 файлів, `0c7c82e9…c4bfda`; Agent `e2ac0c9`: 11 файлів, `bbaae1d9…b573c17`; `sha256sum -c` OK |
| Backup | `/root/node-control-backups/node_control_db-20261012T200658Z-pre-97d1c06….dump` (`600 root`), `pg_restore --list` — 8 таблиць |
| Міграція | як `nodecontrol` з підготовленого релізу: pending 1 → applied=3, pending=0; таблиці й індекс `agent_credentials_one_active_idx` на місці; servers/credentials/heartbeats — 0 рядків |
| Активація API | `current` → `97d1c06`; restart лише `node-control-api`; процес `nodecontrol`; listener лише `127.0.0.1:3100`; лог старту `trustedProxies:1`, `authOrigins:1`, `cookieSecure:true` |
| Після деплою | live/ready 200; `https://control.example.com/` і `/servers/<id>` → 200 (SPA); анонімні `/api/auth/me`, `/api/servers` → 401; heartbeat без токена → 401; journal: 0 записів error/fatal, 0 збігів `ncag_`/password; `nginx -t` OK; PostgreSQL/Nginx active |
| Agent (перша тестова нода — цей сервер) | користувач `nodecontrol-agent` (uid 994, `/usr/sbin/nologin`, home `/nonexistent`, без sudo); `/opt/goit-node-control-agent` current=`e2ac0c9`; `/etc/goit-node-control-agent` `750 root:nodecontrol-agent`, `agent.env` **відсутній**; unit встановлено, `systemd-analyze verify` OK, **disabled/inactive**; без конфігу → exit 2; listener-ів немає |
| Egress-smoke Agent | одноразовий запуск як `nodecontrol-agent` з фіктивним (не виданим) токеном через env: HTTPS до публічного сайту з перевіркою TLS → `unauthorized`, наступна спроба через 900 с; процес зупинено timeout-ом; записів у БД 0 |

Production credential **не створювався** (ні через SQL, ні через UI); security/load тести проти production не запускались; firewall/HBA/сторонні служби/публічний Nginx-конфіг не змінювались; Agent-порт не відкривався.

**Підключення першої ноди (оператор):** UI → «Сервери» → «Додати сервер» → «Видати ключ» → на сервері записати `agent.env` через `read -rs` (процедура в DEPLOYMENT, розділ «Agent») → `systemctl enable --now node-control-agent` → у журналі `"outcome":"accepted"`, в UI статус «Онлайн».

**Rollback (не застосовувався):** API — `server-release.js rollback` (→ `005fa62`) + restart `node-control-api`; heartbeat зникне (404), нові таблиці лишаються (additive), відновлення БД з backup не потрібне. Agent — `systemctl disable --now node-control-agent` і/або `server-release.js rollback --base /opt/goit-node-control-agent` (→ `97d1c06`).

## Task 006.1 — login rate limit за Nginx (2026-10-12)

**Active code revision на сервері: `005fa629570273931db33a1ccef1b3ca527f02c9`** (`fix(auth): isolate login rate limits behind trusted nginx proxy`); previous — `85f047c`. Цей звіт — пізніший docs-commit, на сервер не деплоївся.

**Проблема (review Codex, P1).** `addressLimiter` брав `request.socket.remoteAddress`; за Nginx це завжди `127.0.0.1`, тож усі клієнти ділили ліміт 30 спроб / 15 хв — будь-хто міг заблокувати вхід іншим. До виправлення Nginx також пропускав клієнтський `X-Forwarded-For` без змін.

**Виправлення (ADR-014).** `API_TRUSTED_PROXIES` (точні loopback-IP; default порожньо → Fastify `trustProxy: false`); production `127.0.0.1`. Ліміт за адресою — `request.ip` (заголовки в auth-коді не читаються); не-IP від proxy → спільний ключ `unresolved`. Nginx `/api/`: `X-Forwarded-For $remote_addr` (замінює клієнтський) і `X-Forwarded-Host $host`; `Host`, `X-Real-IP`, `X-Forwarded-Proto` без змін. Per-account і hashing limiter, Origin/CSRF не змінювались.

| Перевірка | Результат |
|---|---|
| Regression/security (`backend/test/auth-proxy.test.ts`, Node 22) | 25/25: default ігнорує forwarded-заголовки; недовірений peer не змінює IP; довірений proxy → IP з `X-Forwarded-For`; `X-Real-IP` ніколи не джерело; підроблений ланцюжок не обирає адресу; missing/malformed → визначена поведінка (`unresolved`); незалежні ліміти різних IP; підробка не обходить ліміт (через proxy й напряму); per-account між IP; Origin/CSRF; конфіг (відхилення hostname/CIDR/не-loopback/`*`, ліміт довжини, без echo значень) |
| Доказ регресії | зі старим `socket.remoteAddress` тест незалежних лімітів падає; код відновлено |
| `npm run check:local` | exit 0: node:test 82/82, typecheck, lint, backend 259/259, smoke 10/10, frontend 50/50, збірка UI |
| Node v22.23.3 | backend 259/259, frontend 50/50, node:test 82/82 |
| Real-DB / E2E (тестова БД, без proxy, default config) | 27/27 / 8/8; 0 схем `nc_test_*` після прогону |
| Production-подібний ланцюжок (сервер, ізольовано) | тимчасовий nginx `127.0.0.1:39180` з тими ж заголовками → backend підготовленого релізу `127.0.0.1:39100` (`trustProxy 127.0.0.1`, store-заглушка, без БД), ліміт 2: клієнт 127.0.0.2 з підробленими XFF/X-Real-IP → 401, 401, 429; клієнт 127.0.0.3 → 401, 401 (незалежно); прямий недовірений 127.0.0.4 з підробленим XFF → 401, 401, 429; тимчасові процеси зупинено, каталог видалено |
| Git / артефакт | `005fa62` запушено; 32 файли, SHA-256 `52ada27f…c3cf18a9`, `sha256sum -c` OK; prod deps `fastify`, `node-pg-migrate`, `pg` |
| Nginx | backup `/root/node-control-backups/nginx-trusted-proxy-20261012T192840Z/`; `nginx -t` → +2 рядки в `location /api/` (і перевід рядка в кінці файлу від awk) → `nginx -t` → reload; нових записів у `error.log` немає |
| `api.env` | backup `api.env.bak-20261012T192906Z`; додано лише `API_TRUSTED_PROXIES=127.0.0.1`; `600 nodecontrol`; інші ключі без змін; лог старту: `trustedProxies:1`, `authOrigins:1`, `cookieSecure:true` |
| Активація | міграції pending=0; `current` → `005fa62`; restart лише `node-control-api`; процес `nodecontrol`; listener лише `127.0.0.1:3100` |
| Після деплою | live/ready 200; `https://control.example.com/` 200, `/servers`, `/audit` → index.html; `/api/auth/me` (з підробленими XFF/X-Real-IP) → 401 `no-store`; `/api/nope` → 404 JSON; journal без warn/error, паролів 0; PostgreSQL/Nginx/Docker active, failed 0, менеджер секретів 200; 3100/3101 ззовні недоступні |

Production login/навантажувальні тести не виконувались; пароль адміністратора не змінювався (його сесія збереглась). Rollback (не застосовувався): `server-release.js rollback` (→ `85f047c`) + видалити `API_TRUSTED_PROXIES` / відновити `api.env.bak-20261012T192906Z` + restart API; Nginx — повернути файл із backup, `nginx -t`, reload (заміна XFF безпечна й для старого релізу, тож Nginx можна лишити).

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
2. HBA-правило з `db:setup` дозволяє будь-яку IPv4-адресу для ролі Node Control; захист залежить від мережевих правил хоста. Не відкривати 5432.
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
19. **Мережевий доступ до PostgreSQL** — рекомендовано обмежити джерела на рівні firewall окремим рішенням (деталі — у приватних операційних нотатках).
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

In Progress: Task 013 (alerts, Slack, graceful shutdown), Task 013.1 (admin UI налаштувань і Slack-інтеграції, ADR-022) і Task 013.2 (egress-фікс, layout правил) — очікують незалежного review Codex; Task 013 ще не підтверджено. Completed: Task 012 (review Codex пройдено).

Next Task: узгоджений користувачем порядок: історія метрик → фінальна production-підготовка. Jenkins redeploy перенесений користувачем у далекий backlog після іншої автоматизації; у поточний план запуску не входить. Перед production-запуском — release blockers (5432, NC-SEC-001, hardening публічного сайту).

Planned: узгодити вузьку мережеву політику/TLS і усунути setup-ризики окремим завданням; окремий користувач сервісу й systemd; Fastify API та версійні міграції; агент; React/Vite + Nginx/TLS; авторизація й аудит для кожної адміністративної операції; Jenkins, менеджер секретів, Slack. Після стабілізації MVP — окрема оцінка контейнеризації API/Agents. Це план, а не реалізовані компоненти.


## Незалежний review Codex — об’єднана таблиця сервісів (2026-10-14)

Переглянуто зміни `3ff4653` і звіт `7eece06`; початкове робоче дерево чисте. У переглянутих змінах frontend блокувальних дефектів не знайдено. Це не повний незалежний аудит backend/broker Task 009.

Поточні перевірки на Node.js 22: `check:local` exit 0 (89 node:test, 342 backend, 10 smoke, 122 agent + 3 opt-in пропущені, 103 frontend; typecheck, lint, secrets, усі збірки); браузерні UI-тести зі синтетичними API-даними — 2/2, 1440/390 px. Real-DB і real-PM2 E2E у цьому review не повторювалися; результати Claude вище є історичними.

Read-only SSH: hostname `control-server`, current і RELEASE.json revision `3ff465367b99991a148d4475d773736d2ce5aca1`; API/Nginx active, ready 200, HTTPS `/` 200. У відповіді публічного `/` відсутні CSP, X-Frame-Options, X-Content-Type-Options і Referrer-Policy; hardening лишається відкритим release blocker. Поточну зовнішню доступність 5432 не перевірено, попереднє спостереження не закрито. Production PM2-команди, зміни конфігурації та деплой не виконувалися.

Залишок реалізації за кодом: перегляд/потік логів із обмеженням обсягу й доступу; Jenkins redeploy зі статусом, RBAC та аудитом; alerts/Slack із cooldown, deduplication і recovery; реальний Dashboard, історія метрик і retention; зміна власного пароля й admin-керування користувачами. Перед фінальним production-запуском — відкладені 5432/NC-SEC-001, публічні захисні заголовки та фінальна інтеграційна перевірка. Видалення PM2-процесів і підтримка кількох PM2 owners не включаються автоматично у найближчу задачу.

Документаційний борг: ARCHITECTURE досі містить твердження про необрані транспорт, ролі та міграційний інструмент, хоча вони реалізовані; нижні Next Task/Planned і частина відомих проблем цього документа мають історичні формулювання. Актуальний backlog визначати за кодом і цим review. Запис підготовлено локально; commit/push залишено Claude відповідно до останнього розподілу роботи користувача.


## Незалежний review Codex — Task 010 (2026-10-14)

Переглянуто `401667e` і docs-звіт `af89119`; початкове дерево чисте. Review не підтверджує завершення задачі: знайдено два P2 у ресурсних обмеженнях.

1. **P2 — broker звільняє слот до завершення читання.** `agent/src/control/broker.ts`, handleLogs: Promise.race повертає timeout, але readLogs продовжується; finally зменшує logReads. Відтворено із завислим mock list(): після timeout двох операцій третя починається, хоча всі три ще незавершені (maxConcurrentReads=2). Утримувати слот до фактичного завершення або підтвердженого скасування underlying operation; додати regression-тест повторних timeout і перевірку cleanup.
2. **P2 — кількість очікувачів результату не обмежена.** `backend/src/servers/logs.ts`, LogHub.get: кожен GET додає waiter і timer до одного Entry без per-request/per-actor/global ліміту; маршрут GET не очищає waiter одразу після disconnect. Відтворено 1000 одночасних get() одного запиту одного actor: 1000 waiters прийнято. maxRequests=200 і maxPendingPerActor=2 це не обмежують. Додати ліміти очікувань та cleanup при disconnect, regression для повторних GET, timeout і завершення результату.

Тимчасові локальні reproduction-тести 2/2 підтвердили поведінку й видалені; функціональний код не змінено. На Node.js 22 `check:local` exit 0: 89 node:test, 352 backend, 10 smoke, 163 agent +3 opt-in пропущені, 115 frontend; lint/typecheck/secrets і збірки успішні. UI Playwright із synthetic API: 2/2 desktop/mobile. Real-DB і real-PM2 E2E незалежно не повторювалися.

Read-only SSH підтвердив current `401667e653ed80f395a17a2ffa1c12657b9c9079` на центральному та керованому серверах; API/Nginx active, ready 200; Agent/broker/exporter timer active. **Allowlist ноди зараз: 5 targets, 5 з logs=true.** Початковий звіт деплою повідомляв 0, тому його стан не є поточним; хто й коли ввімкнув читання, цей review не встановлював. Production-текст не читався; конфігурації, служби і PM2-процеси reviewer не змінював. Рекомендація: обмежити використання production-читання до виправлення ресурсних лімітів. Запис review підготовлено локально, без commit/push/deploy.


## Незалежний review Codex — Task 010.1 (2026-10-14)

Переглянуто `2fe4d95` і docs-звіт `f0b320c`; початкове робоче дерево чисте. Обидва попередні P2 закриті в межах перевіреної реалізації: broker звільняє слот лише після завершення underlying read; API обмежує очікувачів (2 на запит, 3 на actor, 100 загалом) і прибирає їх при HTTP disconnect. Нових блокувальних дефектів у переглянутому diff не знайдено.

Незалежний `check:local` на Node.js 22: exit 0, 89 node:test, 358 backend (включно з waiter regression і реальним HTTP abort), 10 smoke, 164 agent (включно з повторними timeout та late resolve/reject) +3 opt-in пропущені, 115 frontend; typecheck/lint/secrets/збірки успішні. UI Playwright із синтетичними API-даними: 2/2 desktop/mobile. Real-DB, загальні E2E і real-PM2 E2E незалежно не повторювалися; результати Claude вище лишаються історичними. Перевірку нових regression на старому коді Codex цього разу не повторював.

Read-only SSH підтвердив current `2fe4d953f69bcf901bfaa73cc3d715a28264d446` на обох серверах; API/Nginx active, ready 200; Agent/broker/exporter timer active. Production-логи не читалися, конфігурації/служби/PM2-процеси reviewer не змінював. Функціональний код не змінено; запис review підготовлено локально без commit/push/deploy. Наступна задача — користувачі й паролі за погодженим roadmap.
