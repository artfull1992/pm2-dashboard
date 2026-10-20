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
- Конфіг `/etc/node-control/api.env` створюється один раз із `DB_*` legacy `.env` і далі лише валідується — повторний деплой не перезаписує credentials і кастомні значення. Єдине джерело — `ENV_FILE` (формат Node `util.parseEnv`), без `EnvironmentFile=`, щоб не було двох джерел із різним синтаксисом.
- Код релізу належить root і недоступний для запису сервісу; сервіс — `nodecontrol` без shell/sudo. Hardening unit: `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `NoNewPrivileges`, порожній `CapabilityBoundingSet`, `SystemCallFilter=@system-service`, `IPAddressAllow=localhost` (знято в Task 013.2: потрібен вихідний HTTPS до Slack, див. ADR-022); `MemoryDenyWriteExecute` не вмикається (V8 JIT).
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
- **Deployment:** окремий артефакт і база релізів `/opt/node-control-agent`, користувач `nodecontrol-agent`, unit із hardening без `IPAddressAllow=localhost`; без токена unit завершується з кодом 2 і не перезапускається по колу.
- **Frontend:** `servers:manage` лише admin; опитування раз на 15 с лише для видимої вкладки зі скасуванням і захистом від застарілих відповідей; одноразовий діалог ключа (після закриття — видалено зі state, не логуються).
- **Ідентичність ресурсу в UI (Task 007.1):** стан `usePolledResource` прив'язаний до ключа ресурсу (id сервера): після зміни ключа в тому самому render повертається `loading`, помилка нового ресурсу не підставляє дані попереднього; останні дані зберігаються лише при невдалому оновленні того самого ресурсу. `CredentialControls` монтується з `key = id сервера + сесія` — підтвердження, помилки та виданий ключ не переживають зміну сервера, logout чи нову сесію. Мутація бере id із props свого екземпляра, скасовується при unmount, а її результат після скасування або з чужим `serverId` ігнорується (чужий `serverId` показується як помилка). Скасування в браузері не означає відкат: сервер міг уже виконати дію; автоматичних повторів немає.
- **Контракт відповіді heartbeat (Task 007.1):** `accepted` лише після повністю прочитаного body успішної відповіді: `200` і JSON `{status:"accepted", receivedAt: ISO-8601 UTC з мілісекундами (як toISOString), intervalSeconds: ціле 5–300}` (backend надсилає 30; додаткові поля ігноруються для сумісності з майбутніми версіями API). Один timeout (`NC_AGENT_TIMEOUT_SECONDS`) і сигнал скасування охоплюють і запит, і читання body. Body обмежено 4096 байтами за фактичними байтами потоку; завеликий `Content-Length` відхиляється без читання. Outcomes: обрив/помилка потоку → `network`, дедлайн → `timeout`, скасування → `aborted`, порожній/завеликий/не-UTF-8/не-JSON/порушений контракт → `invalid_response` (звичайний експоненційний backoff, лічильник збоїв не скидається). Для 401/403/429/інших 4xx/5xx body не читається (скасовується), класифікація лише за статусом. У лог потрапляють тільки outcome, затримка й кількість збоїв.

## ADR-016: Read-only PM2 inventory через локальний exporter

Статус: прийнято (Task 008). Керування процесами (start/stop/restart/delete), логи, redeploy і Jenkins — **не реалізовані**.

**Проблема доступу.** PM2 daemon працює від конкретного Linux-користувача з конкретним `PM2_HOME`; керування — через unix-сокет `PM2_HOME/rpc.sock`, який PM2 створює з правами `775` (будь-хто з основної групи власника може віддавати команди). Стандартний клієнт pm2 (`pm2 jlist`, `pm2.connect`, `Client.executeRemote`) **запускає daemon**, якщо його немає (`launchDaemon`), тобто довільний запуск `pm2` від іншого користувача створює новий daemon. Відповідь `getMonitorData` містить повний `pm2_env` (зокрема env-змінні застосунків із секретами).

**Рішення — три ролі з мінімальними правами:**

| Компонент | Користувач | Може | Не може |
|---|---|---|---|
| Exporter (`agent/dist/pm2-exporter.js`, systemd timer `node-control-pm2-exporter@<owner>`) | власник PM2 (`User=%i`; root відхиляє сам exporter за фактичним UID до будь-якого доступу до `PM2_HOME`, exit 2) | `connect()` до існуючого `rpc.sock`, один виклик `getMonitorData`, атомарний запис snapshot у `/var/lib/node-control-pm2` | мережа (`RestrictAddressFamilies=AF_UNIX`, `IPAddressDeny=any`), токен API, DB credentials, listener, shell-команди, інші PM2-методи |
| Agent (`nodecontrol-agent`) | окремий системний користувач | читати лише snapshot-файл (група `nc-pm2-inventory`), надсилати його в API | доступ до `PM2_HOME`/`rpc.sock` (не в групі власника PM2), запис у каталог snapshot, підробка файлу (Agent відхиляє файли, якими сам володіє) |
| API | `nodecontrol` | зберігати останній inventory, показувати його | будь-які PM2-команди (таких маршрутів немає) |

- **Без auto-start.** Exporter не використовує пакет `pm2` і не запускає дочірніх процесів: власний мінімальний клієнт протоколу PM2 (axon req/rep поверх amp: `[j:{type:'call',method:'getMonitorData',args:[{}]}, s:<id>]` → `[j:{args:[list]}|j:{error}, s:<id>]`). Немає `rpc.sock` → `unavailable/daemon_not_running`, нічого не створюється; `ECONNREFUSED`/`ENOENT` → те саме; `EACCES` → `permission_denied`. Доказ — unit-тести (фейковий daemon, статична перевірка відсутності `child_process`/`pm2`) і opt-in тест зі справжнім одноразовим PM2 у тимчасовому `PM2_HOME` (`npm run test:agent:pm2`).
- **Межа «read-only».** Read-only означає, що код викликає тільки `getMonitorData`. Це **не** OS-рівнева ізоляція: процес власника PM2 із доступом до `rpc.sock` технічно міг би віддати будь-яку команду. Тому exporter мінімальний, без мережі й без вхідних даних від API/користувачів.
- **Санітизація (allowlist).** Із сирої відповіді копіюються лише: `pm_id`, `name` (керівні символи → U+FFFD, ≤128 символів без розриву surrogate pair), `status` (невідомий → `unknown`), `uptimeSeconds` (з `pm_uptime` лише для `online` і лише якщо час правдоподібний: не в майбутньому понад 60 с, не старший за 10 років), `restarts`, `cpuPercent`/`memoryBytes` (лише для `online`; для інших статусів PM2 віддає штучний 0 → `null`), `execMode` (`fork`/`cluster`). Відсутнє/неправдоподібне → `null`, ніколи 0. Дублікат `pm_id`, некоректний `pm_id`/ім'я, > 500 процесів → весь snapshot `unavailable` (`invalid_data`/`too_many_processes`). Відповідь daemon ≤ 64 MiB, timeout 1–60 с (типово 10), лише в пам'яті exporter.
- **Snapshot-файл** `{format:'node-control/pm2-inventory', version:1, source, capturedAt, state:'ok'|'unavailable', reason, processes}` ≤ 512 KiB. Запис: каталог має існувати, належати exporter і не бути group/other-writable; тимчасовий файл `O_CREAT|O_EXCL|O_NOFOLLOW` `0640` → `fsync` → `rename` (атомарно); symlink/чужий файл на місці цілі → відмова. Каталог `2750 <owner>:nc-pm2-inventory` (setgid: файл отримує групу читання). Читання Agent: відмова для symlink, group/other-writable файлу чи каталогу, файлу/каталогу, яким володіє сам Agent, розміру > ліміту, підміни inode між `lstat` і `open`, будь-якого відхилення від контракту. При збої exporter записує `unavailable` з новим `capturedAt` — старі процеси не видаються за новий збір.
- **Протокол Agent → API.** Окремий `POST /api/agent/inventory` (той самий machine auth, `config.access: { machine: 'agent' }`; identity лише з credential; revoked/inactive → 401; body ≤ 512 KiB, ≤ 500 процесів, strict schema; конкурентність 4 + черга 8 → 503). Окремий послідовний цикл Agent (інтервал 30–600 с, типово 60), незалежний від heartbeat: збій inventory не зупиняє heartbeat. Snapshot старший за `NC_AGENT_INVENTORY_MAX_AGE_SECONDS` (типово 120) → звіт `stale` **без процесів**; майбутній `capturedAt` (> 5 хв) → `snapshot_invalid`. Відповідь API `{status:'accepted'|'ignored', receivedAt, intervalSeconds 30–600}` перевіряється так само строго, як heartbeat. Старий API (404) → пауза `NC_AGENT_MAX_BACKOFF_SECONDS`; старий Agent без inventory працює як раніше.
- **Strict schemas (усі `/api`).** Fastify за замовчуванням має Ajv `removeAdditional`, тобто `additionalProperties:false` мовчки обрізав зайві поля. Тепер `removeAdditional: false`: невідоме поле (наприклад, `serverId` у payload Agent) → 400. Чинні клієнти (UI, Agent 0.1.0) надсилають лише описані поля.
- **Зберігання.** `server_inventories` (стан, причина, `reported_at`/`inventory_collected_at` за серверним годинником, `*_captured_at` за годинником exporter лише для впорядкування) і `server_applications` (останній успішний набір, ≤ 500 на сервер). Без історії. Правила в одній транзакції з `FOR SHARE` credential і `FOR UPDATE` рядка inventory: старіший `capturedAt` → `ignored`; той самий `capturedAt` → лише `reported_at` (свіжість не оновлюється); новіший → заміна набору (зникли — видаляються, зміна source — видаляються процеси старого source); `stale`/`unavailable` → лише стан, останні процеси лишаються з явною позначкою. Порожній успішний inventory = 0 процесів; `unavailable` ≠ 0 процесів.
- **Ідентичність застосунку** — `(server, source, pm_id)` у межах поточного snapshot. PM2 перевикористовує `pm_id` після видалення, тому `pm_id` — не стабільний ідентифікатор між видаленням і повторним створенням; зміна імені під тим самим `pm_id` вважається новим застосунком (`first_seen_at` скидається). Ключ у API `serverId:source:pmId` — для рядка таблиці, не для довготривалих посилань.
- **Свіжість у UI.** `current` — останній збір (серверний годинник) новіший за 180 с; інакше `stale`; `unavailable` — exporter/файл недоступні (показується причина й час останнього збору); `not_reported`. Окремо показується, що сервер офлайн. Аптайм/CPU/RAM — «на момент збору».
- **Без `ConditionUser=` у unit (Task 008.1).** У system manager `ConditionUser=` перевіряє користувача самого manager (root), а не `User=`, тому `ConditionUser=!root` пропускав кожен instance (перевірено на сервері: «skipped, unmet condition check»). Заборона root — лише в коді exporter (`loadExporterConfig`, фактичний UID); `@root` завершується з exit 2, snapshot не змінюється.
- **Обмеження.** Один PM2 owner/`PM2_HOME` на сервер (кілька — майбутнє розширення без discovery). PM2 від root не підтримується (exporter від root заборонений). Якщо годинник хоста переводять назад, нові snapshot з меншим `capturedAt` ігноруються, доки час не наздожене попередній. Для `online` процесу, якому PM2 не зміг зняти метрики, PM2 віддає 0 — відрізнити це від реального 0 неможливо.

## ADR-017: Керування явно дозволеними PM2-процесами (start/stop/restart)

Статус: прийнято (Task 009). Production control **вимкнений за замовчуванням**: `PM2_CONTROL_ENABLED=false` в API, Agent без `NC_AGENT_CONTROL_SOCKET`, broker не встановлений або має порожню allowlist. Поза scope: створення/видалення процесів, reload, deploy, логи, Jenkins, shell, «all»/wildcard, cluster-режим.

**Ланцюжок і права.**

| Компонент | Користувач | Може | Не може |
|---|---|---|---|
| UI → API | сесія з `processes:control` (operator/admin) + Origin + CSRF | створити команду `{targetKey, action ∈ start/stop/restart, idempotencyKey}` для ціли, яку broker повідомив як дозволену | передати pm_id, шлях, args, env, cwd, текст команди |
| API | `nodecontrol` | зберігати команди, видавати їх Agent за lease, приймати результати | зв'язуватися з сервером напряму (лише Agent ініціює HTTPS) |
| Agent | `nodecontrol-agent` | опитувати API (bounded polling, 10 с), передавати команду broker через unix-сокет | доступ до `rpc.sock`, sudo, читання allowlist чи журналу broker |
| Broker (`agent/dist/pm2-broker.js`, `node-control-pm2-broker@<owner>.service`) | власник PM2, первинна група `nc-pm2-control` | викликати **лише** `startProcessId`/`stopProcessId`/`restartProcessId({id})` і `getMonitorData` для цілей із root-owned allowlist | мережа (`AF_UNIX` only), shell/exec, створення/видалення процесів, auto-start daemon, змінити allowlist |
| Exporter | власник PM2 | лишається read-only (лише `getMonitorData`) | керування |

- **Peer-автентифікація сокета broker.** Node.js не надає `SO_PEERCRED`, тому механізм — права файлової системи: сокет `0660 <owner>:nc-pm2-control` у `RuntimeDirectory` `0750 <owner>:nc-pm2-control`. Підключитися можуть лише власник PM2, члени `nc-pm2-control` (тільки `nodecontrol-agent`) і root. Поля запиту про користувача/сервер broker не використовує. Це не криптографічна автентифікація: будь-який процес `nodecontrol-agent` або власника може звернутися до broker, але отримає лише типізовані дії над allowlist-цілями.
- **Allowlist** — `/etc/node-control-pm2-broker/<owner>.allowlist.json`, `root:root`, не group/other-writable, regular file без symlink, ≤ 64 KiB, ≤ 50 записів. Перечитується при кожному запиті. Невалідна або «чужа» allowlist → усе відхиляється (`allowlist_invalid`). Типово порожня. Запис: `{id (targetKey), name, actions[], fingerprint}`.
- **Ідентичність процесу.** Не pm_id і не лише ім'я. Broker шукає процеси з `name`: 0 → `not_found`, > 1 → `ambiguous`, `exec_mode ≠ fork_mode` або `instances > 1` → `cluster_unsupported` (cluster не підтримується). Для єдиного кандидата рахує `fingerprint = sha256(canonical JSON [name, pm_exec_path, pm_cwd, exec_interpreter, args, node_args, exec_mode])` і порівнює з allowlist; інакше `fingerprint_mismatch`. Fingerprint **ідентифікує definition** (перевіряє, що під цим ім'ям той самий застосунок), а не авторизує користувача і не є захистом від власника PM2, який може зареєструвати процес із тими самими параметрами. Шляхи/args лише хешуються локально й не виходять за межі broker; оператор отримує fingerprint командою `pm2-broker.js fingerprint` (виводить pm_id, name, exec_mode, fingerprint — без шляхів).
- **Перевірка безпосередньо перед дією і після неї.** Ідентичність перевіряється (1) Agent-звітом цілей при опитуванні, (2) API при створенні й claim (ціль має бути `ok` і свіжа ≤ 60 с), (3) broker безпосередньо перед PM2-викликом (свіжий `getMonitorData`). Після дії той самий pm_id має мати той самий fingerprint, інакше результат `unknown/identity_changed`. PM2 не надає атомарного «перевір-і-виконай»: між перевіркою і викликом (мілісекунди) процес теоретично можна видалити й створити інший із тим самим pm_id. Межа документована; fail-closed — пост-перевірка.
- **Дії.** `start` — лише для `stopped`/`errored` (інакше `invalid_state`); `stop` — для `online`/`launching`/`errored`; `restart` — `online`/`errored`/`stopped`. Успіх: `stop` → після дії `stopped`; `start`/`restart` → `online` протягом ≤ 10 с (для restart online-процесу — також зріс `restart_time`). `online` ≠ здоров'я застосунку. Відсутній daemon → `failed/daemon_unavailable`, daemon не запускається. Виклик PM2 обмежений 20 с; дії виконуються строго послідовно (одна за раз на broker).
- **Команди в API.** Стани: `queued → dispatched → succeeded | failed | rejected | expired | unknown`. `rejected` і `expired` гарантують, що дію не виконано; `failed` — PM2 відповів помилкою або перевірка після дії не пройшла; `unknown` — дія могла виконатися, але результат не підтверджено. Дедлайн — 120 с від запиту; lease — 45 с; не більше 3 доставок. Створення команди й audit — одна транзакція. Одна активна (`queued|dispatched`) команда на ціль (partial unique index) і один виконавець на сервер (claim не видає нову команду, поки інша `dispatched` з дійсним lease).
- **Idempotency.** `idempotencyKey` (UUID) унікальний для `(actor, key)`: повтор із тим самим `server/target/action` повертає ту саму команду (200), з іншим — 409. UI генерує ключ на відкриття діалогу і не повторює мутацію автоматично.
- **Claim.** Транзакція: credential `FOR SHARE` (revoked/inactive → 401); прострочені `queued` → `expired`, `dispatched` після `deadline + 120 с` без результату → `unknown/no_result`; вибір `FOR UPDATE SKIP LOCKED`; повторна перевірка: control увімкнений, актор активний і має `processes:control` за **поточною** роллю, ціль `ok` і свіжа, дія дозволена — інакше `rejected` з audit. Revoke credential / вимкнення сервера / зміна ролі після dispatch не можуть відкликати команду, що вже в broker — це незворотна межа; результат приймається лише від Agent цього сервера з дійсним credential (інакше команда стане `unknown` після дедлайну).
- **Дедуплікація і crash windows.** Broker веде durable журнал (`/var/lib/node-control-pm2-broker`, файл на команду, атомарний запис + fsync, retention 7 днів): `started` пишеться **до** PM2-виклику, `completed` — після. Повторна доставка тієї самої команди (той самий `commandId`) повертає збережений результат; `started` без `completed` (збій broker під час дії) → `unknown/interrupted`, без повторного виконання. Broker відхиляє команди після дедлайну (`expired`). Agent після надсилання команди не повідомляє «rejected», якщо доставка вже могла дійти до broker (лише для першої спроби й помилки підключення). Втрачене підтвердження результату: Agent повторює лише звіт; після перезапуску Agent API повторно видає ту саму команду (після lease), broker повертає журнальний результат. **Exactly-once через мережу не гарантується.** Вікно повторного виконання існує лише якщо журнал broker втрачено (наприклад, видалено каталог) до дедлайну команди. UI ніколи не показує `succeeded` без підтвердженого результату; повтор дії — лише новою явною дією користувача (новий ключ).
- **Audit** (`process.command_*`): `requested` (актор — користувач), `rejected`, `expired`, `dispatched` (кожна доставка), `succeeded`, `failed`, `unknown` — details: `serverId`, `commandId`, `targetKey`, `action`, `reason`. Переходи стану й audit — одна транзакція. Без токенів, raw PM2, env, args.
- **Конкурентні опитування.** Poll одного сервера захищений неблокувальним `pg_try_advisory_xact_lock`: паралельний poll (наприклад, під час перезапуску Agent) не отримує команд і нічого не змінює, а не чекає на блокування рядків.
- **Семантика `failed`.** `failed/daemon_unavailable` і `failed/pm2_error` означають, що PM2 не виконав дію (daemon недоступний до виклику або PM2 відмовив); `failed/verification_failed` — PM2 прийняв виклик, але очікуваний стан не підтвердився за 10 с (дія могла частково відбутися, стан «після» показується).
- **Feature flags і rollout.** Вмикання — три незалежні кроки: (1) broker + allowlist на ноді, (2) `NC_AGENT_CONTROL_SOCKET` в Agent, (3) `PM2_CONTROL_ENABLED=true` в API. Будь-який вимкнений → fail closed. Rollback: `PM2_CONTROL_ENABLED=false` (нові команди 409, нічого не видається; `queued` стають `expired`), зупинка broker не зупиняє PM2-процеси, журнал не видаляється.

## ADR-018: Обмежений авторизований перегляд логів сервісів

Статус: прийнято (Task 010). Лише останній фрагмент stdout/stderr конкретного дозволеного сервісу; без збереження, повних файлів, очищення, довільного читання файлів, WebSocket.

- **Транспорт.** UI → API: `POST /api/servers/:id/log-requests` (`logs:read` + Origin + CSRF) створює запит у **пам'яті** API; `GET /api/log-requests/:id` (той самий актор) чекає до 8 с і повертає результат. Agent тримає вихідний long-poll `POST /api/agent/logs/poll` (API утримує до 25 с, віддає ≤ 4 запити) і повертає `POST /api/agent/logs/result`. Agent → broker: нові операції `logTargets` і `logs` на тому самому unix-сокеті. Вхідних портів немає; Agent не отримує доступу до PM2_HOME чи файлів.
- **Окремо від керування.** Не команда lifecycle: немає таблиць, idempotency, журналу дедуплікації (читання ідемпотентне). Не залежить від `PM2_CONTROL_ENABLED`. Чинні контракти (`list`, control poll/result, heartbeat, inventory) не змінено.
- **Права.** Новий permission `logs:read` — admin і operator; viewer — ні (логи можуть містити чутливі дані). `processes:control` не дає читання логів і навпаки. Локально: у записі allowlist необов'язкове поле `"logs": true`; без нього читання заборонене (старий формат лишається валідним). Запис може мати `"actions": []` лише разом із `"logs": true` (тоді він не стає ціллю керування). Старий broker вважає allowlist із полем `logs` невалідним — тому при rollback спершу відновити backup allowlist.
- **Ідентичність і файли (broker).** На кожен запит: перечитати allowlist, перевірити `logs`, чинна ідентичність (одне ім'я, fork/1 instance, fingerprint). Шляхи — лише з `pm_out_log_path`/`pm_err_log_path` PM2, нормалізовані абсолютні, без `..`, поза `/proc`, `/sys`, `/dev`, і лише в явно дозволених каталогах `NC_BROKER_LOG_DIRS` (типово `<PM2_HOME>/logs`). `realpath` має дорівнювати шляху (жодного symlink у шляху), `lstat` — звичайний файл; відкриття `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`, `fstat` того самого inode/dev і regular file (захист від підміни між перевіркою й відкриттям, FIFO не блокує). Тільки читання.
- **Межі.** До 100 рядків на джерело; читається лише хвіст ≤ 256 KiB кожного файлу (`pread` від `size − 256 KiB`, перший неповний рядок відкидається); рядок ≤ 1000 символів; сумарний текст stdout+stderr ≤ 8 KiB (UTF-8; невикористаний бюджет одного джерела переходить іншому); серіалізована відповідь broker ≤ 32 KiB (перевіряється після `JSON.stringify`, з урахуванням escaping; найстаріші рядки відкидаються), HTTP-тіло результату Agent → API ≤ 40 KiB (обгортка), long-poll запит ≤ 32 KiB. Відповідь на читання ≤ 5 с, ≤ 2 одночасних читання в broker; слот звільняється лише після фактичного завершення читання (resolve або reject), а не за timeout відповіді — файлові й PM2-виклики не скасовуються (Task 010.1). Зависле читання видно в журналі broker як metadata (`log read overdue` / `log read settled late`, без тексту); поки обидва слоти зайняті, нові запити отримують `broker_busy`, черги немає. Ліміт machine-запитів на токен піднято з 20 до 90/хв (heartbeat + inventory + control poll + log long-poll і результати при автооновленні раз на 5 с); ліміт на адресу (120/хв) без змін. Agent тримає ≥ 1 с між порожніми poll, навіть якщо API відповідає одразу. API: ≤ 30 запитів/хв на актора, ≤ 2 очікуючих на актора, ≤ 200 у пам'яті; очікувачі результату (`GET /api/log-requests/:id`, ≤ 8 с) — ≤ 2 на запит, ≤ 3 на актора, ≤ 100 разом (Task 010.1), надлишок відхиляється до створення waiter/таймера: 429 + `Retry-After: 1` (запит/актор), 503 + `Retry-After: 2` (глобально); відключення клієнта (`reply.raw` 'close') одразу звільняє waiter, не скасовуючи спільний запит; дедлайн запиту 15 с; результат зберігається 60 с після завершення, далі видаляється; після restart API усі запити втрачаються (UI показує «запит протерміновано»).
- **Обробка тексту.** Декодування UTF-8 з заміною; видалення ANSI/OSC-послідовностей і керівних символів (крім `\t`); обрізання довгих рядків (`…`). Маскування **до передачі з керованого сервера** відомих форматів: `password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth|credential …=/:` значення, `Authorization: Bearer|Basic …`, credentials у URL (`scheme://user:pass@`), JWT, `ncag_…`, AWS access key id, блоки `PRIVATE KEY`. Маскування не гарантує видалення всіх секретів і не замінює RBAC та локальний дозвіл.
- **Що передається.** Лише текст, кількість рядків, ознака обрізання, розмір і mtime файлу, час читання, стан (`ok|empty|missing|unavailable`) і server-defined причини. Без шляхів, env, raw помилок.
- **Збереження й аудит.** Текст не пишеться в PostgreSQL, audit, journal, error/access logs (Fastify не логує тіла). Audit: `logs.view_opened` (не частіше ніж раз на 10 хв на актора+сервер+ціль — автооновлення не спамить) і `logs.view_denied` (ціль без дозволу/непідтримувано); `authz.denied` для viewer — як і раніше. Details: `serverId`, `targetKey`, `reason`.
- **Сумісність.** Старий Agent не опитує логи → API: «Перегляд логів не підтримується агентом» (409). Новий Agent зі старим broker: broker закриває з'єднання на невідому операцію → `broker: 'unsupported'` → та сама відповідь. Старий API → Agent отримує 404 на long-poll → довга пауза. Порядок rollout: API → Agent+broker (один артефакт) → (окремо, з погодження) `logs: true` в allowlist.

## ADR-019: Адміністрування користувачів і зміна власного пароля

Статус: прийнято (Task 011). Admin: список, створення (email + початковий пароль + роль), зміна ролі, деактивація/активація. Кожен користувач: зміна власного пароля. Без фізичного видалення, зміни email, admin-reset пароля, листів, self-registration, forgot-password, MFA, зовнішніх IdP і нового bootstrap.

- **Контракти.**
  - `GET /api/users?limit=1..100&after=<uuid>` (`users:manage`) → `200 {items: UserView[], nextAfter: uuid|null}`. Keyset за `(created_at, id)`; курсор — id останнього рядка (не email: URL потрапляє в журнали проксі).
  - `POST /api/users` `{email, password, role}` (`users:manage` + Origin + CSRF) → `201 UserView`; 400 (email/пароль за чинною політикою `normalizeEmail`/`checkPasswordPolicy`, роль), 409 email зайнятий, 429, 503 + `Retry-After`.
  - `PATCH /api/users/:id` `{role?, isActive?}` (`users:manage` + Origin + CSRF; порожнє тіло — 400; відсутнє поле зберігає значення) → `200 UserView`; 403 власний обліковий запис, 404, 409 останній активний admin, 401 якщо повноваження актора відкликано до commit.
  - `POST /api/auth/change-password` `{currentPassword, newPassword}` (будь-яка чинна сесія + Origin + CSRF) → `204` + очищений cookie; 400 політика або новий = поточний, 422 невірний поточний пароль, 409 credentials змінились паралельно, 429 (5 спроб / 15 хв на користувача), 503 + `Retry-After: 1` (перевантаження hashing).
  - `UserView = {id, email, role, isActive, createdAt, updatedAt}`. Hash, паролі, токени сесій і CSRF інших користувачів не повертаються ніколи (строгі response-схеми).
- **Версія credentials.** Нова колонка `users.credential_version` (bigint, default 1). Кожна безпекова зміна користувача — пароль, роль, активність — в одній транзакції збільшує версію, відкликає **всі** сесії користувача і пише audit; будь-який збій (зокрема audit) відкочує все.
  - Зміна пароля: hash читається разом із версією, scrypt (перевірка поточного й hash нового) виконується **поза** транзакцією через спільний bounded limiter; потім compare-and-set `UPDATE … WHERE id AND credential_version = <прочитана> AND is_active`. Із двох одночасних змін зі старим паролем проходить одна, друга отримує 409. Транзакція коротка; row lock під час scrypt не тримається.
  - Вхід: пароль перевіряється поза транзакцією; у транзакції створення сесії рядок користувача блокується `FOR SHARE` і перевіряється `is_active` та незмінна версія. Запізнілий вхід після зміни пароля, ролі чи деактивації не створює сесії (401, audit `stale_credentials`). Якщо вхід встиг закомітитись раніше, конкуруючий `UPDATE` чекає на нього й відкликає нову сесію разом з іншими.
- **Адмінські мутації й останній admin.** Створення і PATCH виконуються в транзакції з `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE` (той самий режим, що й bootstrap). Це серіалізує всі записи в `users` (адмінські мутації, зміни пароля, bootstrap), але не блокує читання й вхід (`FOR SHARE`).
  - Порядок блокувань: таблиця `users` → рядки `users` → `sessions`. Вхід і зміна пароля беруть рядок `users` до `sessions`, тому циклів немає.
  - Під блокуванням повторно перевіряється актор: його сесія не відкликана й не прострочена, він активний admin. Якщо інший admin щойно зняв із нього права — 401, пізнього commit немає.
  - Власну роль/активність змінювати заборонено (403). Пониження або деактивація активного admin відхиляються, якщо після зміни не лишиться інших активних admin (409). Через самозаборону інваріант виконується й конструктивно (актор — активний admin ≠ ціль); перевірка — додатковий захист.
  - Два admin, що одночасно знімають права один з одного: другий бачить себе вже не admin → 401; лишається один активний admin.
  - Порожня зміна (no-op) — 200 без audit і без відкликання сесій. Повторна активація не відновлює відкликані сесії.
- **Audit.** Успіх — у тій самій транзакції:
  - `user.created` `{targetUserId, role}`;
  - `user.role_changed` `{targetUserId, fromRole, toRole, sessionsRevoked}`;
  - `user.deactivated` / `user.activated` `{targetUserId, sessionsRevoked}`;
  - `auth.password_change` success `{sessionsRevoked}`.

  Відмови — best-effort, як `authz.denied` і невдалий вхід:
  - `user.create_rejected` (failure, `email_taken`);
  - `user.update_rejected` (denied, `self_change` | `last_admin`);
  - `auth.password_change` failure (`invalid_current_password` | `stale_credentials`).

  Без email, паролів, hashes, токенів і тіла запиту.
- **Ліміти.** Перевірка й hash пароля — спільний `DEFAULT_HASH_LIMITER` (4 одночасно, черга 32, надлишок → 503). Зміна пароля — 5 спроб / 15 хв на користувача (до hashing). Адмінські мутації — 30/хв на актора.
- **Міграція** `1791900000005_user-credential-version`: лише additive, тобто колонка з default (існуючий admin отримує 1) та індекс `(created_at, id)`. Попередній реліз її не читає й лишається робочим (rollback коду без відкату схеми; версійний захист від гонок тоді не діє). API міграції не запускає.
- **Frontend.**
  - «Обліковий запис» — для всіх ролей. Після успішної зміни пароля — вихід на login із повідомленням.
  - «Користувачі» — лише `users:manage`, одна таблиця з меню «Дії».
  - Мутації не повторюються автоматично. Паролі живуть лише в стані форми й очищаються після запиту, виходу та unmount.
  - **Task 011.1.**
    - Відповіді прив'язані до сесії: `AuthContext.bindSession()` фіксує auth epoch. Logout, завершення сесії й новий вхід його змінюють, тож запізніла відповідь старої форми чи сесії не змінює нову.
    - `apiRequest` відкидає результат, що надійшов після abort або timeout.
    - Abort лише перестає чекати й **не** скасовує серверну мутацію.
    - Список користувачів — сторінки по 100 через чинний курсор `after` («Назад»/«Далі», ресурс keyed за курсором). Щойно створений користувач — наприкінці; «Показати» проходить ≤ 50 сторінок від поточної до сторінки з ним. Backend-контракт не змінено.

## ADR-020: Dashboard — агрегований read-only огляд системи

Статус: прийнято (Task 012). Лише поточний стан із наявних даних (heartbeat snapshot, PM2 inventory, метадані команд). Без історії метрик, трендів, alerts, Jenkins, нового збору CPU/disk і WebSocket.

- **Endpoint.** `GET /api/dashboard` (`monitoring:read`; GET без CSRF, без audit, без мутацій) → один узгоджений знімок:
  - читається однією транзакцією `REPEATABLE READ READ ONLY`;
  - усі вікна свіжості рахуються від одного `now()` транзакції — це `generatedAt`.
- **Поля відповіді:**
  - `generatedAt`; `windows` `{onlineSeconds: 90, inventoryFreshSeconds: 180}`;
  - `servers`: `{total, inactive, active, online, offline, neverConnected}`;
  - `inventory`: `{current, stale, unavailable, notReported}`;
  - `processes`: `{live: {total, online, problem, transitional}, notLive}`;
  - `attentionServers`, `attentionProcesses`, `serverList` — кожен `{items, total, limit}`;
  - `recentActions`: `{items, limit} | null`.
- **Правила підрахунку:**
  - **Неактивні сервери.** Входять лише в `servers.total` і `servers.inactive`. Більше ніде — ні в статуси, ні в inventory, процеси чи списки.
  - **Статус сервера.** `online` — прийнятий heartbeat свіжіший за 90 с; `offline` — heartbeat був, але давніше; `neverConnected` — heartbeat жодного разу.
  - **Inventory.** `current` — зібрано менше ніж 180 с тому і стан `ok`. `stale` — exporter повідомив `stale` або дані старіші. `unavailable` — exporter недоступний. `notReported` — Agent ще не надсилав inventory.
  - **«Live» процес.** Сервер активний **і online**, inventory `current`. Лише такі процеси рахуються за статусами. Решта відомих процесів (сервер offline, inventory stale/unavailable) — `notLive`. Їхній останній статус не видається за поточний: старий `online` офлайн-сервера не збільшує «Зараз працюють».
  - **Групи статусів PM2:**
    - `online`;
    - `problem` = `errored`, `stopped`, `waiting restart`, `unknown`;
    - `transitional` = `launching`, `stopping`, `one-launch-status`.

    Рестарти — накопичений лічильник PM2, не «частота».
- **«Потребує уваги».**
  - **Сервери** (лише активні), в порядку пріоритету:
    1. `offline`;
    2. `never_connected`;
    3. online, але inventory `unavailable`;
    4. online, але inventory `stale`;
    5. online, але inventory `not_reported`.

    Усередині пріоритету — за назвою, потім за id.
  - **Сервіси** — лише live-процеси з `problem`-статусом. Порядок: `errored` → `waiting restart` → `unknown` → `stopped`, потім сервер, назва, pm_id.
  - Процеси сервера з неактуальними даними окремо не перелічуються: проблему видно як «сервер потребує уваги», без дублювання.
- **Ліміти.** `attentionServers` ≤ 20, `attentionProcesses` ≤ 20, `serverList` ≤ 50 (активні сервери за назвою), `recentActions` ≤ 10. Кожен список повертає точний `total` за допомогою `count(*) OVER ()`; якщо `total > items.length`, UI показує, що це лише частина записів.
- **Метрики серверів.**
  - Знімок (uptime, cpuCount, load average 1/5/15 хв, пам'ять) повертається **лише для online-сервера**. Для offline і never_connected — `null`, щоб старі дані не видавалися за поточні; `lastSeenAt` повертається завжди.
  - Load average — довжина черги виконання, не відсоток CPU.
  - Зайнята пам'ять = `total − free` за OS-знімком (це не пам'ять застосунків). Якщо `totalBytes = 0`, відсоток `null`.
- **Останні дії** (`recentActions`):
  - Лише для ролей із `processes:control` (operator, admin). Для інших backend повертає `null` і цей запит не виконує.
  - Поля: id, сервер (id, назва), targetKey, action, status, reason, requestedAt, completedAt, `requestedByMe`, `overdue`. Без id/email ініціатора, результатів PM2, логів і audit details.
  - `overdue` — команда ще `queued`/`dispatched` після дедлайну: lifecycle її не матеріалізував, і UI не показує її як гарантовано активну. GET нічого не прострочує й не очищає.
  - Чинна історія команд окремого сервера (`monitoring:read`) не змінена.
- **SQL.**
  - Параметризований.
  - Без N+1: агрегати через `count(*) FILTER`, лічильники процесів сервера — через `LEFT JOIN LATERAL` з агрегатом.
  - `servers` з'єднується з `server_heartbeats` і `server_inventories` 1:1 (PK `server_id`), тож рахунки не множаться.
  - Нових індексів немає: `servers`/`server_*` малі; `recentActions` — top-N сортування `control_commands` (за зростання таблиці — окремий індекс `(requested_at DESC, id DESC)`).
- **Frontend.**
  - Сторінка «Огляд»: підсумкові картки, «Потребують уваги» (сервери та сервіси), таблиця серверів із поточними метриками, «Останні дії» для дозволених ролей.
  - Polling 15 с, лише коли вкладка видима; ручне «Оновити»; abort при unmount чи зміні сесії; запізнілі відповіді відкидаються.
  - Після помилки лишаються останні відомі дані з явною позначкою та часом останньої успішної відповіді. Якщо відповідь старша за online-вікно, сторінка позначає всі статуси як неактуальні.

## ADR-021: Alerts Engine і Slack-сповіщення

Статус: прийнято (Task 013). Фоновий оцінювач усередині API-процесу (без нового сервісу), durable інциденти, Slack Incoming Webhook. Без Jenkins, графіків, email/Telegram, правил із виконуваним кодом, acknowledgement/silencing і редагування правил в UI. Вмикається лише конфігурацією; за замовчуванням вимкнено.

- **Дані й класифікація** — ті самі, що в Dashboard (ADR-020): online-вікно 90 с, свіжість inventory 180 с, лише активні сервери. Load average не використовується (це не CPU %).
- **Правила.** Ключ умови = правило + сервер [+ `source:pm_id:name` процесу].

  | Правило | Умова відкриття | Відкриття / відновлення | Severity |
  |---|---|---|---|
  | `server_offline` | сервер раніше звітував, зараз offline; never_connected — ніколи | 1 / 1, вибірка — час heartbeat | critical |
  | `inventory_stale` | inventory stale/unavailable на online-сервері; not_reported — не alert | 2 нові звіти inventory / 1 current | warning |
  | `process_down` | live-процес у stopped/errored | 2 нові inventory-вибірки / 1 зі статусом online; перехідні статуси нічого не змінюють; текст stopped — «можливо, навмисна зупинка» | errored → critical, stopped → warning |
  | `process_cpu` | CPU % процесу за PM2 ≥ 90 | 3 нові вибірки; відновлення < 70 — 2 вибірки | warning |
  | `server_memory` | зайнятість пам'яті ОС (total − free) ≥ 90 % | 3 нові heartbeat; відновлення < 80 % — 2; `total = 0` чи немає знімка → невідомо | warning |
  | `process_restarts` | ≥ 3 нових рестарти у 10-хвилинному вікні | відновлення — повне вікно без рестартів | warning |
- **Гістерезис.** Значення між порогами відкриття й відновлення переривають серію pending чи recovering, але не закривають firing-інцидент.
- **Рестарти — лише дельта між новими вибірками.**
  - Перша вибірка — тільки baseline.
  - Зменшення лічильника або інша ідентичність (`first_seen_at` процесу) скидають baseline.
  - Обмеження: якщо на тому самому PM2 id з'явився процес із тим самим ім'ям і тим самим `first_seen_at`, його не відрізнити від попереднього.
- **Неповні дані.** Вибірка, яку вже оцінювали, не рахується вдруге. `null`, `total = 0`, неактуальні дані — «skip»: нічого не змінюється, і **відсутність даних ніколи не означає відновлення**.
  - Поки сервер offline, діє лише один `server_offline`: лавини процесних alert немає, процесні правила заморожені.
  - Поки inventory не current, заморожені процесні правила.
- **Зникнення процесу** з current inventory закриває його інциденти з `resolution = process_gone` («відновлення не підтверджено»). Це не «healthy» і не рестарт.
- **Деактивований сервер** — інциденти закриваються як `excluded`, стан умов видаляється.
- **Lifecycle.** Стан умови: `ok` → `pending` (serie < підтвердження) → `firing` → `recovering` → `ok`. Інцидент `firing` → `resolved` (`recovered` | `process_gone` | `excluded`). Унікальний індекс гарантує не більше одного відкритого інциденту на ключ.
- **Сповіщення:**
  - одне initial повідомлення на інцидент, окреме — про відновлення;
  - recovery надсилається лише тоді, коли саму проблему було оголошено;
  - **cooldown** (15 хв): повторне відкриття того самого ключа протягом cooldown після закриття записується з `notify = false` — без повідомлення й без recovery, тож flapping не створює спаму;
  - нагадування — лише якщо явно задано `ALERTS_REMINDER_MINUTES > 0` (за замовчуванням вимкнено).
- **Персистентність і конкурентність:**
  - Таблиці `alert_conditions`, `alert_incidents` і `alert_outbox` (міграція `1791900000006_alerts`). Стан переживає restart, тому повторного initial alert після рестарту немає.
  - Оцінювання — одна транзакція `REPEATABLE READ` під `pg_try_advisory_xact_lock`: паралельні оцінки пропускаються.
  - Переходи інцидентів, черга й стан умов — атомарні; збій відкочує все.
  - Retention: надіслані й завершені записи черги — 30 днів, закриті інциденти — 90 днів, видалення пакетами по 500 лише з власних таблиць.
- **Доставка (outbox):**
  - Записи захоплюються `FOR UPDATE SKIP LOCKED` з lease 60 с, тому два worker не беруть той самий запис. Результат записує лише власник захоплення (`status = 'sending' AND attempts = …`); прострочений lease забирається знову.
  - Черга обмежена (`ALERTS_QUEUE_MAX = 100`): надлишок записується як `dropped / queue_full`.
  - Не більше ~1 повідомлення за секунду.
- **Slack:**
  - Лише `https://hooks.slack.com/services/T…/B…/…`, `redirect: 'error'`, тайм-аут 5 с, відповідь читається не більше 1 KiB.
  - Успіх — **тільки** HTTP 200 з тілом `ok`.
  - 429 → повтор не раніше `Retry-After`; 5xx і мережева помилка → backoff 30 с·2ⁿ ±20 % (≤ 30 хв).
  - Задокументовані коди 4xx (`invalid_payload`, `no_service`, `channel_is_archived`, `action_prohibited` тощо) → `failed` без повторів.
  - Тайм-аут або abort після відправлення → результат **невідомий**, запис повторюється.
  - Гарантія — **at-least-once**, можливі дублікати; кожне повідомлення містить короткий id інциденту. Після `ALERTS_MAX_ATTEMPTS` (6) запис стає `failed` (або `unknown`, якщо останній результат невідомий).
  - _Уточнення (review сповіщень, 2026-10-17):_ мережева помилка класифікується за причиною: «точно не надіслано» (DNS, відмова з'єднання, недосяжна мережа, відмова TLS) → повтор з backoff, на останній спробі `failed`; обрив з'єднання, коли запит міг уже дійти (`UND_ERR_SOCKET`, `ECONNRESET`, причина без коду) → **невідомо** (`connection_lost`): так само повторюється, на останній спробі `unknown`, тестове повідомлення — `unknown`. Recovery «лише для оголошеної проблеми» означає: повідомлення про проблему `queued`/`sending`/`sent`/`unknown`; для `dropped`, `cancelled` (заміна webhook, вимкнення доставки — новий канал проблеми не бачив) і `failed` recovery не створюється.
  - _Уточнення (повторний review сповіщень, 2026-10-19; уточнює попередній пункт):_
    - **Залежність доставки.** Recovery і reminder інциденту видаються `claim` лише тоді, коли повідомлення про проблему **тієї самої generation** завершилось як `sent` або `unknown` і жоден старіший запис цього інциденту не перебуває в `queued`/`sending` (backoff, lease, повтор). Порядок INSERT чи ORDER BY для цього не використовується. Якщо проблему вже не буде оголошено (`failed`, `cancelled`, `dropped`, відсутня або іншої generation), залежний запис стає `cancelled` з `problem_not_announced`: він не надсилається сам і не чекає безстроково. Reminder, що ще чекає на момент відновлення, скасовується (`superseded`). Незалежні інциденти одне одного не блокують.
    - **Generation.** Право на recovery дає лише проблема, оголошена в generation, до якої належатиме recovery. Проблема, надіслана (або `unknown`) у попередній webhook, після заміни, видалення чи повторного налаштування інтеграції recovery в новий канал не отримує. Історія старої generation зберігається, повторного оголошення активних проблем у новий канал немає.
    - **Обрив читання відповіді.** Якщо після отриманих headers тіло 2xx/3xx не дочитано (обрив, тайм-аут, abort), результат — `unknown` (`connection_lost`/`timeout`/`aborted`), а не `failed` і не `sent`. 429 і 5xx класифікуються за статусом, 4xx — `failed` за статусом. Повністю прочитана некоректна чи завелика відповідь лишається `failed` (`unexpected_response`).
    - **Повтори unknown.** Worker черги повторює `unknown` в межах «Макс. спроб» (at-least-once, можливі дублікати); на останній спробі запис стає `unknown`. Без автоматичного повтору — лише разове тестове повідомлення адміністратора.
    - **Довге вікно рестартів.** Стан рестартів — не більше 64 точок `{t, r, f}` (той самий формат jsonb). Точки охоплюють усе вікно: anchor — найновіша збережена точка перед початком вікна. Коли точок забагато, відкидається внутрішня точка з найближчими сусідами; найстаріша й найновіша зберігаються завжди. Похибка: anchor може бути старішим за початок вікна не більше ніж на ≈ 2·вікно/63 (близько 3 %). Тобто можуть бути враховані рестарти, що сталися до 3 % раніше вікна, а відновлення може настати на стільки ж пізніше. Вікна, де вибірок не більше 64, обчислюються точно, як раніше. Відсутні дані, той самий sample і невідомий лічильник нічого не додають; скидання лічильника чи зміна identity задають нову базу.
  - _Уточнення (третій review сповіщень, 2026-10-19):_
    - **Межа відповіді 1 KiB.** Читання тіла має три результати: повне, завелике (> 1024 байт; читання зупиняється, потік скасовується) і перерване. Успіх `sent` дає лише повне тіло `ok` зі статусом 200. Префікс заліковується лише тоді, коли тіло повне: `ok` з подальшими даними понад межу — `failed` (`unexpected_response`), незалежно від поділу на chunks. Для 4xx із завеликим тілом код Slack не довіряється — `http_<status>`. 429 і 5xx — за статусом. Перерване тіло 2xx — `unknown`. Для worker і разового тестового повідомлення класифікація однакова; тестове повідомлення не повторюється, worker повторює `retry`/`unknown` до «Макс. спроб».
    - **Reminder після закриття інциденту.** Reminder закритого інциденту нових спроб не починає. `claim` його не видає й скасовує (`cancelled`, `superseded`), якщо він у черзі або lease протерміновано. Якщо поточна спроба завершилась результатом для повтору, `finish` в одному операторі з перевіркою володіння переводить reminder у `superseded`, а не назад у чергу. Спробу, що вже в польоті, не відкликати: її HTTP-запит міг піти. Її фінальний результат (`sent`, `failed`, `unknown`) записується як є, і recovery чекає лише на неї (не довше lease чи HTTP-тайм-ауту), а не на повтори. Межа гарантії: claim, що почався після коміту resolve, reminder не видасть. Claim, конкурентний із самим комітом, може почати ще одну спробу; це та сама «поточна спроба». Reminders активних інцидентів не змінюються.
  - Збій доставки не впливає на API чи моніторинг.
- **Повідомлення:**
  - лише top-level `text` (Block Kit автоматично розбирає згадки), без `link_names`;
  - у недовірених назвах екрануються `& < >`, нейтралізуються `@…`, `://` і символи розмітки;
  - єдине посилання будується з `ALERTS_PUBLIC_URL` + UUID;
  - текст українською: проблема чи відновлення, сервер і сервіс, показник, час спостереження в UTC, посилання;
  - без credentials, env, логів, шляхів, email і текстів помилок.
- **Секрети.** Webhook зберігається лише в `api.env` (600). Він не потрапляє в БД, відповіді API, frontend і журнали; помилки конфігурації називають ключ, але не значення.
- **API:**
  - `GET /api/alerts?state=active|resolved&limit&before` (`monitoring:read`, keyset) і `GET /api/alerts/status` — лише читання, без оцінювання й без мутацій.
  - Новий permission **`alerts:manage`** (admin) додає стан доставки по інцидентах, лічильники черги й несекретну конфігурацію (`webhookConfigured: true|false`, але не саму URL).
- **Shutdown.**
  - Worker стартує в `onReady`. У `preClose` він перестає планувати цикли, перериває запит до Slack (запис повертається в чергу як `aborted`, at-least-once) і чекає поточний цикл не довше 3 с — до закриття БД.
  - Того самого виправлення потребував LogHub: long-poll і очікувачі тепер звільняються в `preClose`, бо в `onClose` вони тримали shutdown до 25 с. Під час закриття всі відповіді йдуть із `Connection: close`: інакше keep-alive сокет, що став idle вже після старту `close()`, тримав сервер до ~72 с.

## ADR-022: Налаштування сповіщень і Slack-інтеграції через admin UI

Статус: прийнято (Task 013.1). Розширює ADR-021: прикладні параметри та webhook керуються адміністратором у UI. Застосовуються без restart. Environment лишається лише для deployment-рівня.

- **Джерело конфігурації.**
  - БД — єдине джерело прикладних параметрів: singleton `alert_settings` з `revision`.
  - Колишні `ALERTS_*` прикладні змінні env використовуються **один раз** як початкові значення, коли рядка ще немає (`INSERT … ON CONFLICT DO NOTHING`). Збережені налаштування на старті ніколи не перезаписуються.
  - `ALERTS_ENABLED`, `ALERTS_DELIVERY_ENABLED` і `ALERTS_SLACK_WEBHOOK_URL` більше не діють. Webhook з env не імпортується; якщо він є, на старті пишеться попередження без значення. Інтеграція, яка не була налаштована, такою й лишається.
  - У env лишаються: `ALERTS_SECRET_KEY` (base64, 32 байти), `ALERTS_SECRET_KEY_VERSION` і `ALERTS_PUBLIC_URL`.
- **Секрет (webhook).**
  - Шифрування AES-256-GCM з випадковим 12-байтним nonce на кожен запис. AAD = `node-control:slack-webhook:<generation>`, тож ciphertext не можна перенести на іншу generation.
  - У БД зберігаються ciphertext, nonce, tag і `key_version`. Ключ — лише в `api.env` (600), у БД його немає.
  - Webhook не повертається жодним GET і не потрапляє в audit, журнали чи помилки.
  - Немає ключа, інша версія ключа або помилка дешифрування → **fail-closed**: доставка й тест не виконуються, admin бачить безпечний стан `error` (`key_missing` | `key_version_mismatch` | `decrypt_failed`). Fallback на plaintext немає.
  - Backup БД без ключа не дозволяє відновити інтеграцію — тоді webhook вводиться заново.
- **API** (усе — `alerts:manage`; мутації — Origin + CSRF, строгі схеми, rate limit 30/хв на актора, audit в одній транзакції зі зміною):
  - `GET /api/settings/alerts` → `{revision, engineEnabled, deliveryEnabled, rules, advanced, limits, slack: {state, generation, configuredAt, keyAvailable, lastTest}, queue, publicUrlConfigured}`. Лише безпечні метадані; `queue` обчислюється.
  - `PATCH /api/settings/alerts` `{revision, engineEnabled?, deliveryEnabled?, rules?, advanced?}` → 200; застаріла `revision` → **409** (optimistic concurrency); `deliveryEnabled: true` без налаштованої інтеграції → 409.
  - `PUT /api/settings/integrations/slack` `{generation, webhookUrl}` встановлює або замінює webhook (`generation` = поточна, для concurrency) → нова `generation`.
  - `DELETE /api/settings/integrations/slack` `{generation}` видаляє інтеграцію й вимикає доставку.
  - `POST /api/settings/integrations/slack/test` `{generation}` → синхронний результат `{outcome: success|failed|unknown, code, at, generation}` (тайм-аут ≤ параметра запиту).
- **Hot reload.**
  - Worker створюється завжди, коли увімкнено API-авторизацію. Кожні 5 с він перечитує налаштування й інтеграцію — один узгоджений знімок на цикл.
  - Оцінювання запускається, якщо `engineEnabled` і з останньої оцінки минув `intervalSeconds`; зміна інтервалу діє з наступної перевірки.
  - Single-flight і advisory lock — без змін.
  - Новий цикл start/stop створює новий `AbortController` (enable → disable → enable коректний).
  - Зміна правил (нова `revision`) обнуляє серії `pending`/`recovering` у `alert_conditions.rules_revision`: спостереження за старими порогами не зараховуються за новими. Відкриті інциденти, cooldown і baseline рестартів лишаються.
- **Черга й адресат.**
  - Кожен запис outbox прив'язаний до `generation` інтеграції; worker захоплює лише записи поточної generation.
  - Під час заміни чи видалення webhook, а також вимкнення доставки, усі `queued`/`sending` записи стають **`cancelled`** (`integration_changed` | `delivery_disabled`) — стара черга ніколи не пересилається новому адресату й не «вибухає» після повторного ввімкнення. UI попереджає про це перед дією.
  - HTTP-запит, що вже в польоті, може доставити повідомлення попередньому адресату; abort його не відкликає. Його результат не змінює нову інтеграцію, бо результат записує лише власник захоплення.
  - Зменшення ліміту черги нічого не видаляє: нові записи понад ліміт стають `dropped`.
- **Тестове повідомлення.**
  - Лише явною кнопкою admin і лише для **збереженої** інтеграції: `generation` має збігатися з поточною, інакше 409. Не залежить від `deliveryEnabled` і від рушія, не створює інцидент.
  - Позначене як тестове, без приватних даних.
  - Один тест за раз (інакше 409), 5 тестів/хв на актора, без автоповтору. Тайм-аут або abort → `unknown`.
  - Результат записується лише якщо `generation` не змінилась (тест старого webhook не «перевіряє» новий).
  - Audit `integration.slack_test_requested` до мережі й `integration.slack_test_result` після — з `operationId`, `generation`, outcome і кодом, без URL.
- **Audit (metadata-only):** `settings.alerts_changed` `{revision, changed}`, `settings.delivery_enabled` / `settings.delivery_disabled` `{revision, cancelledItems}`, `integration.slack_configured` `{generation, replaced, cancelledItems}`, `integration.slack_removed` `{generation, cancelledItems}`, `integration.slack_test_requested` / `integration.slack_test_result` `{operationId, generation, code}`.
- **Вихідна мережа API (Task 013.2).** Unit `node-control-api` мав `IPAddressDeny=any` + `IPAddressAllow=localhost` (Task 003). Через це systemd тихо відкидав з'єднання до Slack, і тест завершувався `unknown/timeout`. За рішенням користувача egress-фільтр знято. Вхідний доступ не змінився: listener лише на 127.0.0.1. Призначення вихідних запитів обмежує код: лише `https://hooks.slack.com/services/…`, `redirect: 'error'`, без адрес із браузера. Фіксовані IP Slack не використовуються, бо це адреси AWS, які змінюються.
- **Rollback на `e8f61c5`.** Старий реліз читає лише `ALERTS_*` з env, а в production їх немає: його рушій вимкнений, старий webhook не з'являється, доставка не вмикається. Нові таблиці та колонки він ігнорує.
  - _Уточнення (2026-10-17):_ це історичний варіант. Після ADR-023 і перейменування шляхів (ADR-025) реліз `e8f61c5` несумісний із поточною БД і layout — не використовувати; чинні цілі rollback — DEPLOYMENT.

## ADR-023: Серверний моніторинг — лише поточний load average; системні метрики виконує Zabbix

Статус: прийнято (2026-10-15, рішення користувача). Звужує ADR-015 (зміст heartbeat), ADR-020 (метрики Dashboard) і ADR-021 (правило `server_memory`). Історичні записи ADR-015/020/021 вище описують стан на момент їх прийняття.

**Рішення.**
- Сервери вже моніторяться в Zabbix; Node Control зосереджується на застосунках PM2 і керуванні ними, без дублювання системного моніторингу. Інтеграції із Zabbix немає.
- Із системних показників лишається тільки **поточний load average за 1/5/15 хв** (довжина черги процесів, не відсоток CPU) і службова доступність Agent: heartbeat, online/offline, останній сигнал, freshness. Для ідентифікації — `agentVersion`, `hostname`, `platform`, `arch`.
- Прибрано: пам'ять ОС, uptime ОС, кількість ядер — їх збір (Agent ≥ 0.5.0 навіть не читає ці значення з ОС), зберігання, API, UI; правило `server_memory` і пороги пам'яті ОС у налаштуваннях.
- Не змінюються: CPU/пам'ять/uptime/restarts/статус PM2-застосунків, правила `process_cpu`, `process_down`, `process_restarts`, а також `server_offline` і `inventory_stale` (доступність каналу керування й актуальність даних Node Control).
- Історія серверних метрик і графіки виключені з roadmap. Історія метрик застосунків не погоджена.

**Сумісність контракту heartbeat (перехідний період).**
- `POST /api/agent/heartbeat` вимагає `agentVersion, hostname, platform, arch, loadAverage` і **додатково приймає** legacy-поля Agent ≤ 0.4.x (`uptimeSeconds`, `cpuCount`, `memory`) лише в їхній точній старій формі (типи, межі, `additionalProperties: false`, free ≤ total). Вони не зберігаються й не використовуються. Інших полів не приймається. `loadAverage` — лише справжні JSON-числа (без коерції рядків).
- Збережені до зміни рядки `server_heartbeats.snapshot` (з legacy-ключами) читаються через `normalizeSnapshot`: назовні йдуть лише поточні поля; рядок іншої форми → «немає даних», не помилка 500.
- Legacy-поля можна прибрати зі схеми окремим завданням, коли на всіх керованих серверах Agent ≥ 0.5.0 (перевірка: `agentVersion` в останньому heartbeat кожного сервера).

**Виведення `server_memory` з експлуатації.**
- Нова resolution `retired` (міграція `1791900000008`, лише forward: розширення CHECK + одноразові дані): відкриті інциденти закриваються як «правило виведено», **не** як відновлення; recovery-повідомлення не створюються; їхні `queued` (і `sending` із простроченим lease) повідомлення скасовуються з `last_error = rule_retired`; стан умов (`alert_conditions`) видаляється. Історія й audit лишаються.
- Під час роботи: рушій правило не оцінює; кожне оцінювання ідемпотентно повторює виведення (на випадок, якщо старий API встиг щось створити між міграцією й рестартом); доставка (`claim`) не бере повідомлень виведеного правила й скасовує повернуті в чергу — навіть коли рушій вимкнено. Повідомлення, що доставляється саме в момент зміни, завершується штатно (це повідомлення про проблему/нагадування, не відновлення).
- `alert_settings.memory_open_percent/close_percent` лишаються в таблиці неактивними (NOT NULL + CHECK, сумісність зі старим релізом): новий рядок отримує 90/80, оновлення їх не змінюють, API їх не показує й не приймає (PATCH з ними → 400). `ALERTS_MEMORY_*` у env ігноруються з попередженням (лише назви ключів).

**Порядок деплою:** API/frontend (з міграцією) → перевірка старого Agent (0.4.x приймається) → новий Agent 0.5.0. Broker/exporter не змінюються.

**Rollback** (уточнено 2026-10-15 за review Codex P2; перше формулювання — «спершу Agent, потім старий API» — було неповним):
- Первісний реліз до ADR-023 (`c016beb`) **несумісний** з даними після ADR-023: мінімальні snapshot у БД (ADR-023 API пише їх і для Agent 0.4.x, бо прибирає legacy-поля) ламають у ньому server detail (500), Dashboard (503), оцінювання сповіщень (TypeError у кожному циклі), а heartbeat Agent 0.5.0 він відхиляє. Офлайн/деактивовані ноди нового heartbeat не надішлють, тож «дочекатися heartbeat» не рятує.
- Ціль відкату — compatibility-реліз `70ddd1f40b205306f0d61eb278cca9646c7e7d87` (гілка `release/monitoring-rollback-compat`, код `c016beb` + вузькі виправлення): приймає Agent 0.4.x і 0.5.0; відсутні host-метрики → `null`, не нулі; `server_memory` не оцінює; UI читає мінімальні snapshot і `retired`; містить уже застосовану міграцію 8; не доставляє outbox виведених правил (`RETIRED_RULES = ['server_memory']`: cleanup `queued`/протермінованих `sending` → `cancelled`/`rule_retired` і виключення в самому SQL вибірки `claim`, як у ADR-023 store). Процедура — DEPLOYMENT. Agent відкочувати не потрібно.
- Попередня compat-ревізія `1a6b82c251539aa9348b1fee6b997a0f3a254434` має відомий дефект (видавала на доставку елементи `server_memory`, зокрема `sending` з протермінованим lease) — як ціль відкату не рекомендована (review Codex P2, 2026-10-15).
- Старий frontend `c016beb` не розбирав `retired`; compat-реліз розбирає. Інциденти, закриті як `retired`, лишаються закритими; compat не створює для `server_memory` ні нових інцидентів, ні recovery-повідомлень.
- Схема production не відкочується, БД із backup поверх нових даних не відновлюється.

## ADR-024: Дії із загального списку застосунків і floating-меню рядка

Статус: прийнято (2026-10-15, UX-завдання користувача). Розширює UI ADR-016/017/018; backend, Agent і broker не змінюються.

- **«Застосунки» більше не read-only.** Колонка «Дії» показується лише з `processes:control` або `logs:read`; пункти — ті самі, що на сторінці сервера, у фіксованому порядку: «Запустити», «Зупинити», «Перезапустити», «Переглянути логи». Нових операцій немає.
- **Адресація.** Кожна дія — `serverId` рядка + `targetKey`, який broker підтвердив для того самого **імені й PM2 id** (рівно одна ціль). Однакові назви/PM2 id/targetKey на різних серверах не змішуються: можливості, діалог, POST і стан команди прив'язані до `serverId`.
- **Спільна логіка** (`components/processActions.tsx`): `rowMenu` (що пропонувати й чому ні — RBAC, API switch, broker online/fresh/allowlist, `matchStatus`, актуальність inventory, окремий дозвіл логів, підтримка агентом) і `useProcessCommands` (підтвердження, `bindSession`, abort, idempotency key на діалог, без автоматичного повтору POST, lifecycle кількох команд до фінального статусу, `unknown` чесно). `ProcessControl` (сторінка сервера) і `ApplicationsPage` використовують їх обидва; повний `ProcessControl` на рядок не монтується.
- **Можливості в загальному списку — ліниво** (`useServerCapabilities`): `GET /control` і `GET /log-targets` лише при відкритті меню рядка, на сервер (не на рядок), спільний запит для одночасних відкриттів, кеш 10 с, лише для серверів рядків на екрані (інші скидаються, їхні запити перериваються). Polling можливостей немає. Перед POST — свіже завантаження можливостей того сервера (`ensure(serverId, {fresh: true})`): `GET /control` і, якщо є `logs:read`, також `GET /log-targets` — тобто до двох GET; якщо для сервера вже виконується завантаження, використовується воно (без нових запитів). Рішення приймається лише за свіжим `control` (ціль та сама, `ok`, дія дозволена, керування готове); інакше POST не надсилається. Backend лишається остаточним джерелом авторизації.
- **Блокування.** Лише рядок цілі, для якої команда надсилається або ще не фінальна (як унікальний індекс API: одна активна команда на `(server, target)`); решта таблиці доступна.
- **Ліміт відстеження** (уточнено за review Codex P2): до 5 незавершених команд відстежуються одночасно (один GET кожної за інтервал); прийнята незавершена команда ніколи не витісняється новою; поки їх 5, новий POST не надсилається (пункти керування недоступні з поясненням, а в уже відкритому діалозі — помилка без POST із тим самим idempotency key для пізнішого явного повтору); фінальний статус від сервера звільняє місце, вигаданий фінальний статус не створюється. Обмежується лише список завершених (5 останніх).
- **Меню рядка — overlay** (`components/ActionMenu.tsx`): portal у `<body>`, `position: fixed` біля кнопки; не змінює висоту рядка, ширину таблиці чи scroll-контейнер, не обрізається `overflow`; вниз або вгору за доступним місцем, обмежена висота з власним scroll; scroll/resize перепозиціонують, тригер поза viewport або зниклий рядок — меню закривається. Одне відкрите меню. Семантика menu button (`aria-haspopup="menu"`, `role="menu"/"menuitem"`, стрілки/Home/End, Escape з поверненням фокуса, Tab виходить). Без нових залежностей.

## ADR-025: Нейтральна назва продукту та шляхів встановлення

Статус: прийнято (2026-10-16, рішення користувача). Продукт — персональний self-hosted **Node Control** без позиціонування як продукту компанії; технічний slug — `node-control`, Agent — Node Control Agent.

- Назви systemd units, системних користувачів і груп, ключі `NC_*`, БД/ролі PostgreSQL не змінюються (вони вже нейтральні); змінено лише відображувану назву, метадані пакетів, коментарі та шляхи встановлення (таблиця — DEPLOYMENT, «Перейменування шляхів встановлення»).
- Формат snapshot inventory — `node-control/pm2-inventory` v1: exporter і Agent — один артефакт, тож перехід атомарний (exporter запускається один раз до старту Agent); підтримки попереднього формату в коді немає.
- Наявні інсталяції переводяться `scripts/deploy/migrate-paths.js`: старі шляхи — лише явні параметри оператора з фактичних units (у коді немає жодних старих назв чи сумісних констант); preflight без змін, `rename(2)` без копіювання, журнал кроків, backup переписаних файлів, rollback і тимчасові aliases із `finalize`.
- Уточнення за review Codex (2026-10-16, два P2): (1) rollback переписаного файлу повертає **лише рядки, записані міграцією** (журнал зберігає точні рядки «до → після»), і лише якщо кожен знайдено однозначно; інший поточний вміст (ротовані секрети, незалежні ключі) зберігається; будь-який конфлікт — відмова до будь-якої зміни (спершу перевіряються всі кроки, є `--dry-run`); state попередньої версії — лише з явними `--legacy-map` і додатковою перевіркою повноти, інакше відмова й ручний recovery. Сліпого відновлення всього файлу з backup немає. (2) `--state` і `--backup-dir` не можуть перетинатися зі шляхами, які міграція переміщує, переписує чи aliasує (resolved-шляхи, symlinks); перевірка — до створення метаданих. Друге уточнення (P2 повторного review): перевірки rollback спираються на фактичний стан диска, а не на записи журналу — alias видаляється лише якщо це точно symlink цієї міграції, сторонній об'єкт на його місці чи на старому шляху переміщення — відмова до будь-яких змін; перед кожною деструктивною дією передумова перевіряється повторно, тож об'єкт, що з'явився під час rollback, не видаляється й не перезаписується.
- Маркери, за якими скрипти розпізнають власні ресурси PostgreSQL: правило `pg_hba` визначається за текстом правила (коментар лише описовий — наявний рядок у `pg_hba.conf` не змінюється); тестові ресурси — за `COMMENT`, тому `setup-test-db.js` приймає явний `--previous-comment` і лише тоді перемічає їх новим маркером.
- Не змінюються в межах цього рішення: назва репозиторію й remote, публічний домен і TLS, Slack, історія Git (старі commits, compatibility-гілка `70ddd1f` та її артефакт лишаються як були — їхні типові шляхи передаються явними `--base/--config`).

## ADR-026: Розгорнута панель застосунку, історія команд цілі й пошук за назвою

Статус: прийнято (2026-10-16, завдання користувача). Розширює ADR-016/017/018/024; Agent, broker, ролі й операції не змінюються.

- **Панель.** У «Застосунках» назва рядка — кнопка розгортання (`aria-expanded`/`aria-controls`); одночасно розгорнута одна панель — додатковий рядок таблиці (`td colSpan`), решта рядка не клікабельна (меню «Дії» й посилання сервера незалежні). Вкладки «Огляд» (дані рядка таблиці, без нових запитів), «Логи», «Історія дій»; рендериться лише активна. Новий список (фільтр, пошук, сторінка) або рядок, що зник чи змінив ідентичність (той самий ключ, інша назва), закриває панель; polling її не скидає. Ключ рядка — `serverId:source:pmId`; назва чи PM2 id окремо не є глобальною ідентичністю.
- **Дії й ліміти** — ті самі `rowMenu`/`useProcessCommands`/`useServerCapabilities` (ADR-024): кнопки панелі й меню рядка — одні й ті самі пункти; tracking прийнятих команд не залежить від згортання панелі чи зникнення рядка.
- **Логи inline.** `LogViewer` розділено на `LogTail` (один цикл читання, межі ADR-018) і dialog-обгортку; у «Застосунках» «Переглянути логи» відкриває панель на вкладці «Логи», на сторінці сервера лишається modal. Без `logs:read` логи не запитуються; текст не зберігається.
- **Історія цілі.** `GET /api/servers/:id/control-commands?targetKey=` — фільтр у SQL до `LIMIT` (10), права й server scope ті самі. Ідентичність команди — `server_id + target_key` (ключ allowlist), тому рядок зіставляється з історією лише через **підтверджену broker-ціль** (ім'я + PM2 id, рівно одна); scope показано явно: команди цієї цілі allowlist на цьому сервері — ключ міг відповідати й попереднім процесам. Немає підтвердженої цілі — пояснення, запиту немає (відмінне від порожньої історії). Історія показується користувачам із `processes:control` (зіставлення використовує їхні capabilities).
- **Пошук.** `GET /api/applications?q=`: підрядок назви без урахування регістру — `strpos(lower(name), lower(q))`, тобто `%`, `_`, `\` літеральні; trim, ≤ 128 символів, без керівних символів; разом із `serverId`/`status` до `LIMIT`; keyset-порядок той самий. Регістр кирилиці залежить від `lc_ctype` БД (production і тестова — `en_US.UTF-8`). Індексів не додано: при 500+ рядків — один bounded scan (план перевірено тестом). Cursor тепер містить відбиток фільтрів; cursor іншого списку → 400; cursor без відбитка (видані раніше) приймається для запитів без пошуку. UI: debounce 300 мс, `q` в URL (один запис історії на паузу), Back/Forward, очищення, захист від пізніх відповідей.

## ADR-027: Інсталятори первинного встановлення (Central API, Agent)

Статус: запропоновано (2026-10-20, завдання «просте встановлення»; до review Codex). Не змінює deployment contract (ADR-025, DEPLOYMENT) і release tooling.

- **Мова — TypeScript** (`installer/`, лише вбудовані модулі Node.js, без runtime-залежностей), як решта нового коду. Node.js 22 і так є передумовою на кожному сервері, а Bash ускладнив би приховане введення, атомарний запис секретів і тестування. Збірка `installer/dist` входить до обох артефактів і до `server-bundle/install/` (з власним `package.json`, ESM).
- **Без другої системи релізів:** релізи — лише через наявний `server-release.js` (`prepare`/`config`/`activate`); міграції — наявний `migrate.js` до активації; адміністратор — наявний `bootstrap-admin.js`; units — файли з підготовленого релізу. Інсталятор додає лише рішення навколо них.
- **Модель кроків:** preflight (лише читання; будь-яка помилка — стоп до змін) → упорядковані кроки, кожен спершу визначає «виконано / буде виконано / конфлікт» → перевірка результату. `plan` нічого не змінює; `apply` зупиняється на першій невдачі й повідомляє, що змінено; повторний запуск продовжує. Транзакційності системної інсталяції немає й не заявляється.
- **Ніколи не змінює наявне:** конфігурації лише доповнюються відсутніми ключами (з резервною копією 600); секрети не ротуються; чужі користувачі, файли, units і allowlist — конфлікт, а не перезапис; інший активний реліз, БД із наявною схемою — це оновлення, інсталятор зупиняється. Нічого не видаляє.
- **Секрети:** лише з файлу (root, без доступу групи/інших), stdin або прихованого вводу; не в argv, не в журналі; запис — тимчасовий файл із кінцевими правами в тому ж каталозі → rename.
- **PM2:** жодної команди `pm2`; inventory і керування — лише явними параметрами; allowlist створюється порожньою. PostgreSQL, Nginx/TLS і сертифікати — явні кроки оператора (є генератор конфігу Nginx без застосування).
- **Межа перевірки:** автоматичні тести на змодельованому хості + примітиви на справжній файловій системі; наскрізне встановлення на чистій Ubuntu VM — окремий крок перед заявою про підтримку конкретної версії.
- _Уточнення (review Codex, 2026-10-20, три P2):_
  - **Незавершені дії.** Потрібні `daemon-reload` і restart зберігаються між запусками у файлі стану `/var/lib/node-control-install/{server,agent}.json` (root 700/600, лише назви дій). Порядок: намір записується до зміни ресурсу, дія прибирається лише після успішного reload/restart. Збій, Ctrl+C чи аварійне завершення будь-де між цими точками не губить дію (щонайбільше один зайвий restart). `plan` стан лише читає. Пошкоджений або чужий стан — зупинка до змін і ручне відновлення (INSTALLATION, розділ 4). Інсталятор до цього уточнення стану не знає й не годиться для продовження незавершеного запуску нової версії.
  - **Підтвердження Agent** — лише від поточного запуску: InvocationID служби → журнал тільки цього запуску → останній результат heartbeat. Записи попередніх запусків не враховуються; сам `active` не є підтвердженням; на незміненому працюючому Agent restart заради перевірки не виконується.
  - **Облікові записи служб.** Наявний `nodecontrol`/`nodecontrol-agent` з UID 0 або основною групою root — зупинка в preflight, до будь-яких змін; чужий обліковий запис не змінюється.
