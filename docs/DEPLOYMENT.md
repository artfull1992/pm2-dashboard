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
# на керованій ноді (root). Agent уже оновлено до релізу з inventory (див. «Agent» вище).
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
