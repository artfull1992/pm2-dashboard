# Деплой, перевірки та rollback

Стан за репозиторієм на 2026-10-12 (Task 006). Central API — systemd під `nodecontrol` на `127.0.0.1:3100`; frontend — статика з того самого релізу через host Nginx. Публічний запуск не погоджено. Фактичний звіт деплою — у [PROJECT_STATUS](PROJECT_STATUS.md).

## Факти та межі наявного процесу

- Реалізовані: PostgreSQL setup/check scripts, Central API (health, auth, RBAC, audit, реєстр серверів, Agent heartbeat), міграції, frontend (React/Vite), Agent, deployment scripts (`scripts/deploy/`), шаблони `deploy/systemd/` (API, Agent). Agent і API серверів/процесів відсутні.
- Затверджені: user `nodecontrol`, unit `node-control-api.service`, `/opt/goit-node-control`, `/etc/goit-node-control/api.env`, API `127.0.0.1:3100`; frontend — `current/frontend/dist`, публічний сайт `https://control.example.com` (нижче).
- Історичний rsync у `/etc/pm2-dashboard/` (Task 001/002) **не використовується**; там лишаються стара збірка й legacy `.env` (джерело `DB_*` для одноразового створення `api.env`).
- За історичним серверним звітом кластер PostgreSQL — `18/main`, unit `postgresql@18-main`; конфігурації — `/etc/postgresql/18/main/`. Поточний серверний стан у цій сесії не перевірявся через SSH.
- `db:setup` потребує root і змінює роль, БД, ACL та HBA; його не запускати для read-only аудиту. Node.js-сервіси в майбутньому повинні працювати з мінімальними правами без root, якщо необхідність не доведено.

## Затверджений спосіб запуску

Central API та Agents — Node.js 22, systemd. PM2 керує лише застосунками користувачів, а не API/Agent. Frontend — статична React/Vite-збірка через host Nginx, без окремого production Node.js-процесу. PostgreSQL та Nginx — існуючі host-служби через systemd. API/Agent конфігуруються environment variables; credentials — `.env` або існуючий менеджер секретів, без секретів у Git/logs.

## Перед дозволеним деплоєм

1. Перевірити фактичний сервер, Git revision, scope, залежності, environment keys без виводу значень секретів, вплив на сторонні сервіси.
2. Виконати релевантні тести, lint/typecheck за наявності; повний integration suite — лише в ізольованому тестовому середовищі. Наявні тести мають DDL/DML і не призначені для запуску проти production-даних без адаптації.
3. Перевірити міграції, backup і відновлення. Для rollback застосунку бажані backward-compatible міграції; не покладатися на руйнівну down migration.
4. Підготувати конкретний rollback: попередній артефакт, backup потрібних конфігурацій, послідовність відновлення, критерії запуску й перевірки безпеки даних.
5. При зміні Nginx виконати `nginx -t` до редагування для baseline та після редагування до застосування; не перезаписувати сторонні server blocks.

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
| Listener | `127.0.0.1:3100` (лише loopback, `API_HOST` валідується). Egress-фільтра `IPAddressDeny` немає з Task 013.2: потрібен вихідний HTTPS до Slack; призначення обмежує код (лише `hooks.slack.com/services/…`) |
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

### Auth-конфігурація (Task 005)

`/etc/goit-node-control/api.env` лише доповнюється non-secret ключами, яких бракує; DB credentials, власник (`nodecontrol`) і права `600` зберігаються. Перед зміною — копія `api.env.bak-<ts>` (`600`), атомарний запис через тимчасовий файл у тому ж каталозі:

```text
AUTH_COOKIE_SECURE=true          # production: завжди true
AUTH_SESSION_TTL_MINUTES=480
AUTH_ALLOWED_ORIGINS=            # порожньо → login вимкнено, доки немає HTTPS-origin frontend (Task 006 + Nginx)
```

Коли з'явиться frontend за Nginx/HTTPS: `AUTH_ALLOWED_ORIGINS=https://<точний домен>` і restart лише `node-control-api`.

### Bootstrap адміністратора (оператор, одноразово)

Виконує оператор, коли визначено email; пароль вводиться приховано двічі, в argv/історію shell не потрапляє. Потрібні застосовані міграції (`status` pending=0).

```bash
cd / && runuser -u nodecontrol -- env ENV_FILE=/etc/goit-node-control/api.env \
  /usr/bin/node /opt/goit-node-control/current/backend/dist/bootstrap-admin.js --email <admin-email>
# exit 0 — створено (друкується id); 3 — адміністратор уже існує або email зайнятий (нічого не змінено);
# 2 — ввід/параметри; 1 — помилка БД (нічого не закомічено).
```

Без TTY (автоматизація) — лише `--password-stdin` із захищеного джерела (pipe із менеджера секретів або файл `600`, який одразу видаляється); не через `echo` у shell history. Повторний запуск не скидає пароль і не створює другого адміністратора.

### Очищення сесій

Автоматично: під час кожного login видаляються сесії цього користувача, що завершились/відкликані понад добу тому. Масово (за потреби, як `nodecontrol`/власник БД):

```sql
DELETE FROM sessions WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day';
```

Відкликати всі сесії (інцидент): `UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL;`

### Frontend і публічний HTTPS-сайт (Task 006)

| Параметр | Значення |
|---|---|
| Збірка | `build-release.js`: `npm run frontend:build` з того самого `git archive`; `frontend/dist` у артефакті й manifest; перевірка bundle (немає `.map`, серверних імен конфігурації, секретних шаблонів) |
| Статика | `/opt/goit-node-control/current/frontend/dist` (`root:root`, читання для `www-data`); UI і API перемикаються одним `current` |
| Сайт | `https://control.example.com` — `/etc/nginx/conf.d/control.example.com.conf`, **керує власник сервера** (Certbot), скрипти Node Control його не встановлюють і не змінюють |
| TLS | Let's Encrypt, `CN=control.example.com`; оновлення — `snap.certbot.renew.timer`; HTTP → 301 на HTTPS |
| `/api/` | `proxy_pass http://127.0.0.1:3100` без URI (шлях і query без змін); невідомий `/api/*` → JSON 404 API; Origin передається як є; заголовки — нижче (ADR-014) |
| SPA | `location /` → `try_files $uri $uri/ /index.html`; `/index.html` — `Cache-Control: no-store` |
| API-конфіг | `AUTH_ALLOWED_ORIGINS=https://control.example.com`, `AUTH_COOKIE_SECURE=true`, `API_TRUSTED_PROXIES=127.0.0.1` |

Заголовки в `location /api/` (Task 006.1; узгоджено з `API_TRUSTED_PROXIES=127.0.0.1`):

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;            # довідково; API його НЕ використовує
proxy_set_header X-Forwarded-For $remote_addr;      # ЗАМІНЮЄ клієнтський заголовок — не $proxy_add_x_forwarded_for
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;            # клієнт не може підставити свій host
```

Порядок застосування: спершу Nginx (заміна `X-Forwarded-For` безпечна і для старого релізу, який заголовки ігнорує), потім `API_TRUSTED_PROXIES` + реліз + restart API. Rollback — у зворотному порядку: прибрати ключ/повернути реліз, restart API, потім за потреби Nginx. Ніколи не вмикати `API_TRUSTED_PROXIES`, поки Nginx пропускає клієнтський `X-Forwarded-For`.

Окремий loopback-сайт `127.0.0.1:3101` (перша редакція Task 006) прибрано: файли збережено в `/root/node-control-backups/nginx-*`, шаблони видалено з репозиторію й артефакту.

Перевірка після деплою: `curl -sI https://control.example.com/` (200), прямі SPA-маршрути (`/servers`, `/audit` → `index.html`), `/assets/*` (200), `GET /api/auth/me` без cookie → 401 `no-store`, невідомий `/api/*` → JSON 404, `POST /api/auth/login` з чужим Origin → 403 (без запису в БД). Login із правильним Origin у production не перевіряється (пише audit) — повний auth-flow лише E2E на тестовій БД.

Rollback: `server-release.js rollback` повертає узгоджену пару UI/API + `systemctl restart node-control-api`; `api.env` — з `api.env.bak-<ts>`. Конфіг сайту не змінюється деплоєм.

### Agent (Task 007)

Окремий versioned-артефакт `node-control-agent-<sha>.tar.gz` (будує той самий `build-release.js`): `agent/dist`, `agent/package.json`, `deploy/systemd/node-control-agent.service`, `scripts/deploy/**`, `RELEASE.json`. Без npm-залежностей (`prepare --no-install`).

| Параметр | Значення |
|---|---|
| Користувач | `nodecontrol-agent` — системний, `/usr/sbin/nologin`, без home/sudo, без доступу до PM2 |
| Релізи | `/opt/goit-node-control-agent/releases/<sha>`, `current`/`previous` |
| Конфіг | `/etc/goit-node-control-agent/agent.env` — `600 nodecontrol-agent`, каталог `750 root:nodecontrol-agent` |
| Unit | `node-control-agent.service` (`deploy/systemd/`), `Restart=on-failure`, `RestartPreventExitStatus=2` (немає/некоректний токен → не перезапускати по колу) |
| Мережа | лише вихідний HTTPS до `NC_AGENT_API_URL`; inbound-порту немає; `IPAddressAllow=localhost` **не** застосовується (потрібен вихід) |

```bash
# на кожній керованій ноді (root); артефакт і server-bundle передано як для API
id nodecontrol-agent || useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin nodecontrol-agent
install -d -m 755 /opt/goit-node-control-agent
node server-bundle/server-release.js prepare --base /opt/goit-node-control-agent --no-install \
  --artifact node-control-agent-$SHA.tar.gz --sha256 "$(cut -d' ' -f1 node-control-agent-$SHA.tar.gz.sha256)" --revision $SHA
node server-bundle/server-release.js activate --base /opt/goit-node-control-agent --revision $SHA
install -d -m 750 -o root -g nodecontrol-agent /etc/goit-node-control-agent
install -m 644 /opt/goit-node-control-agent/current/deploy/systemd/node-control-agent.service /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/node-control-agent.service && systemctl daemon-reload
```

Без `agent.env` unit не вмикати: Agent без конфігу завершується з кодом 2 і не перезапускається.

**Активація (оператор):** UI → Сервери → «Додати сервер» → сторінка сервера → «Видати ключ» (показується один раз). На ноді записати конфіг без потрапляння токена в argv/історію shell:

```bash
umask 077; read -rs NC_AGENT_TOKEN   # вставити ключ, Enter (не відображається)
printf 'NC_AGENT_API_URL=https://control.example.com\nNC_AGENT_TOKEN=%s\n' "$NC_AGENT_TOKEN" \
  | install -m 600 -o nodecontrol-agent -g nodecontrol-agent /dev/stdin /etc/goit-node-control-agent/agent.env
unset NC_AGENT_TOKEN
systemctl enable --now node-control-agent
journalctl -u node-control-agent -n 5 -o cat      # "outcome":"accepted"
```

Ротація: «Видати новий ключ» у UI → перезаписати `agent.env` → `systemctl restart node-control-agent`. Відкликання: «Відкликати ключ» у UI (агент отримає 401 і перейде на рідкі повтори; `systemctl disable --now node-control-agent`). Credentials не видаляються SQL — лише відкликаються через UI (audit).

Rollback Agent: `server-release.js rollback --base /opt/goit-node-control-agent` + restart, або `systemctl disable --now node-control-agent`. Rollback API на реліз до Task 007: endpoint heartbeat зникне (404) — агенти перейдуть у backoff; дані реєстру (additive-таблиці) лишаються.

### PM2 inventory exporter (Task 008, ADR-016)

Лише читання. Exporter постачається в артефакті Agent (`agent/dist/pm2-exporter.js`, `deploy/systemd/node-control-pm2-exporter@.service|.timer`). Він працює від **власника PM2** (не root), раз на 30 с читає існуючий daemon (`getMonitorData`) і атомарно пише `/var/lib/goit-node-control-pm2/inventory.json`. PM2 і проєкти не перезапускаються, глобальний PM2 і системний Node.js не змінюються. Немає daemon → snapshot `unavailable/daemon_not_running`, daemon не запускається.

Потрібні параметри від оператора: Linux-користувач, від якого працює PM2 (`PM2_OWNER`), і абсолютний `PM2_HOME` (зазвичай `/home/<user>/.pm2`). Не вгадувати й не сканувати чужі home-каталоги. PM2 від root — не підтримується.

```bash
# на керованій ноді (root). Agent уже оновлено до релізу, що містить 7cdc50e (НЕ ffb32b0: там unit exporter із
# ConditionUser=!root, через який instance пропускається). Перевірка: git merge-base --is-ancestor 7cdc50e <release-sha>
PM2_OWNER=<user>                 # власник PM2 (не root: instance @root завершиться з exit 2)
PM2_HOME=/home/<user>/.pm2       # абсолютний шлях
# 0. Лише перевірки (нічого не змінюють; pm2-команди НЕ запускати):
id "$PM2_OWNER"; stat -c '%U %a %F %n' "$PM2_HOME" "$PM2_HOME/rpc.sock"; /usr/bin/node --version
id -nG nodecontrol-agent         # Agent НЕ має бути в основній групі власника PM2 (rpc.sock = 775)
# 1. Вузька група читання snapshot: лише Agent (exporter пише через setgid-каталог, у групі не потрібен)
getent group nc-pm2-inventory || groupadd --system nc-pm2-inventory
usermod -aG nc-pm2-inventory nodecontrol-agent
# 2. Каталог snapshot: власник — PM2 owner, група читання, setgid, без запису для групи/інших
install -d -o "$PM2_OWNER" -g nc-pm2-inventory -m 2750 /var/lib/goit-node-control-pm2
# 3. Конфіг exporter (без секретів)
install -d -m 755 /etc/goit-node-control-pm2-exporter
printf 'NC_PM2_HOME=%s\nNC_PM2_SNAPSHOT_FILE=/var/lib/goit-node-control-pm2/inventory.json\nNC_PM2_SOURCE=pm2\n' "$PM2_HOME" \
  | install -m 644 /dev/stdin "/etc/goit-node-control-pm2-exporter/$PM2_OWNER.env"
# 4. Unit-шаблони з активного релізу Agent
install -m 644 /opt/goit-node-control-agent/current/deploy/systemd/node-control-pm2-exporter@.service \
               /opt/goit-node-control-agent/current/deploy/systemd/node-control-pm2-exporter@.timer /etc/systemd/system/
systemd-analyze verify "/etc/systemd/system/node-control-pm2-exporter@$PM2_OWNER.service" && systemctl daemon-reload
# 5. Один пробний запуск і перевірка (state ok або причина unavailable; без імен процесів у журналі)
systemctl start "node-control-pm2-exporter@$PM2_OWNER.service"
journalctl -u "node-control-pm2-exporter@$PM2_OWNER" -n 3 -o cat     # "Finished …" і "inventory exported"; НЕ "skipped, unmet condition"
stat -c '%U:%G %a' /var/lib/goit-node-control-pm2/inventory.json      # <owner>:nc-pm2-inventory 640
# 6. Таймер
systemctl enable --now "node-control-pm2-exporter@$PM2_OWNER.timer"
# 7. Agent: увімкнути inventory (токен у файлі не змінюється) і перезапустити
grep -q '^NC_AGENT_INVENTORY_FILE=' /etc/goit-node-control-agent/agent.env \
  || printf 'NC_AGENT_INVENTORY_FILE=/var/lib/goit-node-control-pm2/inventory.json\n' >> /etc/goit-node-control-agent/agent.env
stat -c '%U %a' /etc/goit-node-control-agent/agent.env                # nodecontrol-agent 600
systemctl restart node-control-agent
journalctl -u node-control-agent -n 5 -o cat                            # "msg":"inventory","outcome":"accepted","state":"ok"
```

Перевірки після: PM2-процеси не перезапускалися (`restart_time`/аптайм у UI не змінилися), heartbeat «Онлайн», у UI «Застосунки» — процеси з позначкою «Актуально». Журнали exporter/Agent містять лише стан, причину й кількість.

Rollback inventory (PM2 і проєкти не зачіпаються): `systemctl disable --now node-control-pm2-exporter@$PM2_OWNER.timer`; прибрати рядок `NC_AGENT_INVENTORY_FILE` з `agent.env` і `systemctl restart node-control-agent` (heartbeat продовжує працювати). Каталог/файл snapshot і група можуть лишитися (без секретів) або бути видалені вручну. Rollback API до релізу без inventory: Agent отримує 404 і переходить на рідкі спроби; таблиці inventory лишаються (additive).

### Керування PM2 (Task 009, ADR-017) — production enable лише явно

Типовий стан після деплою: `PM2_CONTROL_ENABLED` не задано (= `false`), Agent без `NC_AGENT_CONTROL_SOCKET`, broker не встановлений. Будь-який із трьох кроків нижче, не виконаний, лишає керування вимкненим (fail closed). PM2 і проєкти при встановленні не перезапускаються.

**Потрібно від оператора:** для кожного процесу — ім'я в PM2, бажаний `targetKey` (`^[a-z0-9][a-z0-9._-]{0,63}$`) і дозволені дії (`start`/`stop`/`restart`). Cluster-процеси та процеси з повторюваними іменами не підтримуються.

```bash
# --- Крок 1. Broker на керованій ноді (root). PM2_OWNER/PM2_HOME — ті самі, що для exporter.
PM2_OWNER=<user>; PM2_HOME=/home/<user>/.pm2
getent group nc-pm2-control || groupadd --system nc-pm2-control
install -d -m 755 /etc/goit-node-control-pm2-broker
printf 'NC_PM2_HOME=%s\nNC_BROKER_ALLOWLIST=/etc/goit-node-control-pm2-broker/%s.allowlist.json\n' "$PM2_HOME" "$PM2_OWNER" \
  | install -m 644 /dev/stdin "/etc/goit-node-control-pm2-broker/$PM2_OWNER.env"
# Порожня allowlist (root:root 644): broker відхиляє все, доки оператор не додасть цілі.
printf '{"version":1,"targets":[]}\n' | install -m 644 -o root -g root /dev/stdin "/etc/goit-node-control-pm2-broker/$PM2_OWNER.allowlist.json"
install -m 644 /opt/goit-node-control-agent/current/deploy/systemd/node-control-pm2-broker@.service /etc/systemd/system/
systemd-analyze verify "/etc/systemd/system/node-control-pm2-broker@$PM2_OWNER.service" && systemctl daemon-reload
# Fingerprint потрібних процесів (виводить pm_id, name, exec_mode, fingerprint — без шляхів/env; лише існуючий daemon):
runuser -u "$PM2_OWNER" -- env NC_PM2_HOME="$PM2_HOME" NC_BROKER_ALLOWLIST=/etc/goit-node-control-pm2-broker/$PM2_OWNER.allowlist.json \
  /usr/bin/node /opt/goit-node-control-agent/current/agent/dist/pm2-broker.js fingerprint
# Заповнити allowlist (root), наприклад:
# {"version":1,"targets":[{"id":"api-prod","name":"api","actions":["restart"],"fingerprint":"sha256:…"}]}
systemctl enable --now "node-control-pm2-broker@$PM2_OWNER.service"
journalctl -u "node-control-pm2-broker@$PM2_OWNER" -n 3 -o cat       # "broker started"
stat -c '%U:%G %a' /run/goit-node-control-pm2-broker /run/goit-node-control-pm2-broker/broker.sock   # <owner>:nc-pm2-control 750 / 660

# --- Крок 2. Agent: доступ лише до сокета broker (НЕ до rpc.sock), backup конфігу, restart лише Agent.
usermod -aG nc-pm2-control nodecontrol-agent
cp -p /etc/goit-node-control-agent/agent.env /etc/goit-node-control-agent/agent.env.bak-$(date -u +%Y%m%dT%H%M%SZ)
grep -q '^NC_AGENT_CONTROL_SOCKET=' /etc/goit-node-control-agent/agent.env \
  || printf 'NC_AGENT_CONTROL_SOCKET=/run/goit-node-control-pm2-broker/broker.sock\n' >> /etc/goit-node-control-agent/agent.env
systemctl restart node-control-agent
journalctl -u node-control-agent -n 5 -o cat                             # "control poll", broker ok

# --- Крок 3. API (центральний сервер): увімкнути керування глобально (backup api.env, restart лише API).
#   PM2_CONTROL_ENABLED=true  у /etc/goit-node-control/api.env  (600 nodecontrol)
```

Перевірка: UI → сервер → «Сервіси сервера» (або «Застосунки», ADR-024) → колонка «Дії»: дозволені процеси мають активне меню; operator/admin виконує дію з підтвердженням; статус «Виконано й підтверджено»; audit `process.command_*`.

**Rollback / аварійне вимкнення** (у будь-якому порядку, PM2-процеси не зупиняються): `PM2_CONTROL_ENABLED=false` + restart API (нові команди → 409, черга не видається й експірує); прибрати `NC_AGENT_CONTROL_SOCKET` з `agent.env` + restart Agent; `systemctl disable --now node-control-pm2-broker@<owner>`; спорожнити allowlist. Журнал broker (`/var/lib/goit-node-control-pm2-broker`) не видаляти: він захищає від повторного виконання. Таблиці керування лишаються (additive).

### Автозапуск PM2 після reboot (окремо від Agent)

PM2 і його застосунки належать власнику PM2 на керованій ноді; Node Control їх не запускає. Agent, exporter і broker — окремі systemd-служби й **не** відповідають за автозапуск PM2: після reboot вони працюють, але exporter звітує «daemon unavailable», доки PM2 не запущено. Автозапуск PM2 налаштовується окремо, штатною службою PM2 від імені власника.

Параметри визначає оператор, не вгадуючи (приклади умовні):

| Параметр | Як визначити | Приклад |
|---|---|---|
| Власник PM2 | `ps -eo user,cmd \| grep 'God Daemon'` (користувач, не root) | `deploy` |
| HOME / PM2_HOME | `getent passwd <owner>`; каталог у `God Daemon (<PM2_HOME>)` | `/home/deploy`, `/home/deploy/.pm2` |
| Node.js | `sudo -u <owner> -i bash -lc 'command -v node; node -v'` | `/usr/bin/node` або `~/.nvm/versions/node/v22.x/bin/node` |
| PM2 | `readlink -f "$(sudo -u <owner> -i bash -lc 'command -v pm2')"` | `/usr/lib/node_modules/pm2/bin/pm2` |

**Безпечна діагностика після reboot** (нічого не запускає): `uptime -s`; `ps -eo pid,user,lstart,cmd | grep 'God Daemon'`; `systemctl list-unit-files 'pm2*'`, `systemctl status pm2-<owner>`, `journalctl -b -u pm2-<owner>`; інші механізми (`crontab -l` власника й root на `@reboot`, `/etc/init.d`, `/etc/rc.local`, `loginctl show-user <owner> -p Linger` для user-служб); `<PM2_HOME>/pm2.log` — час старту daemon і застосунків; час збереження `<PM2_HOME>/dump.pm2`. **Будь-яка команда `pm2` без запущеного daemon створює новий daemon** — спершу переконатися, що daemon власника працює (`rpc.sock` існує), і лише тоді `pm2 jlist`/`save`. Виводити лише назви, ID, статуси, PID, час старту й лічильники; `jlist`, `env` і `dump.pm2` містять env застосунків — не друкувати.

**Налаштування** (root на ноді; застосунки вже запущені й перевірені):

```bash
OWNER=deploy; OWNER_HOME=/home/deploy; PM2_HOME=$OWNER_HOME/.pm2
PM2_BIN=$(readlink -f "$(sudo -u $OWNER -i bash -lc 'command -v pm2')")
# 0. daemon власника вже працює; інакше зупинитися (pm2 створив би новий)
pgrep -u $OWNER -f "God Daemon ($PM2_HOME)" && test -S $PM2_HOME/rpc.sock
# 1. backup (dump містить env застосунків → лише root, 600)
B=/root/pm2-backups/$(date -u +%Y%m%dT%H%M%SZ); install -d -m 700 /root/pm2-backups "$B"
for f in dump.pm2 dump.pm2.bak; do [ -e $PM2_HOME/$f ] && install -m 600 $PM2_HOME/$f "$B/"; done
[ -e /etc/systemd/system/pm2-$OWNER.service ] && install -m 600 /etc/systemd/system/pm2-$OWNER.service "$B/"
# 2. зберегти поточний список через наявний daemon (процеси не чіпає)
sudo -u $OWNER env HOME=$OWNER_HOME PM2_HOME=$PM2_HOME "$PM2_BIN" save
# 3. перевірити кількість і назви записів у dump без виводу env (node -e з JSON.parse → лише name/status)
```

Служба `/etc/systemd/system/pm2-<owner>.service` — стандартний шаблон PM2 з абсолютними шляхами (те, що генерує `pm2 startup systemd -u <owner> --hp <home>`; файл можна записати вручну, щоб не запускати `pm2` від root):

```ini
[Unit]
Description=PM2 process manager (owner deploy)
After=network.target

[Service]
Type=forking
User=deploy
LimitNOFILE=infinity
# з NVM додати на початок PATH каталог node, напр. /home/deploy/.nvm/versions/node/v22.x/bin
Environment=PATH=/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/sbin:/bin
Environment=HOME=/home/deploy
Environment=PM2_HOME=/home/deploy/.pm2
PIDFile=/home/deploy/.pm2/pm2.pid
Restart=on-failure
ExecStart=/usr/lib/node_modules/pm2/bin/pm2 resurrect
ExecReload=/usr/lib/node_modules/pm2/bin/pm2 reload all
ExecStop=/usr/lib/node_modules/pm2/bin/pm2 kill

[Install]
WantedBy=multi-user.target
```

```bash
systemd-analyze verify /etc/systemd/system/pm2-$OWNER.service   # ім'я файлу має закінчуватися на .service
systemctl daemon-reload
systemctl enable pm2-$OWNER.service      # БЕЗ --now і без start, якщо daemon уже працює вручну
```

**Не робити на працюючому сервері:** `systemctl start/restart pm2-<owner>` або `enable --now`, поки daemon запущений вручну (`resurrect` в існуючий daemon може продублювати застосунки; передача керування systemd — лише в погоджене вікно, зазвичай наступним reboot); `pm2 kill`, `resurrect`, `restart/reload/start all`; `pm2` від root; друга служба для того самого власника. Не додавати запуск PM2 до Agent, exporter чи broker.

**Коли оновлювати збережений список** (`pm2 save` від власника, з backup перед цим): після додавання/видалення застосунку, зміни його конфігурації (шлях, interpreter, env, ecosystem), зміни версії Node.js. **Небезпека:** `pm2 save` у момент, коли запущені не всі застосунки (після reboot до ручного старту, під час інциденту), перезапише dump частковим або порожнім списком — після наступного reboot решта не стартує. Перед збереженням звірити `pm2 jlist` з очікуваним набором; записи `stopped`/`errored` зберігаються у списку — вирішити свідомо, чи зберігати їх.

**Після зміни Node.js або NVM:** перевірити шляхи в службі (`systemctl cat pm2-<owner>`, `systemd-analyze verify`), доступність `node` і `pm2` для власника (`sudo -u <owner> test -x <path>`), за потреби оновити `PATH`/`ExecStart` (backup → правка → `verify` → `daemon-reload`) і виконати `pm2 save`. З NVM шлях містить версію (`~/.nvm/versions/node/vX.Y.Z/bin`) і ламається після `nvm install`/видалення версії.

**Перевірка без reboot:** служба `enabled`, `systemd-analyze verify` без помилок, User/HOME/PM2_HOME/шляхи відповідають власнику, dump містить очікуваний набір. Фактичний старт підтверджує лише reboot-тест у погоджене вікно: після нього — `systemctl status pm2-<owner>`, `journalctl -b -u pm2-<owner>`, `pm2 jlist` (лише безпечні поля), стан inventory у UI.

**Rollback** (без зупинки застосунків): `systemctl disable pm2-<owner>` (працюючий daemon не зачіпається); повернути службу з backup або видалити файл + `daemon-reload`; повернути dump з backup (`install -m 664 -o <owner> -g <owner> <backup>/dump.pm2 <PM2_HOME>/dump.pm2`) — діє лише на наступний `resurrect`. Backup не видаляти.

### Перегляд логів (Task 010, ADR-018)

Міграцій немає. Порядок rollout: **API/UI → реліз Agent (Agent і broker — один артефакт) → restart Agent і broker → (лише з погодження) `logs: true` у allowlist.** До останнього кроку читання логів вимкнене: UI показує «Логи не дозволені». Старий Agent/broker → «Перегляд логів не підтримується».

```bash
# Увімкнути логи для погодженого сервісу (root на керованій ноді). Backup → правка → перевірка; broker перечитує allowlist сам.
A=/etc/goit-node-control-pm2-broker/<owner>.allowlist.json
cp -p "$A" "$A.bak-$(date -u +%Y%m%dT%H%M%SZ)"
python3 - "$A" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
allowed = {"<targetKey>"}                      # погоджені сервіси
for t in d["targets"]:
    if t["id"] in allowed: t["logs"] = True
json.dump(d, open(p + ".new", "w"), indent=1)
PY
install -m 644 -o root -g root "$A.new" "$A" && rm "$A.new"
# Каталоги логів: типово <PM2_HOME>/logs. Інший каталог — лише явно: NC_BROKER_LOG_DIRS=... у /etc/goit-node-control-pm2-broker/<owner>.env + restart broker.
```

Перевірка: UI → сервер → «Сервіси сервера» → «Дії» → «Переглянути логи» (operator/admin). Rollback логів: повернути allowlist із backup (діє без restart). **Rollback broker на реліз до Task 010:** спершу повернути allowlist без поля `logs` (старий broker вважає його невалідним і відхилятиме всі дії), потім `server-release.js rollback --base /opt/goit-node-control-agent` і restart broker та Agent.

### Користувачі та паролі (Task 011, ADR-019)

Міграція `1791900000005_user-credential-version`: лише additive (колонка `credential_version` з default 1 та індекс). Порядок — штатний для API: backup лише `node_control_db` → `pg_restore --list` → `migrate.js status` → `up` → `status` (pending=0) → activate → restart лише `node-control-api`. Agent/broker не змінюються. Production-користувачів і паролі деплой не змінює; перевірка мутацій — лише в тестовому середовищі.

Rollback: `server-release.js rollback` на попередній реліз + restart API. Колонка лишається (старий реліз її не читає й створює сесії без перевірки версії). Паролі, змінені новим релізом, не повертаються; відкликані сесії не відновлюються.

### Сповіщення (Task 013, ADR-021)

Міграція `1791900000006_alerts` (additive: 3 таблиці). Деплой — штатний API-деплой з backup і `up` до активації. **За замовчуванням вимкнено** (`ALERTS_ENABLED=false`, `ALERTS_DELIVERY_ENABLED=false`): нічого не оцінюється й не надсилається.

**З Task 013.1 (ADR-022) рушій, доставка, правила й webhook налаштовує admin в UI («Налаштування»).** В `api.env` — лише deployment-рівень:

```bash
# Один раз: ключ шифрування webhook (root на центральному сервері). Значення не виводиться і не потрапляє в історію shell.
E=/etc/goit-node-control/api.env
cp -p "$E" "$E.bak-$(date -u +%Y%m%dT%H%M%SZ)"
umask 077; K=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")
printf 'ALERTS_SECRET_KEY=%s\nALERTS_SECRET_KEY_VERSION=1\nALERTS_PUBLIC_URL=https://control.example.com\n' "$K" >> "$E"; unset K
chmod 600 "$E"; chown nodecontrol:nodecontrol "$E"
systemctl restart node-control-api
journalctl -u node-control-api --since "-1 min" -o cat | grep -o '"alertsSecretKey":[a-z]*,"alertsPublicUrl":[a-z]*'
```

Далі admin: «Налаштування» → «Інтеграції» → вставити webhook приватного каналу → «Зберегти webhook» → «Надіслати тестове повідомлення» → за успіху увімкнути «Автоматична доставка»; «Правила сповіщень» → увімкнути рушій і за потреби змінити пороги. Restart не потрібен.

**Ключ і backup.** Ключ (`ALERTS_SECRET_KEY`) зберігати окремо від backup БД (менеджер секретів/офлайн-сховище оператора). Backup `node_control_db` без ключа **не дозволяє відновити інтеграцію** — після відновлення без ключа стан «Помилка: ключ…», webhook потрібно ввести заново. Зміна ключа: новий ключ + `ALERTS_SECRET_KEY_VERSION`+1 + restart → інтеграція в стані помилки → повторно зберегти webhook.

Вимкнення: «Налаштування» → вимкнути доставку (черга скасовується) і/або рушій. Rollback коду на реліз до 013.1 (`e8f61c5`): він читає лише `ALERTS_*` з env, яких у production немає, тож рушій і доставка там вимкнені, старий webhook не з'являється; нові таблиці лишаються. Перед rollback вимкнути доставку в UI.

### Спрощення серверного моніторингу (ADR-023)

Міграція `1791900000008_retire-server-memory` (forward: розширює CHECK `alert_incidents.resolution` значенням `retired`, закриває відкриті `server_memory`-інциденти як `retired`, скасовує їхні повідомлення в черзі, видаляє стан умов цього правила). Колонки не видаляються.

Порядок:
1. API/frontend — штатно: backup `node_control_db` → `migrate.js status` → `up` → `status` (pending=0) → activate → restart лише `node-control-api`.
2. Перевірити, що **старий Agent 0.4.x** і далі приймається: heartbeat `accepted` у журналі Agent, сервер «Онлайн» в UI, load average видно на сторінці сервера.
3. Новий Agent 0.5.0 (артефакт `node-control-agent-<sha>`): `prepare --no-install` → `activate` → restart лише `node-control-agent`. Broker і exporter не змінюються й не перезапускаються (unit-файли ті самі; їхній код у новому релізі той самий).
4. Перевірки: heartbeat/inventory/control/log polling у журналі Agent, `agentVersion` 0.5.0 в «Системних подробицях», PM2 PID/час старту/restarts без змін.

**Rollback після ADR-023 — лише на compatibility-реліз** (уточнено 2026-10-15 за review Codex; попередня процедура «старий Agent → старий API `c016beb`» була неповною).

Первісний реліз `c016beb` **не є безпечною ціллю**: у БД уже лежать мінімальні snapshot (їх пише ADR-023 API для будь-якої версії Agent), а офлайн/деактивовані ноди не надішлють нового heartbeat. На таких даних `c016beb` повертає 500 на сторінці сервера (serializer вимагає `uptimeSeconds`), 503 на Dashboard, падає в кожному циклі оцінювання сповіщень (`TypeError … totalBytes` — рушій фактично не працює), відхиляє heartbeat Agent 0.5.0 (400), а його UI не розбирає мінімальний snapshot і інциденти `retired`.

Ціль — **compatibility-реліз** гілки `release/monitoring-rollback-compat`, revision `70ddd1f40b205306f0d61eb278cca9646c7e7d87` (код `c016beb` + вузькі виправлення; уточнено 2026-10-15 за другим review Codex P2):
- приймає heartbeat Agent 0.4.x (повний) і 0.5.0 (мінімальний), невідомі поля → 400;
- читає мінімальні й повні snapshot: пам'ять/uptime/кількість ядер відсутні → `null` («—», «обсяг невідомий»), не нулі;
- не оцінює виведене правило `server_memory`; решта правил (offline, inventory, process_*) працює;
- **не доставляє повідомлення виведеного правила**: `claim` спершу скасовує `queued` і `sending` з протермінованим lease для `server_memory` (`cancelled`, `last_error = rule_retired`), а сам SQL вибірки виключає retired-правила — навіть елемент, що став доступним після cleanup (retry), не буде надіслано; живий lease не перехоплюється, після повернення на retry скасовується наступним `claim`. Працює й з вимкненим рушієм. Історія, надіслані повідомлення й audit не змінюються; recovery для `server_memory` не створюється;
- UI розбирає мінімальні snapshot та історію з `retired`; неактивні пороги пам'яті ОС приховано (значення зберігаються без змін);
- містить уже застосовану міграцію `1791900000008` (той самий файл) — `migrate status` чистий, міграцій для застосування немає.

**Не використовувати попередню compat-ревізію `1a6b82c251539aa9348b1fee6b997a0f3a254434`**: у ній `claim` ще видавав елементи outbox правила `server_memory` (наприклад `sending` з протермінованим lease після перерваної доставки) — відомий дефект доставки retired-правила.

Перевірений артефакт `70ddd1f` зібрано штатним `build-release.js` і збережено поза репозиторієм в оператора (каталог `rollback-artifacts/70ddd1f`): `node-control-api-70ddd1f40b205306f0d61eb278cca9646c7e7d87.tar.gz` SHA-256 `fba970acc6b869652e816fe42e120c3199a4765eb5ff9df79ccfd42f073be11e`, `.sha256` і `server-bundle` поруч. Його можна передати замість нової збірки; нова збірка з тієї ж ревізії дає інший SHA-256 tar.gz (час файлів), але ті самі хеші файлів у `RELEASE.json`.

Процедура (API/frontend; Agent і broker/exporter не чіпати — compat приймає обидві версії Agent):

```bash
# локально, чистий checkout; походження перевіряє build-release (ревізія має бути в запушеній гілці)
git fetch origin && git worktree add ../nc-rollback 70ddd1f40b205306f0d61eb278cca9646c7e7d87 && cd ../nc-rollback && npm ci
npx -y node@22 scripts/deploy/build-release.js --revision 70ddd1f40b205306f0d61eb278cca9646c7e7d87   --remote-branch origin/release/monitoring-rollback-compat --out <out>
# передати артефакт + .sha256 + server-bundle як для звичайного деплою; на сервері (root):
sha256sum -c node-control-api-<sha>.tar.gz.sha256
node server-bundle/server-release.js prepare --artifact … --sha256 … --revision 70ddd1f40b205306f0d61eb278cca9646c7e7d87
# RELEASE.json: revision = 70ddd1f…, 63 файли; migrate.js status з нового релізу: applied=9 pending=0 unknown=0
node server-bundle/server-release.js activate --revision 70ddd1f40b205306f0d61eb278cca9646c7e7d87
systemctl restart node-control-api
```

Перевірки після: live/ready 200, сторінки сервера (онлайн/офлайн) і Dashboard без 500/503, `GET /api/alerts?state=resolved` 200, у журналі API немає `Alerts evaluation failed`, heartbeat обох версій Agent приймається.

Повернення на поточний робочий реліз: `server-release.js activate --revision <поточний ADR-023 реліз>` (він лишається підготовленим) + restart API — без міграцій. Записи, які compat зробить за час відкату (повні snapshot від Agent 0.4.x), ADR-023 API читає через `normalizeSnapshot`.

Обмеження: tar.gz не відтворюється побайтово (час файлів) — ідентичність задає revision + `RELEASE.json` (хеші файлів однакові між збірками, перевірено); compat-реліз не показує пороги пам'яті ОС, але й не дає їх змінити через UI; Agent 0.4.x за compat знову надсилає (і compat зберігає) повні snapshot. Схема не відкочується; backup БД поверх нових даних не відновлюється.

### Міграції: backup, recovery, rollback

- Перед кожним production `up` — `pg_dump -Fc` лише `node_control_db` у `/root/node-control-backups/` (каталог `700`, файл `600`), перевірка `pg_restore --list`. Не дамп усього кластера.
- Міграції лише additive і сумісні з попереднім релізом (health-only API не читає `users`/`sessions`/`audit_log`). Rollback коду (`server-release.js rollback`) **не** відкочує схему й не видаляє users/sessions/audit; additive-об'єкти лишаються. Після rollback auth-ключі в `api.env` ігноруються старим релізом (за потреби — відновити `api.env.bak-<ts>`).
- Автоматичного `down`/drop у production немає. Відновлення з backup — окрема контрольована операція за доведеної потреби: спершу відновити в нову БД для перевірки (`createdb -O node_control_user node_control_db_restore_<ts>` + `pg_restore --no-owner --role=node_control_user -d node_control_db_restore_<ts> <dump>`), порівняти, і лише за рішенням оператора переключати/переносити дані — не знищуючи нових даних.

### Rollback

- **Є попередній реліз:** `node /opt/goit-node-control/current/scripts/deploy/server-release.js rollback` (атомарно міняє `current`↔`previous`) → за потреби відновити unit із попереднього релізу + `systemctl daemon-reload` → `systemctl restart node-control-api` → повторити перевірки. Конфіг не змінюється між релізами.
- **Перший деплой:** `systemctl disable --now node-control-api`. Реліз, конфіг, користувач і unit-файл лишаються для діагностики; БД, ролі та сторонні файли не чіпаються.
- Старі релізи в цій процедурі не видаляються.

### Доступ із VS Code / локальної машини

Backend слухає лише loopback; публічно доступний лише через Nginx (`https://control.example.com`). Прямий доступ для розробника — SSH port forwarding:

```bash
ssh -N -L 3100:127.0.0.1:3100 root@203.0.113.10
curl -s http://127.0.0.1:3100/health/ready
```


## Rollback

За неуспішних перевірок застосувати підготовлений rollback лише якщо він безпечний для даних. Відновити погоджений артефакт/конфігурацію, перевірити конфігурацію й повторити health/smoke/status checks. Не видаляти БД, ролі або дані автоматично. Якщо rollback загрожує даним, зупинити залежні зміни, зафіксувати проблему та отримати рішення користувача.

Для документаційних змін rollback — окремий revert commit за потреби, без переписування історії. Готової автоматизації rollback для майбутніх API/Agent/UI поки немає.
