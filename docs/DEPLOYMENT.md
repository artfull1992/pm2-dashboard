# Деплой, перевірки та rollback

Стан за репозиторієм на 2026-10-12. Цей bootstrap змінює лише документацію; production-конфігурації, restart/reload служб, нові systemd units і Docker-файли не входять у scope.

## Факти та межі наявного процесу

- Реалізовані тільки PostgreSQL setup/check scripts. API, Agent, frontend build, health endpoint, прикладні міграції та deployment automation відсутні.
- Unit-файли Node Control, їх назви, сервісні користувачі, Nginx server block, домен, порти API та каталог frontend build ще не затверджені. Команди їх запуску не наводяться як готові.
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

## Rollback

За неуспішних перевірок застосувати підготовлений rollback лише якщо він безпечний для даних. Відновити погоджений артефакт/конфігурацію, перевірити конфігурацію й повторити health/smoke/status checks. Не видаляти БД, ролі або дані автоматично. Якщо rollback загрожує даним, зупинити залежні зміни, зафіксувати проблему та отримати рішення користувача.

Для документаційних змін rollback — окремий revert commit за потреби, без переписування історії. Готової автоматизації rollback для майбутніх API/Agent/UI поки немає.
