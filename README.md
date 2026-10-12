# GOIT Node Control

Централізована платформа для моніторингу та керування Node.js-проєктами на декількох серверах.

> Етап 1 (Task 001): підготовка сервера та PostgreSQL. Backend, frontend і агент ще не реалізовані.

## Архітектурні принципи

1. Без Docker / Docker Compose — PostgreSQL і Nginx працюють безпосередньо на хості.
2. Backend у майбутньому запускається через systemd.
3. Конфігурації придатні для production; усі скрипти ідемпотентні.
4. Перед змінами — аудит ([docs/server-audit.md](docs/server-audit.md)), після змін — перевірка працездатності.
5. Кожен скрипт і кожна частина логіки покриті автоматизованими тестами.
6. Секрети живуть лише в `.env` (права `600`), ніколи в Git, документації чи логах.
7. Існуючі сервіси сервера (менеджер секретів, Nginx, інші БД) не змінюються.

## Системні вимоги

- Node.js ≥ 22, npm
- PostgreSQL 18 (на сервері — кластер `18/main`, port 5432)
- Для `npm run db:setup` і серверних перевірок: root на хості PostgreSQL

## Структура

```text
.
├── agent/            # майбутній агент на керованих серверах
├── backend/          # майбутній API (systemd)
├── frontend/         # майбутній UI
├── docs/
│   └── server-audit.md
├── scripts/
│   ├── lib/          # чиста логіка: env, пароль, SCRAM, SQL, pg_hba, план налаштування, пошук секретів
│   ├── setup-postgres.js   # npm run db:setup
│   ├── db-check.js         # npm run db:check
│   └── check-secrets.js    # npm run check:secrets
├── tests/
│   ├── unit/         # без мережі та БД
│   ├── integration/  # реальна БД через .env
│   └── helpers/
├── .env              # не в Git
├── .env.example
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

Повторний запуск нічого не ламає: існуюча роль лише перевіряється на атрибути, пароль **не перезаписується**. Якщо роль є, а `.env` загублено — скрипт зупиниться; змінити пароль можна явно:

```bash
npm run db:setup -- --rotate-password            # новий пароль + новий .env
npm run db:setup -- --env-owner nodecontrol      # власник .env (користувач сервісу)
npm run db:setup -- --skip-hba                   # не чіпати pg_hba.conf
```

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

## Тести та перевірки

```bash
npm test                  # unit: логіка скриптів, без БД
npm run test:integration  # реальна БД з .env: доступ, права, SCRAM, pg_hba, стан сервісу
npm run check             # check:secrets + unit + integration
npm run db:check          # SELECT 1 через .env, без виводу пароля
```

Integration-тести змінюють лише `node_control_db`: тимчасова таблиця створюється і видаляється, спроба `CREATE DATABASE` має завершитись відмовою.
Серверні перевірки (`pg_authid`, `pg_hba.conf`, systemd) виконуються лише від root на хості PostgreSQL; з машини розробника вони позначаються як skipped — тому `npm run check` треба запускати **і на сервері**.

## Робота через VS Code

Проєкт розробляється в локальному checkout. Сервер не має доступу до GitHub — код потрапляє туди окремо:

```bash
# деплой коду (без .env, node_modules, .git)
rsync -az --delete --no-owner --no-group \
  --exclude .git --exclude node_modules --exclude '.env' --exclude '.env.*' --include .env.example \
  ./ root@203.0.113.10:/etc/pm2-dashboard/
ssh root@203.0.113.10 'cd /etc/pm2-dashboard && npm ci --omit=dev && npm run check'
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
- Віддалений доступ (`hostssl ... 0.0.0.0/0`) підготовлено, але **не активовано**: 5432 ззовні фільтрується (ймовірно, firewall провайдера); host firewall — див. приватні нотатки. Відкривати порт — лише окремим рішенням і бажано для конкретних IP.
- `.env` на сервері належить `root`, бо окремого користувача сервісу ще немає.
- Парсер `pg_hba.conf` не підтримує значення в лапках із пробілами (на сервері таких немає).

## Наступні етапи

1. Окремий системний користувач для backend + systemd unit; перевласнити `.env`.
2. Backend API та схема БД (міграції).
3. Агент для збору стану Node.js/PM2-процесів на серверах.
4. Frontend, Nginx reverse proxy з TLS.
5. Довірений TLS-сертифікат для PostgreSQL і рішення щодо зовнішнього доступу до 5432.
