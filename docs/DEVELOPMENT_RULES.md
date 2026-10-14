# Правила розробки, перевірок і деплою

Основні обмеження — [AGENTS.md](../AGENTS.md); стан перевірок — [PROJECT_STATUS](PROJECT_STATUS.md). Працювати малими змінами в межах завдання, не ламати існуючі компоненти й сторонню інфраструктуру.

## Перевірки

Новий backend/frontend/agent код — TypeScript зі строгими типами, валідацією зовнішніх даних, централізованими логами без секретів, обробкою помилок і graceful shutdown. Зберігати conventions, аналізувати залежності, не дублювати функції; чинні JS-скрипти не мігрувати без потреби. Сервіси не запускати від root без доведеної необхідності.

Прикладний SQL — параметризований, пов'язані операції — транзакційні. Наявні setup SQL builders обмежують identifiers/екранують literals; це не заміна параметризованих запитів API. Agent: авторизація кожної команди, Audit Log керуючих дій, мінімальні права та явні дозволи на процеси з урахуванням Linux-користувача/PM2_HOME. Remote execution endpoint заборонений.

Agent/machine routes (Task 007): machine-маршрути декларують `config.access: { machine: 'agent' }`; тести — розділення browser/machine credentials, підміна ідентичності, ліміти, malformed payload; real-DB — конкурентність (ротація, heartbeat, revoke). Agent — лише Node built-ins, без `rejectUnauthorized:false`, без HTTP поза loopback dev-режимом.

Frontend (Task 006): нові екрани — компонентні тести (стани loading/empty/error/forbidden/unavailable), без HTML з API, без web storage для сесійних даних; auth-сценарії — Playwright E2E лише проти тестової БД. Dev-backend для UI — `NODE_ENV=development`, `AUTH_COOKIE_SECURE=false` лише на loopback, `AUTH_ALLOWED_ORIGINS=http://127.0.0.1:5173`.

Auth/RBAC (Task 005): кожен новий `/api`-маршрут декларує `config.access`; тести — позитивні, 401, 403 (матриця ролей) і для state-changing — Origin/CSRF; API-тести використовують `FakeAuthStore` (атомарна семантика), SQL-семантика — `backend/test/db/auth.test.ts` у тестовій БД. Request-схеми лише з явними `properties` і `additionalProperties: false` (NC-SEC-001 відкрито).

Для нового коду використовувати Vitest для unit/integration, якщо відступ не обґрунтований. Існуючий node:test зберегти: чинні скрипти вже покриті ним. Frontend E2E може використовувати Playwright. Endpoint: позитивні, негативні та authorization tests; адміністративна дія: дозволені й заборонені сценарії. Критичні компоненти (authentication, RBAC, Agent commands, process management, DB access, deploy, Audit Logs) мають орієнтир 100% покриття.

| Команда | Призначення та передумови |
|---|---|
| `npm ci` | Встановлення з lockfile; не змінювати залежності без потреби |
| `npm test` | Unit helpers, без БД; потрібен підтримуваний Node |
| `npm run check:secrets` | `.env` ignored/untracked, шаблони секретів і поточний DB_PASS у committable files |
| `npm run test:integration` | Валідний `.env`, реальна доступна БД; serial suites |
| `npm run db:check` | SELECT 1 із поточною конфігурацією; без налаштування БД |
| `npm run check` | Secrets → unit → integration; зупиняється при помилці |
| `npm run typecheck` / `npm run lint` | TypeScript strict / ESLint `strictTypeChecked` для `backend/` |
| `npm run test:backend` | Vitest: config, API (inject), database, lifecycle; без мережевої БД |
| `npm run test:backend:smoke` | Build + запуск скомпільованого API як процесу з контрольованим env |
| `npm run test:backend:db` | Реальна **тестова** PostgreSQL: міграції (DDL/DML у per-run схемі) + readiness. Лише явні `TEST_DB_*`/`TEST_DB_ENV_FILE`, production-цілі відхиляються |
| `npm run db:migrate:status` / `db:migrate:up` | CLI міграцій зі зібраного `backend/dist` (`ENV_FILE` або `DB_*`); production `up` — лише за процедурою DEPLOYMENT |
| `node scripts/setup-test-db.js` | Root на сервері: створення/перевірка ізольованої тестової БД і ролі |
| `node backend/dist/bootstrap-admin.js` | Створення першого адміністратора (лише оператор; у тестах — тестова БД) |
| `npm run frontend:dev` / `frontend:build` / `frontend:preview` | Vite лише на 127.0.0.1; `/api` проксюється на 127.0.0.1:3100 без зміни Origin |
| `npm run test:frontend` | Vitest + jsdom: API-клієнт, auth/гонки, маршрути, audit |
| `npm run test:e2e` | Playwright: реальний backend + збірка UI; лише `TEST_DB_*`, per-run схема, без traces/screenshots |
| `npm run test:agent` / `agent:build` | Vitest для Agent і PM2 exporter (конфіг, snapshot, TLS/redirect, backoff, loop, протокол PM2 на фейковому daemon, санітизація, безпека файлу); збірка `agent/dist` |
| `npm run test:agent:pm2` | Opt-in: справжній одноразовий PM2 (`pm2@7.0.4` через npx, не залежність проєкту — AGPL) у тимчасовому `PM2_HOME`; доказ відсутності auto-start. Ніколи проти PM2 користувачів чи production |
| `npm run check:local` | Secrets → старі unit → typecheck → lint → backend → smoke; без production-connected тестів |

Обов'язкова цільова перевірка — Node.js 22 LTS. Старий `tests/integration` (node:test, `.env`, production `node_control_db`) з Task 004 **лише read-only**: перевірки прав #9/#10 виконуються через каталоги PostgreSQL, без CREATE/INSERT/DROP. Тести із записом — тільки `backend/test/db/*` проти `node_control_test_db` у власній схемі `nc_test_<ms>_<hex8>`; cleanup видаляє лише цю схему, ніколи БД. Привілейований suite потребує root на хості PostgreSQL (`runuser`, `psql`, systemd); локально пропускається з поясненням. Успіх локально не замінює серверну перевірку.

Production-дані під час тестування не змінювати. Тести із записом — лише в ізольованій `node_control_test_db` (Task 004); `tests/integration` проти production — read-only. Read-only аудит і тести із записом розділяти.

Для реалізації потрібні unit та integration tests; для API — API tests, користувацьких сценаріїв — E2E, прав доступу — security, багів — regression. Перевіряти реальні результати та негативні сценарії, не копіювати код у фіктивні assertions. Ціль — 100% нового/зміненого коду, де доцільно. Документаційні зміни перевіряти на узгодженість із кодом і працездатність локальних посилань; вони не потребують вигаданих API/E2E тестів.

При падінні тестів визначити причину. Не видаляти перевірки, не позначати недоступну БД як успіх, не називати build успішним при падінні тестів. Виправлення поза поточним обсягом оформити окремою задачею. Lint і typecheck налаштовані для `backend/`; formatter відсутній — перевіряти `git diff --check`, не заявляти про запуск неіснуючих інструментів.

## Git та review

Перед змінами — status і history; перед commit — повний diff, секрети, релевантні тести та доступні статичні перевірки. Додавати лише власні зміни явними шляхами. Не комітити `.env`, tokens, ключі, DB dumps або credential-bearing logs. Сканер не перевіряє всю історію самостійно й має обмеження розміру/шаблонів; за підозри перевіряти історію без виводу значень.

Commit має описувати фактичну зміну. Push — у поточну дозволену робочу гілку після успіху перевірок; захист `main` не обходити, force push заборонений. Документаційний commit із зафіксованими невдалими integration checks не підтверджує готовність коду. У звіті зазначити branch, hash, результати й фактичний push status.

## Деплой

1. Звірити scope, версію коду, конфігурацію без секретів, залежності та тести. Визначити користувача сервісу, шляхи й rollback до змін.
2. Підготувати backup тільки потрібних конфігурацій/даних і контрольований спосіб відновлення. Не відкривати PostgreSQL ззовні, не змінювати сторонні сервіси.
3. Виконати лише погоджені зміни. Nginx: конфігурація в `/etc/nginx/`, перед застосуванням `nginx -t`. Backend/agents: systemd, мінімальні права. `db:setup` — мутація з root, не перевірка стану.
4. Перевірити systemd status, health endpoint (коли буде реалізовано), логи, доступність, сторонні сервіси й критичні помилки. При невдачі — rollback за планом і повторна перевірка.

Деплой — лише versioned-артефактом (`scripts/deploy/build-release.js` → `server-release.js`, DEPLOYMENT). Історичний rsync у `/etc/pm2-dashboard` не використовується. Конфіг сервісу — `/etc/goit-node-control/api.env` (`600 nodecontrol`).

Перед commit запускати `npm run typecheck` і `npm run lint` (backend, frontend, e2e); для старих JS-скриптів lint не налаштований. За актуальним bootstrap-запитом документаційний push дозволений після успішних релевантних перевірок документів, unit-тестів і секретів із чесним зазначенням недоступності БД. Це не дозвіл на деплой із failing tests.

Фактичний workflow та backward-compatible rollback міграцій — [DEPLOYMENT](DEPLOYMENT.md).

### PM2 inventory (Task 008)

- **Жодних `pm2`-команд поза тимчасовим `PM2_HOME`**, навіть `pm2 --version`: без `PM2_HOME` CLI запускає daemon у `~/.pm2` поточного користувача.
- Код exporter не імпортує `pm2` і `child_process` і викликає лише `getMonitorData` (це перевіряє тест). Нові PM2-методи — лише окремим рішенням (ADR).
- Сирий `pm2_env` не серіалізується, не логується і не передається далі: тільки allowlist-поля; тести — із синтетичними секретами в усіх полях `pm2_env`.
- Відсутні метрики — `null`, не 0; `unavailable` ≠ порожній список.
- JSON schemas на `/api` строгі (Ajv `removeAdditional: false`): нові клієнти не можуть надсилати недокументовані поля.

### Керування PM2 (Task 009)

- Нові PM2-методи — лише через тип `Pm2Method` у `agent/src/pm2/rpc.ts` і окреме рішення (ADR). Створення/видалення/reload/signal/stdin — заборонені.
- Broker: жодних shell/exec/eval, лише типізовані запити; результати — з enum причин, без тексту PM2.
- Тести керування на справжньому PM2 — лише одноразовий `PM2_HOME` (`npm run test:agent:pm2`, `npm run test:e2e:pm2`); `NC_BROKER_ALLOW_SELF_OWNED_ALLOWLIST` і `NC_AGENT_INVENTORY_ALLOW_SAME_OWNER` — лише в тестах.
- `test:e2e:pm2` запускається окремим прогоном: разом з іншими специфікаціями адміністратор перевищив би ліміт входів на акаунт (5 за 15 хв), який для тестів не послаблюється.
- UI ніколи не повторює мутацію автоматично й не показує «успішно» до підтвердженого статусу команди.

### Логи (Task 010)

- Текст логів не логувати, не писати в БД/audit, не класти в storage/URL; у тестах — синтетичні маркери й перевірка їх відсутності в журналах і audit.
- Broker читає лише шляхи з PM2 metadata у дозволених каталогах (`NC_BROKER_LOG_DIRS`); жодних шляхів/offset/glob від клієнта.
- Long-poll у Fastify: відключення клієнта слухати на `reply.raw` ('close'), не на `request.raw` (там 'close' спрацьовує після читання тіла). Регресійний тест — через справжній HTTP (`app.listen`), не `inject`.
- На macOS тимчасові каталоги — symlink (`/var` → `/private/var`): для тестів читання логів використовувати `realpathSync`.
