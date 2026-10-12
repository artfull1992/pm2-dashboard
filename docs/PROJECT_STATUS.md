# Поточний стан проєкту

Оновлено: 2026-10-12 (Task 002.1). Початковий commit: `ccbba13dbea512d962dbea5fbeb8bd1cd8b8a5eb` (`chore: initialize node control infrastructure`), гілка `main`, remote `origin`. Початкове робоче дерево чисте. Перевірка доступної історії охопила один commit; це не підтверджує актуальний стан remote або факт попереднього push.

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
10. API ще без сервісного користувача, systemd unit, Nginx і узгодженого серверного порту; health endpoints публічні за задумом, інших маршрутів немає.
11. Логи помилок містять лише `category`/`code` без тексту (ADR-007) — діагностика конкретної помилки потребує відтворення; розширення — окремим рішенням з явно безпечними полями.
12. Fatal handlers (`uncaughtException`/`unhandledRejection`) завершують процес одразу без graceful shutdown; розраховано на перезапуск supervisor'ом (systemd ще не налаштовано).
13. `/health/ready` виконує `SELECT 1` на кожен запит без rate limit/кешу; перед публікацією через Nginx потрібне рішення.
14. Код Task 002.1 не залитий на сервер; на сервері лежить збірка Task 002.

## Активне та заплановане

In Progress: підтвердження серверної частини Task 001; ізоляція старих integration-тестів від production. Task 002 + 002.1 (базовий API, безпечна обробка помилок) завершено локально, без production-деплою; очікує повторного review Codex.

Next Task: authentication/RBAC + Audit Log для API разом зі схемою БД і вибором інструменту версійних міграцій (окреме тестове середовище БД для тестів із записом). Паралельно — read-only серверний аудит Task 001 (HBA, firewall, TLS, сторонні служби) і рішення щодо сервісного користувача/systemd/порту API. Не запускати `db:setup` лише заради перевірки.

Planned: узгодити вузьку мережеву політику/TLS і усунути setup-ризики окремим завданням; окремий користувач сервісу й systemd; Fastify API та версійні міграції; агент; React/Vite + Nginx/TLS; авторизація й аудит для кожної адміністративної операції; Jenkins, менеджер секретів, Slack. Після стабілізації MVP — окрема оцінка контейнеризації API/Agents. Це план, а не реалізовані компоненти.
