# Деплой, перевірки та rollback

Стан за репозиторієм на 2026-10-12 (Task 003). Central API деплоїться через systemd під окремим користувачем, лише на loopback; Nginx/домен/HTTPS ще не налаштовані. Фактичний звіт деплою — у [PROJECT_STATUS](PROJECT_STATUS.md).

## Факти та межі наявного процесу

- Реалізовані PostgreSQL setup/check scripts, базовий Central API (`backend/`, `/health/live`, `/health/ready`) і deployment scripts (`scripts/deploy/`, unit `deploy/systemd/`). Agent, frontend build, authentication і прикладні міграції відсутні.
- Затверджені для API: user `nodecontrol`, unit `node-control-api.service`, `/opt/goit-node-control`, `/etc/goit-node-control/api.env`, порт `127.0.0.1:3100` (див. нижче). Nginx server block, домен і каталог frontend build ще не затверджені.
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

## Central API: deployment contract (Task 003)

| Параметр | Значення |
|---|---|
| Сервер | `control-server` (`203.0.113.10`), Ubuntu 26.04.1 LTS; деплоїти лише після перевірки `hostname` |
| Runtime | `/usr/bin/node` — Node.js 22 (пакет `nodejs` nodesource); глобальний Node не оновлюється в межах деплою |
| Сервісний користувач | `nodecontrol` — системний, `/usr/sbin/nologin`, без home, без sudo, власна група |
| systemd unit | `node-control-api.service` ← `deploy/systemd/node-control-api.service` |
| Релізи | `/opt/goit-node-control/releases/<git-sha>` — `root:root`, без запису для group/other |
| Поточний / попередній | symlinks `/opt/goit-node-control/current`, `/opt/goit-node-control/previous` |
| Конфігурація | `/etc/goit-node-control/api.env` — `600 nodecontrol:nodecontrol`; каталог `750 root:nodecontrol`; єдине джерело — `ENV_FILE` у unit |
| Listener | `127.0.0.1:3100` (лише loopback; unit додатково `IPAddressAllow=localhost`) |
| Логи | journal, `SyslogIdentifier=node-control-api` (операційні логи, **не** Audit Log) |

Історичний `/etc/pm2-dashboard` (Task 001/002) не використовується сервісом і не змінюється; з нього лише один раз копіюються `DB_*` у новий конфіг.

### Артефакт

`node scripts/deploy/build-release.js` (на Node.js 22) приймає лише чистий робочий каталог і commit, що вже є в `origin/main`; збирає з `git archive` цього commit у тимчасовому каталозі (`npm ci`, `npm run backend:build`). Вміст: `backend/dist/*.js`, `package.json`, `package-lock.json`, `deploy/systemd/node-control-api.service`, `scripts/deploy/**`, `RELEASE.json` (revision + SHA-256 кожного файлу). Не потрапляють `.env*`, `.git`, `node_modules`, сирці, тести, source maps. Окремо — `.tar.gz.sha256` і `server-bundle/` (серверний скрипт для першого кроку).

### Процедура

```bash
# 0. Локально, Node.js 22, чистий і запушений commit
npm ci && npm test && npm run typecheck && npm run lint && npm run test:backend && npm run test:backend:smoke && npm run check:secrets
npx -y node@22 scripts/deploy/build-release.js           # друкує revision, artifact, sha256
SHA=<revision>; OUT=<out-dir з виводу>

# 1. Передача в новий каталог (без --delete, без .env)
ssh root@203.0.113.10 "test \"\$(hostname)\" = control-server && install -d -m 700 /root/node-control-deploy/$SHA"
scp $OUT/node-control-api-$SHA.tar.gz $OUT/node-control-api-$SHA.tar.gz.sha256 root@203.0.113.10:/root/node-control-deploy/$SHA/
scp -r $OUT/server-bundle root@203.0.113.10:/root/node-control-deploy/$SHA/

# 2. На сервері (root). Перший раз: користувач.
id nodecontrol || useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin nodecontrol
D=/root/node-control-deploy/$SHA
node $D/server-bundle/server-release.js prepare --artifact $D/node-control-api-$SHA.tar.gz \
  --sha256 "$(cut -d' ' -f1 $D/node-control-api-$SHA.tar.gz.sha256)" --revision $SHA   # checksum → manifest → npm ci --omit=dev
node $D/server-bundle/server-release.js config          # створює api.env лише якщо його немає; інакше тільки валідує

# 2a. Міграції (якщо реліз їх містить) — ДО активації, з підготовленого релізу, як nodecontrol (не superuser)
R=/opt/goit-node-control/releases/$SHA
run_migrate() { (cd / && runuser -u nodecontrol -- env ENV_FILE=/etc/goit-node-control/api.env /usr/bin/node $R/backend/dist/migrate.js "$1"); }
run_migrate status                                         # read-only: що pending
install -d -m 700 /root/node-control-backups
(umask 077 && runuser -u postgres -- pg_dump -Fc node_control_db > /root/node-control-backups/node_control_db-$(date -u +%Y%m%dT%H%M%SZ)-pre-$SHA.dump)
pg_restore --list /root/node-control-backups/<файл>.dump >/dev/null && echo backup-ok   # перевірка читабельності
run_migrate up                                             # одна транзакція, lock_timeout 10 с, statement_timeout 60 с
run_migrate status                                         # pending=0

# 3. Unit (із підготовленого релізу) + verify — ДО активації
install -m 644 /opt/goit-node-control/releases/$SHA/deploy/systemd/node-control-api.service /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/node-control-api.service
systemctl daemon-reload

# 4. Активація та запуск лише Node Control API
node $D/server-bundle/server-release.js activate --revision $SHA
systemctl enable node-control-api.service
systemctl restart node-control-api.service
```

### Перевірки після запуску

```bash
systemctl is-enabled node-control-api; systemctl is-active node-control-api
ps -o user=,pid=,cmd= -C node | grep node-control          # user = nodecontrol
ss -ltnp | grep ':3100 '                                   # лише 127.0.0.1:3100
curl -si http://127.0.0.1:3100/health/live                 # 200 {"status":"ok"}, no-store, x-request-id
curl -si http://127.0.0.1:3100/health/ready                # 200 {"status":"ready"}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/nope   # 404
journalctl -u node-control-api --since "-10 min" -o cat -p warning    # нових помилок немає
node /opt/goit-node-control/current/scripts/deploy/server-release.js status   # current=<SHA>
```

Не друкувати `systemctl show`/`/proc/<pid>/environ` і вміст `api.env`. Сторонні служби: `systemctl is-active postgresql@18-main nginx docker`, `docker ps`, `systemctl --failed`.

### Міграції: backup, recovery, rollback

- Перед кожним production `up` — `pg_dump -Fc` лише `node_control_db` у `/root/node-control-backups/` (каталог `700`, файл `600`), перевірка `pg_restore --list`. Не дамп усього кластера.
- Міграції лише additive і сумісні з попереднім релізом (health-only API не залежить від `users`). Rollback коду (`server-release.js rollback`) **не** відкочує схему; additive-об'єкти лишаються.
- Автоматичного `down`/drop у production немає. Відновлення з backup — окрема контрольована операція за доведеної потреби: спершу відновити в нову БД для перевірки (`createdb -O node_control_user node_control_db_restore_<ts>` + `pg_restore --no-owner --role=node_control_user -d node_control_db_restore_<ts> <dump>`), порівняти, і лише за рішенням оператора переключати/переносити дані — не знищуючи нових даних.

### Rollback

- **Є попередній реліз:** `node /opt/goit-node-control/current/scripts/deploy/server-release.js rollback` (атомарно міняє `current`↔`previous`) → за потреби відновити unit із попереднього релізу + `systemctl daemon-reload` → `systemctl restart node-control-api` → повторити перевірки. Конфіг не змінюється між релізами.
- **Перший деплой:** `systemctl disable --now node-control-api`. Реліз, конфіг, користувач і unit-файл лишаються для діагностики; БД, ролі та сторонні файли не чіпаються.
- Старі релізи в цій процедурі не видаляються.

### Доступ із VS Code / локальної машини

API не публікується. Для розробника — SSH port forwarding:

```bash
ssh -N -L 3100:127.0.0.1:3100 root@203.0.113.10
curl -s http://127.0.0.1:3100/health/ready
```

Nginx, домен і HTTPS — окремий наступний етап.

## Rollback

За неуспішних перевірок застосувати підготовлений rollback лише якщо він безпечний для даних. Відновити погоджений артефакт/конфігурацію, перевірити конфігурацію й повторити health/smoke/status checks. Не видаляти БД, ролі або дані автоматично. Якщо rollback загрожує даним, зупинити залежні зміни, зафіксувати проблему та отримати рішення користувача.

Для документаційних змін rollback — окремий revert commit за потреби, без переписування історії. Готової автоматизації rollback для майбутніх API/Agent/UI поки немає.
