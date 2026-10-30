# Аудит безпеки Node Control — 2026-10-30

База: `c6fdac2`; код погодженої production revision `0dda425`. Статус: **CHANGES REQUIRED для завершення security-підготовки**. Це аудит, а не зміна попереднього APPROVED frontend. Функціональний код і production-конфігурації не змінювались.

## Межі й метод

Перевірено код auth/session/CSRF/RBAC, ресурсні scope, створення та видачу команд, читання логів, Slack URL/шифрування, обробку помилок, логування, systemd units, legacy DB setup та lockfile. Виконано локальні regression-перевірки й npm audit. Перевірки коду вибіркові, не є формальним доказом відсутності всіх вразливостей.

Виконано лише обмежені read-only зовнішні мережеві перевірки: HTTPS HEAD та одне TCP-з’єднання до історично проблемного порту. Приватні операційні докази збережені поза Git; адреси й сирі заголовки не публікуються. SSH-аудит host firewall/HBA/прав, реальні PM2/Slack-дії, authenticated production UI, pentest і перебір паролів не виконувались. Встановлення x86_64 перевірятиме оператор на своїх машинах; відновлення backup відкладено користувачем до апгрейду сервера.

## Зауваження до коду й залежностей

### SEC-DEP-01 / P2 — production-залежності мають відомі advisories

`package-lock.json:2216`, `:2952`, `:2968`: fast-uri 3.1.8 / 4.2.2, Fastify 5.12.5. `npm ls` підтвердив ланцюжок через Fastify, Ajv compiler і fast-json-stringify. `npm audit` повідомив moderate для fast-uri та low для Fastify.

- [Fastify header propertyNames bypass](https://github.com/advisories/GHSA-389g-gv7q-r4x8): виправлено у 5.12.6.
- [fast-uri URI scheme spoofing](https://github.com/advisories/GHSA-w74x-v6f9-j3xg): виправлено у 3.1.9 / 4.2.3; audit також повідомив інші URI-normalization advisories цього пакета.

Обхід авторизації Node Control не відтворено. У коді не знайдено header-схем propertyNames; Slack перевіряється окремим строгим regex і не використовує fast-uri як URL allowlist. Наявність уразливої версії не доводить експлуатацію в нашому сценарії.

**Виправлення:** оновити прямі залежності/lockfile до сумісних виправлених версій, перевірити обидві копії fast-uri, повторити production-only audit та auth/API/schema regression. Не запускати автоматичний `npm audit fix --force` і не вважати нову збірку production-деплоєм.

### SEC-DEP-02 / P2 — high advisories у dev-залежності Undici

`package-lock.json:4808`: Undici 7.30.0, `dev: true`, ланцюжок `jsdom@29.1.1 → undici`. Наприклад, [DoS через excessive content-encodings](https://github.com/advisories/GHSA-xjj6-f33q-929c), виправлено у 7.30.1. Audit також повідомив інші moderate/high advisories Undici.

Це залежність тестового середовища, не підтверджена production npm-залежність. Node.js має власний bundled Undici: його версію й advisories слід перевіряти окремо, `npm audit` lockfile цього не закриває.

**Виправлення:** оновити сумісний dev dependency tree до виправленої версії, повторити frontend/UI-тести й audit. Окремо інвентаризувати runtime Node.js на реальних серверах без автоматичної заміни системного Node.js.

### NC-SEC-001 / P2 — динамічні ключі відображаються у validation.path

`backend/src/errors.ts:111–124`: instancePath копіюється до публічної відповіді; коментар про те, що він завжди походить зі структури схеми, некоректний для динамічних ключів.

Незалежне відтворення: локальний Fastify-маршрут із `additionalProperties: { type: 'integer' }`, payload із синтетичним ключем і неправильним типом. Відповідь 400 містить цей ключ у `validation[0].path`. Жодних production-запитів для відтворення не було.

У чинних request-схемах динамічних ключів не знайдено; `ranges` із additionalProperties у settings є response-схемою. Це відомий прихований ризик, не підтверджений витік через поточний endpoint.

**Виправлення:** віддавати лише перевірені статичні сегменти шляхів або узагальнений безпечний шлях; додати regression для динамічних/вкладених ключів, escaping та відсутності ключа у відповіді й логах. Узгодити коментар і документацію.

### SEC-DB-SETUP-01 / P2 — legacy db:setup додає надто широкий HBA

`scripts/lib/config.js:15–23`, `scripts/setup-postgres.js`: команда `db:setup` додає hostssl/SCRAM правило для власної БД/ролі з адресою `0.0.0.0/0`. Це не означає, що listener/firewall автоматично відкриті; однак дозволяє будь-яке IPv4-джерело на рівні цього HBA-правила, якщо мережа доступна. Модель API використовує локальну БД.

**Виправлення:** локальний безпечний default, remote CIDR лише через явний документований opt-in. Перевірити план і regression; не змінювати автоматично сторонні HBA-правила чи production PostgreSQL. Поточний стан HBA сервера з коду не визначається.

## Операційні release gates

Детальні результати й прив’язка до сервера — у приватному звіті поза Git.

- **SEC-OPS-01 / P1:** підтвердити й усунути непотрібний зовнішній доступ до DB-порту. Спочатку визначити процес/listener, HBA, мережеві правила та сторонніх споживачів; потім окремо погоджувати зміну мережі. Перевірити IPv4/IPv6 і доступність для легітимних клієнтів. Успішне TCP-з’єднання не доводить доступ до даних.
- **SEC-OPS-02 / P2:** забезпечити захисні заголовки публічного Nginx: CSP, frame protection, nosniff, Referrer-Policy, HSTS після перевірки TLS-вимог. CSP спочатку звірити з чинним frontend і браузерними тестами; перед застосуванням обов’язковий `nginx -t`. Не вмикати includeSubDomains/preload без інвентаризації доменів. Відсутність CSP сама по собі не доводить XSS.

Ці операційні gates не закриті. Зміни Nginx/HBA/firewall цим аудитом не виконувались.

## Перевірені захисні механізми

Код і чинні локальні тести підтверджують: deny-by-default access declarations для API, розділену cookie/bearer автентифікацію, перевірку Origin та session-bound CSRF для змін, повторне читання ролі/active, криптографічні session/Agent токени й hash-only зберігання, HttpOnly/SameSite/Secure cookie, bounded scrypt та rate limits. Resource scopes застосовуються у SQL; команди перевіряють роль/доступ при створенні й dispatch; довгі читання логів повторно перевіряють сесію/доступ. Це перевірка реалізованих механізмів, не гарантія всіх конкурентних сценаріїв на production.

Broker використовує Unix socket та визначені PM2 RPC-операції без shell; перевіряє identity і дедуплікацію. Логи обмежені дозволеними каталогами, розміром і типом файлу; маскування секретів явно best effort. Slack URL обмежений hooks.slack.com/services, redirects заборонені, ciphertext AES-256-GCM прив’язаний AAD до generation. Units запускають компоненти non-root із hardening. Фактичні права production-файлів та відповідність встановлених units аудитом не підтверджені.

## Виконані перевірки

- `check:local`: exit 0; node:test 147, backend 525, smoke 10, agent 176 + 3 opt-in skipped, frontend 496, installer 295; typecheck/lint/build/secrets.
- `npm audit --json`: exit 1 через 3 пакети з advisories (1 low, 1 moderate, 1 high); це severity пакетів, не оцінка підтвердженої атаки на продукт.
- `npm audit --omit=dev --json`: exit 1, лише 2 пакети (1 low, 1 moderate; high/critical 0).
- `npm ls fast-uri fastify undici`: підтверджено версії й dev/prod ланцюжки.
- Синтетичний reproducer NC-SEC-001: підтверджено 400 із відображеним ключем.
- DB-suite, повні UI/E2E, реальний PM2, restore, reboot та x86_64 install не повторювались. Код не змінювався; поточні live database/RBAC і host hardening потребують окремих перевірок.

## Наступні кроки

1. Окремий read-only аудит мережі/DB та план закриття SEC-OPS-01 без порушення сторонніх сервісів.
2. Виправлення залежностей, NC-SEC-001 і legacy HBA default з тестами та незалежним review.
3. Окреме погоджене застосування Nginx hardening і необхідних мережевих змін із backup/rollback.

Безпековий APPROVED до закриття зауважень і необхідних host-перевірок не виставляється. Інсталятори x86_64 та restore мають окремі відкладені статуси й цим аудитом не закриваються.
