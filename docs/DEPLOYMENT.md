# Деплой, перевірки та rollback

Стан за репозиторієм на 2026-10-12 (після Task 002). Production-деплою Central API не було; production-конфігурації, restart/reload служб, systemd units і Docker-файли не створювались.

## Факти та межі наявного процесу

- Реалізовані PostgreSQL setup/check scripts і базовий Central API (`backend/`, health endpoints `/health/live`, `/health/ready`), перевірений лише локально (loopback smoke). Agent, frontend build, authentication, прикладні міграції та deployment automation відсутні.
- Unit-файли Node Control, їх назви, сервісні користувачі, Nginx server block, домен, серверний порт API та каталог frontend build ще не затверджені. Локальний default API — `127.0.0.1:3100`; це не погоджений production-порт.
- README містить історичний rsync workflow у `/etc/pm2-dashboard/`. Це шлях із Task 001, не перевірений production deployment contract. `ENV_PATH` у коді — `.env` у корені checkout.
- За історичним серверним звітом кластер PostgreSQL — `18/main`, unit `postgresql@18-main`; конфігурації — `/etc/postgresql/18/main/`. Поточний серверний стан у цій сесії не перевірявся через SSH.
- `db:setup` потребує root і змінює роль, БД, ACL та HBA; його не запускати для read-only аудиту. Node.js-сервіси в майбутньому повинні працювати з мінімальними правами без root, якщо необхідність не доведено.

## Затверджений спосіб запуску

Central API та Agents — Node.js 22, systemd. PM2 керує лише застосунками користувачів, а не API/Agent. Frontend — статична React/Vite-збірка через host Nginx, без окремого production Node.js-процесу. PostgreSQL та Nginx — існуючі host-служби через systemd. API/Agent конфігуруються environment variables; credentials — `.env` або існуючий менеджер секретів, без секретів у Git/logs.

## Перед дозволеним деплоєм

1. Перевірити фактичний сервер, Git revision, scope, залежності, environment keys без виводу значень секретів, вплив на сторонні сервіси.
2. Виконати релевантні тести, lint/typecheck за наявності; повний integration suite — лише в ізольованому тестовому середовищі. Наявні тести мають DDL/DML і не призначені для запуску проти production-даних без адаптації.
3. Перевірити міграції, backup і відновлення. Для rollback застосунку бажані backward-compatible міграції; не покладатися на руйнівну down migration.
4. Підготувати конкретний rollback: попередній артефакт, backup потрібних конфігурацій, послідовність відновлення, критерії запуску й перевірки безпеки даних.
5. Для історичного rsync перевірити dry-run, scope `--delete`, збереження `.env` і виключення Git/dependencies. При зміні Nginx виконати `nginx -t` до редагування для baseline та після редагування до застосування; не перезаписувати сторонні server blocks.

## Застосування та перевірки

Виконувати лише погоджені зміни. Не відкривати 5432 або inbound-порти Agent, не зупиняти сторонні сервіси, не створювати новий Jenkins і не переписувати pipelines без потреби. Перед production Agent/API потрібні окремий дизайн і security tests каналу та автентифікації.

Після фактичного деплою перевірити статус визначених systemd units, health endpoint (коли реалізовано), API availability, application logs, database connectivity, regression smoke tests та відсутність впливу на сторонні сервіси. `npm run db:check` виконує SELECT 1 із поточним `.env`; його успіх не перевіряє весь деплой або політику TLS.

## Майбутній деплой Central API — передумови (не виконувалось)

Перелік того, що потрібно визначити й погодити до першого деплою. Назви unit-файлів, шляхи, домен і порт тут свідомо не задані.

1. **Сервісний користувач** без shell і без root; власник каталогу релізу лише на читання. `.env`/environment file — `600`, власник — цей користувач (зараз `/etc/pm2-dashboard/.env` належить root; `db:setup --env-owner` не змінює власника вже валідного файлу).
2. **Артефакт**: `npm ci` + `npm run backend:build` + `npm run check:local` на Node.js 22; на сервер — зібраний `backend/dist`, `package.json`, lockfile, `npm ci --omit=dev`. Без `.env` у артефакті.
3. **systemd unit** (ще не створений): `ExecStart=<node22> backend/dist/main.js`, `EnvironmentFile=` або `ENV_FILE=`, `Restart=on-failure`, `KillSignal=SIGTERM`, `TimeoutStopSec` більший за shutdown-таймаут API (10 с), hardening (`NoNewPrivileges`, `ProtectSystem`, `PrivateTmp` тощо — узгодити окремо).
4. **Listener**: лише loopback (`API_HOST=127.0.0.1`), вільний непривілейований порт — перевірити `ss -ltnp` перед запуском.
5. **Nginx**: окремий server block/location у `/etc/nginx/` із proxy на loopback-порт; `nginx -t` до і після змін; не змінювати чужі server blocks. Health endpoints публічні — вирішити, чи проксувати їх назовні.
6. **Перевірки після запуску**: `systemctl status`, `curl -fsS http://127.0.0.1:<port>/health/live` (200), `/health/ready` (200 при доступній БД), журнал без секретів і нових помилок, стан менеджер секретів/Nginx/PostgreSQL незмінний.
7. **Rollback**: зупинити лише unit API, повернути попередній артефакт (або вимкнути unit, якщо це перший деплой), видалити/відкотити тільки власний Nginx-конфіг із `nginx -t` і reload. БД не змінюється API на цьому етапі — database rollback не потрібен.

## Rollback

За неуспішних перевірок застосувати підготовлений rollback лише якщо він безпечний для даних. Відновити погоджений артефакт/конфігурацію, перевірити конфігурацію й повторити health/smoke/status checks. Не видаляти БД, ролі або дані автоматично. Якщо rollback загрожує даним, зупинити залежні зміни, зафіксувати проблему та отримати рішення користувача.

Для документаційних змін rollback — окремий revert commit за потреби, без переписування історії. Готової автоматизації rollback для майбутніх API/Agent/UI поки немає.
