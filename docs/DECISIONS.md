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
- ~~Сервісний користувач, systemd sandbox, backup/rollback~~ — вирішено в ADR-008/009 (Task 003/004).

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
- API за замовчуванням слухає `127.0.0.1:3100`; з Task 003 це затверджений серверний порт (ADR-008).
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

## ADR-011: Authentication, сесії, CSRF, RBAC та audit

Статус: прийнято (Task 005). Публічний production-запуск **не** погоджено (див. PROJECT_STATUS, release blockers).

**Паролі.** `node:crypto.scrypt` (async), формат `scrypt$v1$N=32768,r=8,p=1$<salt16 b64url>$<key32 b64url>`; сіль 16 байтів на пароль. ~32 MiB пам'яті на перевірку, `maxmem` 64 MiB. Перевірка приймає лише `N` — степінь 2 від 2^14 до 2^16, `r = 8`, `p` 1–2, сіль 16 / ключ 32 байти, рядок ≤ 200 символів — інакше `PasswordHashFormatError`. Порівняння — `timingSafeEqual`. Не більше 4 паралельних scrypt, черга ≤ 32; переповнення → 503 + `Retry-After: 1`. Політика: 12–128 code points і ≤ 512 байтів UTF-8; пароль не обрізається й не нормалізується. Невідомий користувач → dummy verification тієї ж вартості.

**Сесії.** Opaque token 32 випадкових байти (base64url) у cookie; у `sessions.token_hash` — лише SHA-256. Абсолютний TTL `AUTH_SESSION_TTL_MINUTES` (15–1440, default 480), без продовження. Login завжди видає новий token; cookie, з яким прийшов клієнт, відкликається в тій самій транзакції (fixation). Кожен запит перечитує `users.role`/`is_active`: зміна ролі чи деактивація діють одразу. Logout відкликає сесію й очищає cookie. Очищення: у транзакції кожного login видаляються сесії цього користувача, що закінчились/відкликані понад добу тому; фонового процесу немає (масове прибирання — ручний SQL у DEPLOYMENT).

**Cookie.** `__Host-nc_session=<token>; Path=/; HttpOnly; SameSite=Strict; Max-Age=<ttl>; Secure`, без `Domain`. `AUTH_COOKIE_SECURE=false` (cookie `nc_session` без `Secure`) дозволено лише поза production і з loopback `API_HOST` — інакше старт блокується `ConfigError`.

**CSRF.** (1) Для кожного state-changing `/api`-запиту (включно з login — захист від login CSRF) `Origin` має точно збігатися з `AUTH_ALLOWED_ORIGINS` (≤ 10 точних origin; https; http лише для loopback поза production). Відсутній `Origin` → 403 (браузери надсилають його на POST; інші клієнти мусять задати явно). `Sec-Fetch-Site`, якщо присутній, має бути `same-origin`. Порожній allowlist → усі такі запити відхиляються (fail closed; поточний production). (2) Для автентифікованих state-changing запитів (logout і майбутні) — заголовок `x-csrf-token` = `base64url(HMAC-SHA256(key = session token, "nc-csrf-v1"))`, отримується з `login`/`me`; порівняння constant-time. SameSite — додатковий, не єдиний захист. CORS не вмикається; frontend працює same-origin (Vite proxy / Nginx). `trustProxy` вимкнено.

**Rate limiting.** До будь-якого lookup і hashing: ≤ 5 спроб / 15 хв на SHA-256 нормалізованого email і ≤ 30 / 15 хв на адресу сокета; 429 + `Retry-After`. Пам'ять обмежена 10 000 ключів на лімітер. Стан у процесі: скидається при рестарті, коректний лише для одного інстансу. Адреса клієнта за reverse proxy — ADR-014. Постійного lockout немає.

**RBAC.** Одна роль: `viewer` → `monitoring:read`; `operator` → + `processes:control`; `admin` → + `users:manage`, `audit:read`. Дозволи виводяться на сервері з актуальної ролі в БД. Кожен `/api`-маршрут декларує `config.access` (`public` | `authenticated` | `{ permission }`), інакше реєстрація падає (deny by default). Порядок: Origin → сесія (401) → CSRF (403) → permission (403 + `authz.denied`). `monitoring:read`, `processes:control`, `users:manage` поки лише контракт — endpoints немає.

**Schema/audit.** Міграція `1791900000001_auth-foundation` (additive): `users.role` (CHECK, default `viewer`), `sessions` (FK `ON DELETE CASCADE`, унікальний 32-байтний digest, `expires_at > created_at`, індекси), `audit_log` (identity PK, `event`/`outcome` CHECK, `actor_user_id` `ON DELETE SET NULL`, `request_id`, `details jsonb` лише object ≤ 2 KiB). Події: `admin.bootstrap`, `auth.login` success/failure (`reason`: `invalid_credentials`|`inactive_user`; для невідомого email — `actor_user_id = NULL`, email не зберігається), `auth.logout`, `authz.denied` (`permission`, шаблон маршруту). Login-сесія + audit, logout + audit, bootstrap user + audit — одна транзакція (`transaction_timeout` 5 с); збій audit → 503 і мутації немає. Failed-login/denied audit — best effort: збій запису логується, а доступ лишається забороненим (401/403). Збій БД при lookup/сесії → 503 (fail closed). `GET /api/audit` — keyset за `id DESC`, `limit` 1–100.

**Bootstrap.** `backend/dist/bootstrap-admin.js --email <e> [--password-stdin]`: пароль — прихований TTY-ввід двічі або stdin (≤ 4 KiB, один рядок), ніколи argv; конфіг БД — `ENV_FILE`/`DB_*`; транзакція з `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`, відмова, якщо адмін уже є або email зайнятий (без підвищення/скидання пароля); user + `admin.bootstrap` атомарно. Коди виходу: 0 створено, 2 ввід/usage, 3 відмова, 1 помилка. HTTP-bootstrap і default credentials відсутні.

## ADR-012: Frontend — React + Vite, same-origin, сесія лише в пам'яті

Статус: прийнято (Task 006).

- **Стек:** React 19.3, React Router 8.4 (declarative routes), Vite 8.3 (`@vitejs/plugin-react` 6), TypeScript strict; тести — Vitest + jsdom 29 (jsdom 30 вимагає Node `^24.15`), Testing Library; E2E — Playwright 1.64 (Chromium). Перевірено engines/peer: React Router 8 — Node ≥ 22.22, React ≥ 19.2.7; Vite 8 — Node ≥ 22.12. Без state-менеджерів і UI-бібліотек.
- **Залежності — devDependencies** в кореневому `package.json`/lockfile (без workspaces): UI збирається в статику; production `npm ci --omit=dev` їх не встановлює.
- **Same-origin:** у production статику й `/api/` віддає host Nginx з одного origin; у розробці/E2E — Vite proxy з того самого loopback-origin. CORS не вмикається; Origin не підмінюється (CSRF-перевірки ADR-011 працюють як є).
- **Сесія:** HttpOnly cookie керує браузер; `user/permissions/csrfToken/expiresAt` — лише в пам'яті React; жодних токенів/паролів у web storage/URL/логах. Захист від гонок — «епохи» сесії (logout, expiry, новий login скасовують і ігнорують старі відповіді); приватна область перемонтовується на кожну сесію. Таймер на `expiresAt` перевіряє сесію в сервера.
- **API-клієнт:** відносні `/api`, timeout 10 с + `AbortSignal`, без автоповторів, runtime-валідація (`frontend/src/api/types.ts`), фіксовані українські повідомлення за типом помилки; 503/мережа на старті — екран «недоступно» з retry, не logout.
- **Права в UI** — лише UX; прямий URL перевіряється (`RequirePermission`), backend — джерело авторизації. Redirect після login — тільки внутрішній шлях.
- **E2E:** реальний скомпільований backend і `vite preview` production-збірки; тестова БД через guards ADR-009, per-run схема, тестові користувачі лише в ній; паролі випадкові на прогін; без traces/screenshots/video.
- **Nginx:** окремий loopback-сайт `127.0.0.1:3101` (не публічний), статика з `current/frontend/dist`, `/api/` без зміни URI, SPA fallback лише для не-`/api` шляхів, CSP `default-src 'self'` (тому в UI немає inline-стилів/скриптів), `immutable` кеш для hashed assets.

## ADR-013: Публічний HTTPS-сайт замість loopback-сайту

Статус: прийнято (Task 006, оновлення користувача). Замінює Nginx-пункт ADR-012.

- Власник сервера налаштував `https://control.example.com` (`/etc/nginx/conf.d/control.example.com.conf`, Let's Encrypt): статика `current/frontend/dist`, `/api/` → `127.0.0.1:3100` зі збереженням URI. Ізольований loopback-сайт `127.0.0.1:3101` більше не потрібен — прибрано з сервера (з backup) і з репозиторію.
- Конфіг сайту не є частиною артефакту й не змінюється деплоєм; задачі Node Control лише перевіряють його (root, proxy, TLS, `nginx -t`).
- `AUTH_ALLOWED_ORIGINS=https://control.example.com`, `AUTH_COOKIE_SECURE=true`. Вхід можливий лише після створення адміністратора оператором.
- Рекомендації власнику (не застосовані): заголовки безпеки (CSP `default-src 'self'`, `X-Frame-Options DENY`, `nosniff`, `Referrer-Policy`), `Cache-Control: no-cache` для SPA-маршрутів (зараз лише для `/index.html`), `immutable` для `/assets/`, `try_files $uri =404` для `/assets/`, HSTS.

## ADR-014: Довірений reverse proxy для адреси клієнта

Статус: прийнято (Task 006.1, review Codex P1).

- **Проблема:** за Nginx `request.socket.remoteAddress` завжди `127.0.0.1`, тож усі клієнти ділили ліміт 30 спроб / 15 хв за адресою — будь-хто міг заблокувати вхід іншим.
- **Рішення:** `API_TRUSTED_PROXIES` — список точних loopback-IP (≤ 4; без hostname, CIDR, wildcard, не-loopback). Порожньо (default, розробка, E2E) → Fastify `trustProxy: false`. Інакше `trustProxy` = цей список (не `true`). Ліміт за адресою використовує `request.ip`; auth-код заголовки не читає. Невалідна IP-адреса від proxy → один спільний ключ `unresolved`, а не ключ, обраний клієнтом.
- **Nginx (узгоджена пара):** `proxy_set_header X-Forwarded-For $remote_addr` **замінює** клієнтський заголовок (не `$proxy_add_x_forwarded_for`), `X-Forwarded-Host $host`, `X-Forwarded-Proto $scheme`; `X-Real-IP` API не використовує. Запити від недовіреного peer (не з `API_TRUSTED_PROXIES`) — forwarded-заголовки ігноруються.
- **Межі:** per-account ліміт, hashing limiter, Origin/CSRF без змін. `request.ip` не логується і не пишеться в audit. Стан лімітерів — у пам'яті одного процесу (як і раніше).

## ADR-015: Реєстр серверів, machine authentication і Agent heartbeat

Статус: прийнято (Task 007).

- **Протокол:** Agent сам ініціює `POST /api/agent/heartbeat` через HTTPS (той самий `/api/` proxy), кожні 30 с (сервер повертає `intervalSeconds`, Agent обмежує 5–300 с). WebSocket не потрібен — керуючих команд немає. Agent не слухає портів, не отримує команд, не читає credentials застосунків, не має DB credentials, не запускається через PM2.
- **Повідомлення:** snapshot лише з полів `agentVersion, hostname, platform, arch, uptimeSeconds, cpuCount, loadAverage[3], memory{totalBytes,freeBytes}`; JSON schema з `additionalProperties:false`, межі довжин/діапазонів, `freeBytes ≤ totalBytes`; body ≤ 4 KiB. Payload вважається повідомленням авторизованого Agent, а не правдою: ідентичність сервера визначає credential, не payload.
- **Machine auth:** `config.access: { machine: 'agent' }` — окремий режим deny-by-default контракту. Лише `Authorization: Bearer ncag_<43 base64url>` (32 random bytes); у БД — SHA-256 (`agent_credentials.token_hash`), одна активна credential на сервер (частковий унікальний індекс). Запит із `Origin`/`Sec-Fetch-*` (браузерний контекст) → 403; із cookie сесії → 401; браузерні маршрути відхиляють будь-який `Authorization` (401) — режими не змішуються. Bearer token — авторизація, а не захист від replay при крадіжці (TLS + ротація/відкликання).
- **Ліміти:** до будь-якої роботи з БД — 120 запитів/хв на адресу клієнта (`request.ip`, ADR-014) і 20/хв на digest токена (bounded maps, 10 000 ключів); ≤ 8 одночасних heartbeat-транзакцій (черга 16) → інакше 503.
- **Lifecycle credential:** видається лише явною admin-дією (`servers:manage`, Origin + CSRF), відповідь `no-store`, токен показується один раз; нова видача атомарно відкликає попередню; revoke не видаляє сервер чи audit. Мутації й audit (`server.created`, `agent.credential_issued{rotated}`, `agent.credential_revoked{revoked}`) — одна транзакція. Heartbeat в audit не пишеться.
- **Heartbeat/конкурентність:** транзакція `SELECT … FOR SHARE` credential+server (revoke чекає → після коміту revoke heartbeat не приймається), `received_at = clock_timestamp()` сервера, upsert `WHERE received_at <= EXCLUDED.received_at` (новіший snapshot не перезаписується старішим). `revoked_at = clock_timestamp()` (після очікування блокування `now()` міг бути раніше за щойно створену credential).
- **Online/offline:** `online` — `received_at` новіший за 90 с за годинником БД; `offline` — старіший; `never_connected` — heartbeat ще не було. Створення запису ніколи не дає `online`. Історію (time-series) не зберігаємо — лише останній snapshot.
- **Agent:** TypeScript strict, лише Node built-ins; HTTPS-only (HTTP — лише явний loopback dev/E2E прапорець), TLS verification за замовчуванням без опції вимкнення, `redirect: 'error'`; timeout запиту; послідовний цикл без overlap; backoff з full jitter до `NC_AGENT_MAX_BACKOFF_SECONDS`; 401/403 → максимальна пауза; 429 → обмежений `Retry-After`; SIGTERM скасовує сон і запит. Конфіг-файл 600 і власник перевіряються; лог — лише метадані (outcome, затримка), без токена.
- **Deployment:** окремий артефакт і база релізів `/opt/goit-node-control-agent`, користувач `nodecontrol-agent`, unit із hardening без `IPAddressAllow=localhost`; без токена unit завершується з кодом 2 і не перезапускається по колу.
- **Frontend:** `servers:manage` лише admin; опитування раз на 15 с лише для видимої вкладки зі скасуванням і захистом від застарілих відповідей; одноразовий діалог ключа (після закриття — видалено зі state, не логуються).
- **Ідентичність ресурсу в UI (Task 007.1):** стан `usePolledResource` прив'язаний до ключа ресурсу (id сервера): після зміни ключа в тому самому render повертається `loading`, помилка нового ресурсу не підставляє дані попереднього; останні дані зберігаються лише при невдалому оновленні того самого ресурсу. `CredentialControls` монтується з `key = id сервера + сесія` — підтвердження, помилки та виданий ключ не переживають зміну сервера, logout чи нову сесію. Мутація бере id із props свого екземпляра, скасовується при unmount, а її результат після скасування або з чужим `serverId` ігнорується (чужий `serverId` показується як помилка). Скасування в браузері не означає відкат: сервер міг уже виконати дію; автоматичних повторів немає.
- **Контракт відповіді heartbeat (Task 007.1):** `accepted` лише після повністю прочитаного body успішної відповіді: `200` і JSON `{status:"accepted", receivedAt: ISO-8601 UTC з мілісекундами (як toISOString), intervalSeconds: ціле 5–300}` (backend надсилає 30; додаткові поля ігноруються для сумісності з майбутніми версіями API). Один timeout (`NC_AGENT_TIMEOUT_SECONDS`) і сигнал скасування охоплюють і запит, і читання body. Body обмежено 4096 байтами за фактичними байтами потоку; завеликий `Content-Length` відхиляється без читання. Outcomes: обрив/помилка потоку → `network`, дедлайн → `timeout`, скасування → `aborted`, порожній/завеликий/не-UTF-8/не-JSON/порушений контракт → `invalid_response` (звичайний експоненційний backoff, лічильник збоїв не скидається). Для 401/403/429/інших 4xx/5xx body не читається (скасовується), класифікація лише за статусом. У лог потрапляють тільки outcome, затримка й кількість збоїв.

## ADR-016: Read-only PM2 inventory через локальний exporter

Статус: прийнято (Task 008). Керування процесами (start/stop/restart/delete), логи, redeploy і Jenkins — **не реалізовані**.

**Проблема доступу.** PM2 daemon працює від конкретного Linux-користувача з конкретним `PM2_HOME`; керування — через unix-сокет `PM2_HOME/rpc.sock`, який PM2 створює з правами `775` (будь-хто з основної групи власника може віддавати команди). Стандартний клієнт pm2 (`pm2 jlist`, `pm2.connect`, `Client.executeRemote`) **запускає daemon**, якщо його немає (`launchDaemon`), тобто довільний запуск `pm2` від іншого користувача створює новий daemon. Відповідь `getMonitorData` містить повний `pm2_env` (зокрема env-змінні застосунків із секретами).

**Рішення — три ролі з мінімальними правами:**

| Компонент | Користувач | Може | Не може |
|---|---|---|---|
| Exporter (`agent/dist/pm2-exporter.js`, systemd timer `node-control-pm2-exporter@<owner>`) | власник PM2 (не root; `ConditionUser=!root`, перевірка uid у коді) | `connect()` до існуючого `rpc.sock`, один виклик `getMonitorData`, атомарний запис snapshot у `/var/lib/goit-node-control-pm2` | мережа (`RestrictAddressFamilies=AF_UNIX`, `IPAddressDeny=any`), токен API, DB credentials, listener, shell-команди, інші PM2-методи |
| Agent (`nodecontrol-agent`) | окремий системний користувач | читати лише snapshot-файл (група `nc-pm2-inventory`), надсилати його в API | доступ до `PM2_HOME`/`rpc.sock` (не в групі власника PM2), запис у каталог snapshot, підробка файлу (Agent відхиляє файли, якими сам володіє) |
| API | `nodecontrol` | зберігати останній inventory, показувати його | будь-які PM2-команди (таких маршрутів немає) |

- **Без auto-start.** Exporter не використовує пакет `pm2` і не запускає дочірніх процесів: власний мінімальний клієнт протоколу PM2 (axon req/rep поверх amp: `[j:{type:'call',method:'getMonitorData',args:[{}]}, s:<id>]` → `[j:{args:[list]}|j:{error}, s:<id>]`). Немає `rpc.sock` → `unavailable/daemon_not_running`, нічого не створюється; `ECONNREFUSED`/`ENOENT` → те саме; `EACCES` → `permission_denied`. Доказ — unit-тести (фейковий daemon, статична перевірка відсутності `child_process`/`pm2`) і opt-in тест зі справжнім одноразовим PM2 у тимчасовому `PM2_HOME` (`npm run test:agent:pm2`).
- **Межа «read-only».** Read-only означає, що код викликає тільки `getMonitorData`. Це **не** OS-рівнева ізоляція: процес власника PM2 із доступом до `rpc.sock` технічно міг би віддати будь-яку команду. Тому exporter мінімальний, без мережі й без вхідних даних від API/користувачів.
- **Санітизація (allowlist).** Із сирої відповіді копіюються лише: `pm_id`, `name` (керівні символи → U+FFFD, ≤128 символів без розриву surrogate pair), `status` (невідомий → `unknown`), `uptimeSeconds` (з `pm_uptime` лише для `online` і лише якщо час правдоподібний: не в майбутньому понад 60 с, не старший за 10 років), `restarts`, `cpuPercent`/`memoryBytes` (лише для `online`; для інших статусів PM2 віддає штучний 0 → `null`), `execMode` (`fork`/`cluster`). Відсутнє/неправдоподібне → `null`, ніколи 0. Дублікат `pm_id`, некоректний `pm_id`/ім'я, > 500 процесів → весь snapshot `unavailable` (`invalid_data`/`too_many_processes`). Відповідь daemon ≤ 64 MiB, timeout 1–60 с (типово 10), лише в пам'яті exporter.
- **Snapshot-файл** `{format:'goit-node-control/pm2-inventory', version:1, source, capturedAt, state:'ok'|'unavailable', reason, processes}` ≤ 512 KiB. Запис: каталог має існувати, належати exporter і не бути group/other-writable; тимчасовий файл `O_CREAT|O_EXCL|O_NOFOLLOW` `0640` → `fsync` → `rename` (атомарно); symlink/чужий файл на місці цілі → відмова. Каталог `2750 <owner>:nc-pm2-inventory` (setgid: файл отримує групу читання). Читання Agent: відмова для symlink, group/other-writable файлу чи каталогу, файлу/каталогу, яким володіє сам Agent, розміру > ліміту, підміни inode між `lstat` і `open`, будь-якого відхилення від контракту. При збої exporter записує `unavailable` з новим `capturedAt` — старі процеси не видаються за новий збір.
- **Протокол Agent → API.** Окремий `POST /api/agent/inventory` (той самий machine auth, `config.access: { machine: 'agent' }`; identity лише з credential; revoked/inactive → 401; body ≤ 512 KiB, ≤ 500 процесів, strict schema; конкурентність 4 + черга 8 → 503). Окремий послідовний цикл Agent (інтервал 30–600 с, типово 60), незалежний від heartbeat: збій inventory не зупиняє heartbeat. Snapshot старший за `NC_AGENT_INVENTORY_MAX_AGE_SECONDS` (типово 120) → звіт `stale` **без процесів**; майбутній `capturedAt` (> 5 хв) → `snapshot_invalid`. Відповідь API `{status:'accepted'|'ignored', receivedAt, intervalSeconds 30–600}` перевіряється так само строго, як heartbeat. Старий API (404) → пауза `NC_AGENT_MAX_BACKOFF_SECONDS`; старий Agent без inventory працює як раніше.
- **Strict schemas (усі `/api`).** Fastify за замовчуванням має Ajv `removeAdditional`, тобто `additionalProperties:false` мовчки обрізав зайві поля. Тепер `removeAdditional: false`: невідоме поле (наприклад, `serverId` у payload Agent) → 400. Чинні клієнти (UI, Agent 0.1.0) надсилають лише описані поля.
- **Зберігання.** `server_inventories` (стан, причина, `reported_at`/`inventory_collected_at` за серверним годинником, `*_captured_at` за годинником exporter лише для впорядкування) і `server_applications` (останній успішний набір, ≤ 500 на сервер). Без історії. Правила в одній транзакції з `FOR SHARE` credential і `FOR UPDATE` рядка inventory: старіший `capturedAt` → `ignored`; той самий `capturedAt` → лише `reported_at` (свіжість не оновлюється); новіший → заміна набору (зникли — видаляються, зміна source — видаляються процеси старого source); `stale`/`unavailable` → лише стан, останні процеси лишаються з явною позначкою. Порожній успішний inventory = 0 процесів; `unavailable` ≠ 0 процесів.
- **Ідентичність застосунку** — `(server, source, pm_id)` у межах поточного snapshot. PM2 перевикористовує `pm_id` після видалення, тому `pm_id` — не стабільний ідентифікатор між видаленням і повторним створенням; зміна імені під тим самим `pm_id` вважається новим застосунком (`first_seen_at` скидається). Ключ у API `serverId:source:pmId` — для рядка таблиці, не для довготривалих посилань.
- **Свіжість у UI.** `current` — останній збір (серверний годинник) новіший за 180 с; інакше `stale`; `unavailable` — exporter/файл недоступні (показується причина й час останнього збору); `not_reported`. Окремо показується, що сервер офлайн. Аптайм/CPU/RAM — «на момент збору».
- **Обмеження.** Один PM2 owner/`PM2_HOME` на сервер (кілька — майбутнє розширення без discovery). PM2 від root не підтримується (exporter від root заборонений). Якщо годинник хоста переводять назад, нові snapshot з меншим `capturedAt` ігноруються, доки час не наздожене попередній. Для `online` процесу, якому PM2 не зміг зняти метрики, PM2 віддає 0 — відрізнити це від реального 0 неможливо.
