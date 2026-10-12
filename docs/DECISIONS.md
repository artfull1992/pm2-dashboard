# Архітектурні рішення

Дата фіксації: 2026-10-12. Прийняті вимоги користувача не означають, що всі компоненти реалізовано.

| Рішення | Причина та наслідки | Стан |
|---|---|---|
| Без Docker для Node Control на поточному етапі | Інтеграція з наявною host-інфраструктурою; сторонні контейнери не змінювати | Обов'язкове зараз |
| PostgreSQL на хості, окрема БД/роль | Ізоляція проєкту, мінімальні привілеї, збереження інших БД | Код setup є; сервер незалежно не перевірений |
| Node.js 22 LTS, Fastify, React + Vite, Node.js Agent | Єдиний runtime та визначений користувачем стек | Fastify-основа API реалізована (Task 002), перевірена на Node 22.23.3; UI/Agent відсутні |
| systemd для backend/agents, host Nginx | Контроль життєвого циклу та reverse proxy без контейнерів | Заплановано |
| Agents самі підключаються до API захищеним каналом | Не потрібні публічні вхідні порти керованих серверів | Обов'язкове; транспорт не обрано |
| Обмежені операції agents, authorization + Audit Log | Уникнення довільного shell та забезпечення підзвітності | Обов'язкове для майбутньої реалізації |
| Існуючі Jenkins pipelines/API та менеджер секретів | Збереження чинних деплой-процесів і джерела секретів | Інтеграції ще відсутні |
| Slack cooldown/deduplication | Стримування повторних алертів, повідомлення про відновлення | Заплановано |
| Версійні відтворювані міграції | Контрольована еволюція схеми та перевірка upgrade/rollback | Інструмент ще не обрано |
| SCRAM verifier генерується в Node і передається SQL через stdin | Відкритий пароль не передається SQL або argv | Реалізовано; verifier теж захищати |
| `.env` або існуючий менеджер секретів; у Git лише шаблон | Секрети не повинні потрапляти в історію та логи | `.env` ігнорується, права локально 600 |
| Розділяти поточні результати та історичний серверний звіт | Не видавати попередні твердження за незалежне підтвердження | Застосовано в PROJECT_STATUS |

## Відкриті рішення

- Звуження поточного `0.0.0.0/0` HBA-правила, перевірка зовнішнього firewall, довірений TLS і режим клієнта. Публічний доступ до PostgreSQL не схвалено; рішення не застосовувати автоматично.
- Модель ролей, authentication, ідентифікація/ротація credentials agents, протокол команд і streaming.
- Схема/retention метрик, логів та Audit Logs, міграційний інструмент, пороги Slack.
- Сервісний користувач, точні systemd sandbox-параметри, схема backup/rollback.

Перед вибором вивчити наявний код, залежності та експлуатаційні вимоги; зміни рішень записувати з причиною й наслідками.

## ADR-001: PostgreSQL і Nginx на хості

Статус: прийнято. Використовувати існуючі host-служби через systemd, окрему БД/роль та ізольовані Nginx-конфігурації. Причина: сумісність із чинною інфраструктурою та контроль впливу на production. Перенесення цих компонентів у Docker не погоджено; серверний стан потребує незалежної перевірки.

## ADR-002: Central API та Agents через systemd

Статус: прийнято для розробки й стабілізації. Node.js 22-сервіси запускаються через systemd із мінімальними правами, graceful shutdown і environment-конфігурацією. Frontend — статична React/Vite-збірка через Nginx. Причина: контроль життєвого циклу без контейнерів. Unit-файли й production-конфігурації ще відсутні.

## ADR-003: PM2 лише для керованих Node.js-проєктів

Статус: прийнято. API та Agent не запускати через PM2, яким керує Agent. Причина: незалежність системи керування від менеджера керованих процесів. Обсяг команд обмежити явними дозволами, Linux-користувачем та PM2_HOME; довільний shell заборонений.

## ADR-004: Docker після стабілізації MVP

Статус: прийнято як план окремої фази; реалізація зараз не дозволена. Після MVP, тестів і стабілізації production можна розглянути API/Agents у Docker за новим завданням. PostgreSQL/Nginx залишаються на хості. Environment-конфігурація має зменшити обсяг майбутнього перенесення; зараз Docker-файли, залежності й контейнери не створювати.

## ADR-005: Claude + Codex workflow із тестами та Git

Статус: прийнято. Claude — основний виконавець коду; Codex — архітектор, автор технічних завдань, незалежний reviewer і резервний виконавець. Контекст зберігати в репозиторії, промпт Claude — один Markdown code block. Релевантні тести, diff/secrets review, lint/typecheck за наявності, документація, commit/push без обходу branch protection обов'язкові. Новий код — TypeScript; Vitest за замовчуванням, чинний node:test зберігається без міграції. Причина: послідовна робота між сесіями та перевірювані результати.

## ADR-006: Інструменти та межі базового Central API

Статус: прийнято (Task 002).

- Fastify 5.12 (офіційно Node 20/22), TypeScript 6.0 strict + `exactOptionalPropertyTypes`, Vitest 5 (Node ≥ 22.12), ESLint 10 + typescript-eslint 8 `strictTypeChecked`, tsx для dev. TypeScript 7 не взято: typescript-eslint 8.71 підтримує лише `<6.1`. Версії зафіксовані точно в `package.json` і lockfile.
- Без нового package manager чи monorepo-інструменту: один кореневий `package.json`; backend-конфіги в `backend/`; ESLint лише для `backend/`, старі JS-скрипти не змінювалися.
- API за замовчуванням слухає `127.0.0.1:3100` (за Nginx у майбутньому). Порт обрано як непривілейований; серверний порт ще не узгоджено.
- `process.env` має пріоритет над `.env`; `ENV_FILE` дозволяє вказати інший файл (для systemd `EnvironmentFile` чи тестів). Невалідна конфігурація блокує старт; недоступна БД — ні (readiness 503).
- Request ID генерує сервер (UUID); клієнтський `x-request-id` ігнорується, щоб не довіряти неперевіреним значенням у логах.
- Readiness — лише `SELECT 1` з таймаутом; відповіді health — мінімальні, причина збою тільки в логах.
- TLS до PostgreSQL у API не вмикається: тільки loopback/SSH-тунель. `rejectUnauthorized:false` заборонено як обхід; віддалене підключення — окреме рішення з перевіркою сертифіката.
- Тест реальної БД — opt-in, лише явні `TEST_DB_*`, без fallback до `.env`; новий `check:local` не запускає production-connected тестів.

## ADR-007: Політика помилок API — метадані замість тексту

Статус: прийнято (Task 002.1, за review Codex).

- Причина: `statusCode` не доводить, що `message` безпечний; redaction заголовків не захищає `message`/`stack`/`cause`. Review показав витік синтетичного секрету в лог (500) і у відповідь (4xx).
- Логи, stderr і fatal-вивід отримують лише `ErrorMeta` = `category` + `code` з allowlist (`os.constants.errno` + `ETIMEDOUT`, `fastify.errorCodes`, SQLSTATE тільки для `pg.DatabaseError`) + HTTP-статус. Текст помилок не логується ніде; попередній `toSafeError` (зберігав довільний `message`) видалено.
- Клієнт: validation → `400` з `location/path/rule` зі схеми; інший 4xx → статус + стандартний HTTP-текст; решта → загальний `500`.
- Наслідок: діагностика спирається на `category`, `code`, подію й `reqId`; деталі конкретної помилки треба відтворювати. Якщо знадобиться більше, — окреме рішення з явно безпечними полями.
- Lifecycle: невдалий старт повертає `StartupError{cleanedUp}`; executable (`server.ts`, не factory) завершує процес одразу, якщо cleanup завис, інакше — через unref-таймер, щоб відкритий handle не тримав процес.

## ADR-008: Деплой Central API — versioned releases + systemd

Статус: прийнято (Task 003).

- Реліз збирається з `git archive` конкретного запушеного commit (не з робочого каталогу); `RELEASE.json` фіксує revision і SHA-256 кожного файлу; сервер перевіряє checksum архіву та manifest до `npm ci --omit=dev` і лише потім публікує `releases/<sha>` (staging + rename). Невдалий prepare не лишає релізу.
- Перемикання — атомарна заміна symlink `current`; попередній зберігається в `previous`, rollback міняє їх місцями. Старі релізи не видаляються автоматично.
- Конфіг `/etc/goit-node-control/api.env` створюється один раз із `DB_*` legacy `.env` і далі лише валідується — повторний деплой не перезаписує credentials і кастомні значення. Єдине джерело — `ENV_FILE` (формат Node `util.parseEnv`), без `EnvironmentFile=`, щоб не було двох джерел із різним синтаксисом.
- Код релізу належить root і недоступний для запису сервісу; сервіс — `nodecontrol` без shell/sudo. Hardening unit: `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `NoNewPrivileges`, порожній `CapabilityBoundingSet`, `SystemCallFilter=@system-service`, `IPAddressAllow=localhost`; `MemoryDenyWriteExecute` не вмикається (V8 JIT).
- Deployment scripts — JS без залежностей у `scripts/deploy/` (як чинні `scripts/`), тести — `node:test`; серверний крок працює до `npm ci`, тому без зовнішніх пакетів.

## ADR-009: Міграції — node-pg-migrate; ізольована тестова БД

Статус: прийнято (Task 004).

- **Інструмент:** `node-pg-migrate` 9.0.0 (engines `node >=20.11`, peer `pg <9`), runtime-залежність (`npm ci --omit=dev` достатньо; `tsx`/Vitest не потрібні). Обрано наявний інструмент замість власного framework: tracking, advisory lock і транзакції вже реалізовані.
- **Формат:** SQL-файли `backend/migrations/<13 цифр>_<name>.sql` (лише `-- Up Migration`), без компіляції TS-міграцій; пакуються в реліз і перевіряються manifest.
- **Tracking:** таблиця `pgmigrations` (`id`, `name`, `run_on`) у цільовій схемі; `checkOrder` забороняє застосування «в минуле».
- **Locking:** `advisoryLockMode: 'wait'` — `pg_advisory_lock` береться до створення tracking-таблиці; очікування обмежене `lock_timeout` (10 с) сесії міграції. Конкурентні `up` серіалізуються; перевірено 3 паралельними запусками.
- **Транзакції/помилки:** `singleTransaction: true` — усі pending в одній транзакції; помилка → `ROLLBACK`, без часткових об'єктів і рядків tracking (tracking-таблиця створюється до транзакції й лишається порожньою). `statement_timeout` 60 с.
- **CLI:** `migrate.js status|up`; без `down/reset` для production. Вивід помилок — лише ErrorMeta (ADR-007). Конфіг — `ENV_FILE`/`DB_*`; у production запускається як `nodecontrol` з підготовленого релізу, не як superuser. API не запускає міграції при старті; HTTP-endpoint для міграцій немає.
- **Тестова БД:** `node_control_test_db`/`node_control_test_user` на тому ж кластері; створює `scripts/setup-test-db.js` (SCRAM verifier через stdin, пароль у файлі `600`, без тихої ротації, `COMMENT` як маркер походження). Production-роль і HBA не змінювались: ізоляція забезпечена `REVOKE ALL ... FROM PUBLIC` на обох БД.
- **Захист тестів:** лише `TEST_DB_*`/`TEST_DB_ENV_FILE`, відхилення production-імен, перевірка `current_database()/current_user`, per-run схема `nc_test_<ms>_<hex8>`, cleanup тільки цієї схеми. Старий `tests/integration` переведено на read-only.

## ADR-010: Контракт таблиці `users`

Статус: прийнято (Task 004). Таблиця — основа майбутньої authentication; сама authentication **не** реалізована.

- `id uuid` PK, `DEFAULT gen_random_uuid()` — функція ядра PostgreSQL ≥13, extension не потрібен.
- `email text NOT NULL`: застосунок нормалізує `lower(trim(email))` перед записом; `CHECK (email = lower(btrim(email)))` відхиляє ненормалізоване, тому `UNIQUE (email)` фактично case-insensitive. Простий формат-check (`x@y`, 3–254 символи); повна валідація — у застосунку.
- `password_hash text NOT NULL`, непорожній; лише закодований hash (алгоритм обирається в authentication task), ніколи plaintext.
- `is_active boolean NOT NULL DEFAULT true`; `created_at`/`updated_at timestamptz NOT NULL DEFAULT now()`; `updated_at` підтримує тригер `users_set_updated_at` (BEFORE UPDATE), не код застосунку.
- Без seeds, default admin, ролей, сесій чи audit-таблиць — вони з'являться в наступних завданнях окремими міграціями.
