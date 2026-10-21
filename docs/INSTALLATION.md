# Встановлення Node Control (self-hosted)

Єдине джерело інструкцій для первинного встановлення Central API, підключення серверів (Agent), діагностики та відновлення після часткової невдачі. Найкоротший шлях — майстер `install.sh` (наступний розділ після «Підтримка й обмеження»); розділи 1–3 — ручний маршрут. Процедура оновлення наявних інсталяцій і історія деплоїв — [DEPLOYMENT](DEPLOYMENT.md); архітектура — [ARCHITECTURE](ARCHITECTURE.md).

> **Стан перевірки (2026-10-20).** Маршрут цього документа пройдено наскрізно на одноразових ізольованих VM: **Ubuntu 26.04.1 LTS (arm64)**, systemd 259, Node.js 22.22.1 і npm 9.2 з пакетів Ubuntu, PostgreSQL 18.6, Nginx 1.28.3; тестовий PM2 7.0.4 на окремій VM Agent. Перевірено первинне встановлення й повтори (API і Agent — під umask 022 і 077), Nginx/HTTPS-вхід, Agent з inventory і broker, часткові збої та відновлення, справжній systemd/journal, негативні сценарії й reboot (ці — під umask 022; матриця — розділ 8 і PROJECT_STATUS). Інші версії Ubuntu й архітектура x86_64 не перевірялись. Не запускайте інсталятори на серверах, де Node Control уже встановлено вручну: для них — [DEPLOYMENT](DEPLOYMENT.md).

## Що встановлюється

| Компонент | Де | Як працює |
|---|---|---|
| Central API + UI | центральний сервер | systemd `node-control-api` від `nodecontrol`, лише `127.0.0.1:3100`; UI — статичні файли того самого релізу |
| PostgreSQL | центральний сервер (host) | окремі БД і роль Node Control; не відкривається в мережу |
| Nginx + TLS | центральний сервер (host) | HTTPS-сайт: статика UI і `/api/` → `127.0.0.1:3100` |
| Agent | кожен керований сервер | systemd `node-control-agent` від `nodecontrol-agent`; лише вихідний HTTPS до API, вхідних портів немає |
| PM2 exporter (опційно) | керований сервер | таймер раз на 30 с від власника PM2: лише читає список процесів наявного PM2 daemon |
| PM2 broker (опційно) | керований сервер | start/stop/restart і читання логів **лише** для процесів з allowlist, яку заповнює оператор |

PM2, його застосунки, `PM2_HOME` і автозапуск PM2 інсталятори не змінюють і не перезапускають; жодна команда `pm2` не виконується (навіть `pm2 --version` може запустити daemon).

## Підтримка й обмеження

- Ubuntu із systemd; запуск від root. Інші дистрибутиви інсталятор відхиляє. Перевірено: Ubuntu 26.04.1 LTS (arm64).
- Node.js 22 саме в `/usr/bin/node` (його використовують units) і `npm` (потрібен для залежностей API). В Ubuntu 26.04 обидва — з пакетів дистрибутива: `apt install nodejs npm` (там Node.js 22; npm — окремий пакет). Інсталятор Node.js не встановлює й не оновлює.
- На центральному сервері — `apt install postgresql nginx` (PostgreSQL слухає лише `127.0.0.1`; стандартний `pg_hba.conf` Ubuntu вже дозволяє вхід за паролем із loopback).
- Docker не використовується. PostgreSQL і Nginx — host-служби, якими керує оператор.
- Шляхи, користувачі й назви units фіксовані (deployment contract, [DEPLOYMENT](DEPLOYMENT.md)): один Central API на сервер, на керованому сервері — один власник PM2 для inventory/керування.
- Транзакційності системної інсталяції немає: кроки виконуються по черзі, за невдачі — зупинка з поясненням, повторний запуск продовжує.
- Довідка: `node server-bundle/install/server.js --help`, `node server-bundle/install/agent.js --help`. Коди виходу: 0 — виконано (або план без перешкод), 1 — зупинка (перевірка, конфлікт, невдалий крок чи перевірка результату), 2 — неправильні аргументи.

## Швидкий маршрут: майстер `install.sh`

Майстер веде через первинне встановлення **Central Server** або **Agent**. Він лише збирає відповіді, показує їх (без секретів), виконує план (`plan` нічого не змінює) і після вашого «так» — встановлення (`apply`) тими самими інсталяторами, що описані в розділах 2–3. Усі перевірки, кроки, стан незавершених дій і відновлення — ті самі. Розділи 1–3 нижче — ручний або advanced маршрут і довідка про кожен крок.

**Чотири різні речі, які не варто плутати:**

| Що | Де | Хто |
|---|---|---|
| checkout репозиторію | будь-який каталог: `/root/node-control`, `/home/<користувач>/src/node-control`, шлях із пробілами | звичайний користувач (збирання) |
| підготовлений реліз | типово поруч із checkout: `../node-control-releases/<ревізія>/` (артефакти, `.sha256`, `server-bundle/`) або будь-який захищений каталог (`--release`) | той, хто збирав; запускає root |
| встановлена система | фіксовані `/opt/node-control*`, `/etc/node-control*`, `/var/lib/node-control*` — не checkout | root |
| PM2 на сервері Agent | власник PM2 (Linux-користувач, не root) і його `PM2_HOME` — окремо від того, хто запускає майстер; `./` до цього стосунку не має | майстер пропонує, ви підтверджуєте |

**1. Клонувати й підготувати реліз** — звичайним користувачем (не root), Node.js 22 і npm, чистий checkout, commit уже в `origin/main`:

```bash
git clone <URL репозиторію> node-control
cd node-control
npm ci
node scripts/deploy/build-release.js --out "$(dirname "$PWD")/node-control-releases/$(git rev-parse --short HEAD)"
```

Майстер ніколи не запускає `npm` чи збирання від root і не встановлює систему прямо з checkout — лише з цього versioned-релізу.

**2. Запустити майстер:**

```bash
sudo ./install.sh                                  # від звичайного користувача з sudo
./install.sh                                       # якщо ви вже root (sudo -i)
sudo ./install.sh --release /шлях/до/релізу        # реліз в іншому місці або кілька релізів
./install.sh --help                                # довідка: без root, нічого не змінює
```

Якщо в `../node-control-releases/` кілька релізів, launcher не обирає «найновіший» сам — показує готові команди з `--release`. Запуск через symlink на `install.sh` веде до справжнього checkout (і його `../node-control-releases/`).

**3. Відповісти на питання:**
- *Central Server:* файл із `DB_*` (БД готується заздалегідь — розділ 2.1; якщо `api.env` уже є — не питається), публічна HTTPS-адреса, email першого адміністратора (пароль — прихований ввід самого bootstrap під час встановлення), довіра до proxy (лише коли Nginx уже налаштовано за шаблоном `nginx-config`), керування PM2 на рівні API — обидва за замовчуванням «ні». Nginx/TLS — розділ 2.3.
- *Agent:* адреса Node Control і ключ із UI (прихований ввід; якщо `agent.env` уже є — ні адреса, ні ключ не питаються й не змінюються), можливості: лише heartbeat, + inventory, + broker з порожньою allowlist (розділ 3.3).
- *Власник PM2:* майстер шукає працюючі PM2 daemon лише за назвою процесу (`God Daemon (<PM2_HOME>)`) і реальним UID — без `pm2`-команд і без читання середовища процесів. Знайдені показуються списком, ви обираєте явно; daemon від root показується, але не підтримується (процеси не переносяться). Якщо daemon немає або потрібен інший — вручну: користувач (користувач, що запустив `sudo`, — лише підказка), домашній каталог береться з облікового запису, `<home>/.pm2` пропонується як типове місце, а не факт; можна ввести будь-який абсолютний `PM2_HOME`.

**4. План і підтвердження:** майстер показує параметри, виконує план; за блокувальних проблем зупиняється. Встановлення починається лише після введення слова «так». `Ctrl+C`, `Ctrl+D` (зокрема під час прихованого вводу ключа — він не стає частиною ключа), кінець вводу (EOF) або «0» у меню до початку встановлення — скасування без змін. Якщо встановлення вже почалося й перервалось, майстер не каже «нічого не змінено»: частину змін могло бути застосовано, повторний запуск продовжить (розділ 4).

**5. Повтор і помилки:** якщо встановлення зупинилось, усуньте причину й запустіть майстер ще раз із тими самими відповідями — виконані кроки пропускаються, незавершені `daemon-reload`/restart доводяться (розділ 4).

**Безпека релізу.** Майстер запускається від root із каталогу релізу, тому `install.sh` ще ДО запуску будь-якого коду релізу перевіряє, що ні реліз, ні жоден каталог на шляху до нього не можуть змінити чи підмінити недовірені користувачі:
- **довірені власники** — root, користувач, від якого запущено `install.sh`, і (під `sudo`) користувач, що викликав `sudo`: він готував реліз і так може виконати що завгодно від root, тож від нього захисту немає й не обіцяється;
- у релізі — жодних symlink, файлів чи каталогів із записом для групи/інших, лише довірені власники;
- **кожен каталог-предок аж до `/`** належить довіреному власнику (власник каталогу міг би перейменувати вкладене дерево й підставити інше); запис для групи/інших дозволено лише для sticky-каталогу, що належить root (як `/tmp`), — будь-який інший sticky-каталог не вважається безпечним;
- наслідок: якщо root запускає майстер напряму (без `sudo`), реліз у домашньому каталозі іншого користувача відхиляється — запустіть `sudo ./install.sh` від імені цього користувача або перенесіть реліз у каталог root.

Обходу цих перевірок немає. `server-bundle/BUNDLE.json` (пише `build-release.js`) фіксує ревізію й SHA-256 кожного файлу бандла; майстер розбирає його як недовірені дані й відмовляє з поясненням (без stack trace і без змін), якщо файл не є коректним JSON-об'єктом із 40-символьною ревізією та записами «відносний шлях → SHA-256», якщо бандл змінено, змішано з іншою збіркою, запущено не з бандла цього релізу (наприклад, із застарілого `installer/dist` у checkout) або поруч лежать артефакти іншої ревізії. Ця перевірка виконується вже кодом самого релізу, тому захистом від підміни є лише перевірки `install.sh` вище; SHA-256 доводить цілісність щодо `BUNDLE.json`, а не автентичність того, хто зібрав реліз.

**Без checkout на сервері** (root-only адміністратор, сервер Agent): збирайте реліз на іншій машині (крок 1), передайте каталог релізу цілком у захищений каталог сервера (`install -d -m 700 /root/node-control-install`, власник root) і запустіть майстер прямо з бандла:

```bash
node /root/node-control-install/<ревізія>/server-bundle/install/wizard.js --release /root/node-control-install/<ревізія>
```

Без термінала (автоматизація) майстер відмовляє; використовуйте неінтерактивні `server.js`/`agent.js plan|apply` (розділи 2–3).

## 1. Отримати артефакти (ручний маршрут)

На машині збирання (Node.js 22, checkout репозиторію, commit уже запушений):

```bash
npm ci
npx -y node@22 scripts/deploy/build-release.js        # друкує revision, шляхи й SHA-256
```

У каталозі виводу: `node-control-api-<sha>.tar.gz` (+ `.sha256`), `node-control-agent-<sha>.tar.gz` (+ `.sha256`) і `server-bundle/` (інструменти релізів і `install/` — інсталятори). Передайте на сервер у новий каталог, доступний лише root:

```bash
ssh root@<сервер> 'install -d -m 700 /root/node-control-install'
scp node-control-api-<sha>.tar.gz{,.sha256} root@<сервер>:/root/node-control-install/      # для керованого сервера — agent
scp -r server-bundle root@<сервер>:/root/node-control-install/
```

Нічого не завантажуйте й не виконуйте з інших джерел (жодного `curl | bash`). Інсталятор сам перевіряє SHA-256 артефакту й manifest кожного файлу.

## 2. Central API

### 2.1 База даних

Потрібні PostgreSQL на цьому ж сервері, окрема БД і роль Node Control. Інсталятор їх **не створює** і сторонні БД, ролі, `pg_hba.conf` чи мережеві правила не змінює.

**Варіант А (рекомендований) — підготувати вручну.** Пароль — лише літери, цифри, `_ . : -` (так він записується в `api.env` без лапок); вводиться приховано, у psql передається вже як SCRAM-хеш:

```bash
runuser -u postgres -- psql -X <<'SQL'
CREATE ROLE node_control_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE node_control_db OWNER node_control_user;
REVOKE CONNECT, TEMPORARY ON DATABASE node_control_db FROM PUBLIC;
SQL
runuser -u postgres -- psql -X -c '\password node_control_user'     # пароль двічі, не відображається
```

Стандартний `pg_hba.conf` Ubuntu вже дозволяє `host … 127.0.0.1/32 scram-sha-256`; якщо ні — додайте лише loopback-правило для цієї БД і ролі (не `0.0.0.0/0`).

Файл credentials для інсталятора (root, 600; той самий пароль, приховане введення):

```bash
umask 077; read -rs DB_PASS        # ввести пароль, Enter
printf 'DB_NAME=node_control_db\nDB_USER=node_control_user\nDB_HOST=127.0.0.1\nDB_PORT=5432\nDB_PASS=%s\n' "$DB_PASS" > /root/node-control-install/db.env
unset DB_PASS
```

**Варіант Б — `scripts/setup-postgres.js`** (з checkout репозиторію на цьому сервері; лише явно): створює роль із випадковим паролем, БД, ACL і пише `.env` у корінь checkout. Без `--skip-hba` він додає правило `hostssl node_control_db node_control_user 0.0.0.0/0 scram-sha-256` — для локальної БД запускайте з `--skip-hba`. Отриманий `.env` (600) можна передати інсталятору як `--db-env`. Деталі — README, «PostgreSQL».

Файл `db.env` потрібен лише для першого створення `/etc/node-control/api.env`; після встановлення його можна видалити (`shred -u`).

### 2.2 Встановлення

```bash
cd /root/node-control-install
A=node-control-api-<sha>.tar.gz
node server-bundle/install/server.js plan  --artifact $A --db-env db.env --public-url https://control.example.com
node server-bundle/install/server.js apply --artifact $A --db-env db.env --public-url https://control.example.com \
     --admin-email admin@example.com          # пароль адміністратора запитується приховано двічі
```

`plan` нічого не змінює: виконує перевірки й показує кожен крок як «вже виконано», «буде виконано» або «конфлікт». `apply` виконує ті самі перевірки, потім кроки по черзі й наприкінці перевіряє результат. Без термінала пароль адміністратора — `--admin-password-file <файл>` (root, 600).

Перевірки до будь-яких змін: root, Ubuntu, systemd, `/usr/bin/node` v22, системні утиліти, SHA-256 артефакту, `server-release.js` поруч, вільний порт 3100, відсутність чужих файлів у `/opt/node-control`, відсутність іншого активного релізу, права й ключі `db.env`, TCP-доступ до PostgreSQL, формат `--public-url`.

| Крок | Що змінюється | Як перевірити | Якщо не вдалося |
|---|---|---|---|
| Користувач | `useradd --system --user-group --shell /usr/sbin/nologin nodecontrol` | `id nodecontrol` | наявний `nodecontrol` приймається лише як системний (UID 1–999, не UID 0, основна група не root, shell `nologin`/`false`); інакше — зупинка до змін, обліковий запис не змінюється |
| Реліз | `server-release.js prepare`: SHA-256 → manifest → `npm ci --omit=dev` → `/opt/node-control/releases/<sha>`; права незалежні від umask оператора: каталоги 755, файли 644 (виконувані — 755), власник `root:root` для всіх файлів, зокрема залежностей `npm ci`, запис лише root | `stat -c '%U %a' /opt/node-control /opt/node-control/releases /opt/node-control/releases/<sha>` | prepare не залишає частково розпакованого релізу; повторіть |
| Конфігурація | `server-release.js config`: `/etc/node-control/api.env` (600 `nodecontrol`, каталог 750 `root:nodecontrol`) з `DB_*` — лише якщо файлу немає | `stat -c '%U %a' /etc/node-control/api.env` | наявний файл не перезаписується; помилки в ньому — конфлікт із назвами ключів |
| Параметри | лише **відсутні** ключі: `AUTH_COOKIE_SECURE=true`, `AUTH_ALLOWED_ORIGINS`, `ALERTS_PUBLIC_URL`, згенерований `ALERTS_SECRET_KEY` + `_VERSION=1`; з `--behind-nginx` — `API_TRUSTED_PROXIES=127.0.0.1`; з `--enable-pm2-control` — `PM2_CONTROL_ENABLED=true`. Перед зміною — `api.env.bak-<час>` (600) | `grep -c '' api.env`; значення не друкувати | попередній вміст — у `.bak`; повторіть |
| Схема БД | `migrate.js status`; порожня БД → `migrate.js up` (одна транзакція) | `status`: pending=0 | невдалий `up` відкочується повністю; БД із наявною схемою — це оновлення, інсталятор її не мігрує |
| Unit | `systemd-analyze verify` файлу з релізу → `/etc/systemd/system/node-control-api.service` (644 root) → `daemon-reload` | `systemctl cat node-control-api` | наявний unit, що відрізняється від unit в артефакті, зупиняє інсталятор ще в перевірках (до будь-яких змін); інсталятор його не перезаписує (`diff`). Незавершений `daemon-reload` повторюється наступним запуском |
| Активація | `server-release.js activate`: `/opt/node-control/current` → реліз | `server-release.js status` | інший активний реліз — зупинка (це оновлення) |
| Служба | `systemctl enable` + `start` (`restart`, якщо цього запуску змінено конфігурацію чи unit) | `systemctl is-active node-control-api` | причина в `journalctl -u node-control-api -n 50 -o cat` |
| Адміністратор (`--admin-email`) | `bootstrap-admin.js` від `nodecontrol` | вхід в UI | наявний адміністратор не змінюється (повідомлення «вже існує») |

Результат звітується окремо: «служба запущена» → `/health/live` 200 (процес відповідає) → `/health/ready` 200 (БД доступна) = «health пройдено». Код виходу 0 лише тоді, коли пройдено все.

### 2.3 Nginx і TLS

Сертифікат отримує оператор (наприклад, certbot для свого домену) — інсталятор цього не робить. Конфіг сайту генерується, але не застосовується:

```bash
node server-bundle/install/server.js nginx-config --server-name control.example.com \
     --certificate /etc/letsencrypt/live/control.example.com/fullchain.pem \
     --certificate-key /etc/letsencrypt/live/control.example.com/privkey.pem > /root/node-control-install/site.conf
nginx -t                                                    # baseline: чинна конфігурація валідна
install -m 644 /root/node-control-install/site.conf /etc/nginx/sites-available/control.example.com.conf
ln -s /etc/nginx/sites-available/control.example.com.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
node server-bundle/install/server.js apply --artifact $A --behind-nginx    # додає API_TRUSTED_PROXIES=127.0.0.1, restart API
```

Не перезаписуйте файли інших сайтів; якщо файл із такою назвою вже є — спершу з'ясуйте, чий він. Статика `/opt/node-control/current/frontend/dist` належить `root:root` і доступна всім на читання — користувач Nginx лише читає. HTTPS обов'язковий: cookie сесії має `Secure` і префікс `__Host-`, а вхід дозволений лише з `AUTH_ALLOWED_ORIGINS` (= `--public-url`). `--behind-nginx` вмикайте лише після того, як Nginx проксіює за цим шаблоном (він замінює клієнтський `X-Forwarded-For`).

Перевірки: `curl -sI https://control.example.com/` → 200; `curl -s -o /dev/null -w '%{http_code}\n' https://control.example.com/api/auth/me` → 401; вхід в UI адміністратором.

## 3. Підключення сервера з PM2 (Agent)

### 3.1 Ключ і параметри

1. UI → «Сервери» → «Додати сервер» → сторінка сервера → «Видати ключ». Ключ показується один раз.
2. На керованому сервері збережіть його у файл без виводу на екран (або вставте пізніше в прихований запит інсталятора):

   ```bash
   umask 077; read -rs NC_KEY; printf '%s\n' "$NC_KEY" > /root/node-control-install/agent.key; unset NC_KEY
   ```

3. Для inventory/керування визначте власника PM2 і `PM2_HOME` **без** команд `pm2`: `ps -eo user,cmd | grep 'God Daemon'` → користувач і каталог у дужках (зазвичай `/home/<user>/.pm2`). PM2 від root не підтримується.

### 3.2 Встановлення

```bash
cd /root/node-control-install
A=node-control-agent-<sha>.tar.gz
# лише heartbeat (сервер «онлайн», load average)
node server-bundle/install/agent.js plan  --artifact $A --api-url https://control.example.com --token-file agent.key
node server-bundle/install/agent.js apply --artifact $A --api-url https://control.example.com --token-file agent.key
# + список PM2-процесів (inventory)
node server-bundle/install/agent.js apply --artifact $A --api-url https://control.example.com --token-file agent.key \
     --pm2-owner deploy --pm2-home /home/deploy/.pm2
# + broker для керування й логів (allowlist створюється ПОРОЖНІМ)
node server-bundle/install/agent.js apply --artifact $A --api-url https://control.example.com --token-file agent.key \
     --pm2-owner deploy --pm2-home /home/deploy/.pm2 --enable-control
```

Ключ можна також передати через `--token-stdin` (автоматизація) або ввести в прихований запит (без `--token-file`). Можливості додаються й пізніше: повторний `apply` з новими параметрами лише доводить відсутнє. Після встановлення `agent.key` видаліть (`shred -u agent.key`).

Перевірки до змін: root, Ubuntu, systemd, Node.js 22, утиліти, SHA-256 артефакту, формат ключа й права файлу ключа (значення не друкується), HTTPS-доступ до API з перевіркою сертифіката (`GET /api/auth/me` → 401), а для PM2 — існування власника (не root), `PM2_HOME` цього власника, наявність `rpc.sock` (без нього — попередження: exporter звітуватиме «unavailable», PM2 не запускається) і те, що `nodecontrol-agent` не входить до основної групи власника PM2.

| Крок | Що змінюється | Якщо не вдалося |
|---|---|---|
| Користувач | `nodecontrol-agent` (системний, без shell) — **до** будь-яких каталогів чи файлів з його власністю | ті самі вимоги, що й для `nodecontrol` (не UID 0, не група root); інакше — зупинка до змін |
| Реліз | `/opt/node-control-agent` (755 root) → `prepare --no-install` → `activate` | як для API |
| Конфігурація | `/etc/node-control-agent` (750 `root:nodecontrol-agent`) → `agent.env` (600 `nodecontrol-agent`, атомарно): `NC_AGENT_API_URL`, `NC_AGENT_TOKEN` (+ ключі inventory/керування) — лише якщо файлу немає; інакше додаються лише відсутні ключі з `agent.env.bak-<час>` | наявний ключ ніколи не ротується |
| Unit | `node-control-agent.service` із релізу, `verify` → встановлення → `daemon-reload` — **до** `enable/start` | наявний інший unit Agent, exporter чи broker — зупинка ще в перевірках, до будь-яких змін |
| Inventory | група `nc-pm2-inventory`, членство Agent, `/var/lib/node-control-pm2` (2750 `<owner>:nc-pm2-inventory`), `/etc/node-control-pm2-exporter/<owner>.env` (644), units exporter, один пробний запуск, `enable --now` таймера | `journalctl -u node-control-pm2-exporter@<owner> -n 20 -o cat`; PM2 не змінювався |
| Керування | група `nc-pm2-control`, `/etc/node-control-pm2-broker/<owner>.env` (644), **порожня** allowlist (root, 644; наявна не змінюється), unit і служба broker, членство Agent | `journalctl -u node-control-pm2-broker@<owner> -n 20 -o cat` |
| Служба Agent | `enable` + `start` (`restart`, якщо змінено конфігурацію, unit або групи) | `journalctl -u node-control-agent -n 20 -o cat`; exit 2 — помилка конфігурації |

Результат: «служба запущена» → «зв'язок Agent підтверджено». Підтвердження дає лише **поточний запуск** Agent: інсталятор бере його `InvocationID` (`systemctl show --property=InvocationID --value node-control-agent`) і читає записи тільки цього запуску (`journalctl _SYSTEMD_INVOCATION_ID=<id> -o cat --no-pager -q`) потоково: з усього журналу запуску зберігається лише результат **останнього** рядка heartbeat (і останнього рядка inventory); сирий текст не зберігається й не виводиться.

Межі одного читання: 10 с (потім процес `journalctl` примусово завершується), 64 MiB виводу; рядки довші за 8 KiB пропускаються. Результати:

- останній результат `accepted` — успіх;
- `unauthorized`, `network` тощо — «не підтверджено» з порадою;
- жодного heartbeat — очікування до 15 повторів по 5 с;
- помилка `journalctl`, тайм-аут чи перевищення 64 MiB — явна відмова («не підтверджено», а не успіх).

Найгірший час перевірки обмежений: 15 × (≤ 10 с читання + 5 с паузи).

Що саме доводить успіх: процес поточного запуску Agent (той самий ключ і конфігурація) отримав від API підтвердження heartbeat і після цього не записав іншого результату. Agent пише рядок лише при зміні результату. Тому на незміненому працюючому Agent (повторний `apply`, без restart) підтвердження спирається на останню зміну в цьому запуску, а не на свіжий мережевий запит у момент перевірки. Записи попередніх запусків не враховуються. Якщо під час перевірки systemd перезапустив Agent, очікується звіт нового запуску. Сам `active` не є підтвердженням. `unauthorized` — ключ відхилено (не той сервер, відкликаний або сервер деактивовано); `network`/`timeout` — немає зв'язку або TLS; `unavailable` — помилка API. Для inventory додатково показується стан першого звіту.

### 3.3 Керування й логи: явна allowlist

`--enable-control` нічого не дозволяє: broker відхиляє всі дії, доки ви не додасте конкретні процеси.

```bash
OWNER=deploy; PM2_HOME=/home/deploy/.pm2; A=/etc/node-control-pm2-broker/$OWNER.allowlist.json
# fingerprint лише потрібних процесів (читає наявний daemon; виводить pm_id, name, exec_mode, fingerprint — без env)
runuser -u $OWNER -- env NC_PM2_HOME=$PM2_HOME NC_BROKER_ALLOWLIST=$A \
  /usr/bin/node /opt/node-control-agent/current/agent/dist/pm2-broker.js fingerprint
cp -p $A $A.bak-$(date -u +%Y%m%dT%H%M%SZ)
# відредагуйте $A (root, 644), наприклад:
# {"version":1,"targets":[{"id":"api-prod","name":"api","actions":["restart"],"fingerprint":"sha256:…"}]}
# "logs": true у записі — читання логів цього процесу, лише за окремим погодженням.
```

Broker перечитує allowlist сам. На центральному сервері керування вмикається один раз: `server.js apply --artifact <api-артефакт> --enable-pm2-control` (додає `PM2_CONTROL_ENABLED=true`, якщо ключа немає, і перезапускає API). Cluster-процеси та процеси з повторюваними іменами не підтримуються. Повний опис — [DEPLOYMENT](DEPLOYMENT.md), «Керування PM2» і «Перегляд логів».

## 4. Повторні запуски й часткові збої

Кожен крок спершу перевіряє стан: виконаний крок пропускається, тому `apply` можна запускати повторно скільки завгодно — він не ротує ключі, не перезаписує конфігурацію, не створює другого адміністратора й не перемикає реліз.

| Ситуація | Що робить інсталятор | Що робити |
|---|---|---|
| Чиста установка | усі кроки «буде виконано» | `plan`, потім `apply` |
| Повтор з тією самою конфігурацією | «Усі кроки вже були виконані раніше — нічого не змінено» + перевірка результату | — |
| Чужий файл, користувач, unit, каталог | конфлікт із причиною; до цього кроку виконане лишається, далі нічого | з'ясувати походження; інсталятор чуже не змінює й не видаляє |
| Пошкоджений артефакт | зупинка в перевірках, без змін | передати артефакт і `.sha256` заново |
| Невдала міграція | зупинка перед активацією; БД не змінена (одна транзакція) | виправити причину (видно у виводі) → `apply` |
| Невдалий старт служби | «не вдалося»; health не перевіряється | `journalctl -u <unit> -n 50 -o cat` → виправити → `apply` |
| API недоступний / TLS | зупинка в перевірках Agent, без змін | перевірити DNS, сертифікат, вихідний HTTPS |
| Неправильний або відкликаний ключ | установка завершена, але «зв'язок НЕ підтверджено», exit 1 | новий ключ в UI → ротація (розділ 6) |
| Перерване встановлення (збій, Ctrl+C) | наступний `apply` продовжує з першого невиконаного кроку й виконує незавершені `daemon-reload`/restart | запустити ту саму команду `apply` |
| Пошкоджений або чужий файл стану | зупинка до змін із назвою файлу | див. «Стан незавершених дій» нижче |

Після зупинки інсталятор пише, що саме було змінено в цьому запуску. Він ніколи не друкує «успішно встановлено» при невдалій перевірці.

### Стан незавершених дій

Зміна конфігурації, unit-файлу чи груп діє лише після `systemctl daemon-reload` і перезапуску служби. Щоб ця дія не загубилась після збою, Ctrl+C чи аварійного завершення між зміною й перезапуском, інсталятор веде файл стану:

- `/var/lib/node-control-install/server.json` (Central API) і `agent.json` (Agent); каталог `700 root`, файл `600 root`; вміст — лише назви дій (`restart-api`, `restart-agent`, `daemon-reload`), без значень і секретів;
- **порядок:** спершу записується намір (дія, якої вимагатиме зміна), потім змінюється ресурс, потім виконується reload/restart, і лише після його успіху дія прибирається з файлу. Збій між наміром і зміною коштує щонайбільше один зайвий restart, але ніколи не пропущений; збій після restart до очищення — ще один restart наступного запуску. Невдалий restart лишається в стані до успіху;
- повторний `apply` виконує записані дії (`daemon-reload` — на кроці unit, до запуску будь-якої служби; restart — на кроці служби); завершений незмінений повтор файл не змінює й нічого не перезапускає;
- `plan` читає файл і показує незавершені дії («буде виконано — restart»), але нічого не записує й не створює;
- файл, що не є звичайним файлом root із правами 600 (або каталог не `700 root`), symlink, пошкоджений JSON чи невідомий формат — зупинка до змін. Відновлення вручну: переглянути файл (секретів у ньому немає), виконати перелічені дії (`systemctl daemon-reload`; `systemctl restart node-control-api` або `node-control-agent`), зберегти копію файлу й видалити його, повторити `apply`.

## 5. Оновлення та rollback

Інсталятори — лише для першого встановлення: на інсталяції з іншим активним релізом вони зупиняються. Оновлення — штатна процедура [DEPLOYMENT](DEPLOYMENT.md), «Процедура» (API: `prepare` → backup `pg_dump` → `migrate status/up` → unit → `activate` → restart; Agent: `prepare --no-install` → `activate` → restart). Rollback оновлення — `server-release.js rollback` (повертає попередній реліз; схема БД не відкочується, тому попередній реліз має бути сумісним зі схемою — див. відповідні розділи DEPLOYMENT).

**Rollback коду інсталятора** — окремий revert commit. Інсталятор ревізій `668ec23`–`b0f8d1d` файлу стану не знає: **не продовжуйте ним незавершений запуск нової версії** — він не виконає записаних reload/restart. Безпечний шлях: завершити незавершені дії вручну за переліком у файлі стану (розділ 4), потім, за потреби, повторити `apply` старою версією. Файл стану лишається на диску (без секретів) і нічого не ламає.

**Відкат первинного встановлення** (нічого не видаляється автоматично):

```bash
systemctl disable --now node-control-api                 # або node-control-agent / node-control-pm2-*@<owner>
```

Далі, лише свідомо: unit-файли в `/etc/systemd/system/node-control-*` (+ `daemon-reload`), `/opt/node-control*`, `/etc/node-control*`, `/var/lib/node-control-pm2*`, `/var/lib/node-control-install`, користувачі `nodecontrol*`, групи `nc-pm2-*`. БД і роль Node Control видаляються лише окремим рішенням оператора (backup спершу). PM2 і застосунки цим не зачіпаються.

## 6. Секрети, backup і відновлення

| Секрет | Де | Права |
|---|---|---|
| `DB_PASS`, `ALERTS_SECRET_KEY` | `/etc/node-control/api.env` (+ `api.env.bak-*`) | 600 `nodecontrol` |
| Ключ Agent | `/etc/node-control-agent/agent.env` (+ `agent.env.bak-*`) | 600 `nodecontrol-agent` |
| Вхідні файли (`db.env`, `agent.key`, пароль адміністратора) | `/root/node-control-install/` | 600 root; видалити після встановлення |

Інсталятори приймають секрети лише з файлу (root, без доступу групи/інших), stdin або прихованого вводу — ніколи з аргументів командного рядка; значень не друкують і не передають у argv дочірніх процесів.

- **Backup:** `pg_dump -Fc node_control_db` (каталог 700, файл 600); `api.env` і **окремо від dump** — `ALERTS_SECRET_KEY` (без нього Slack-webhook після відновлення доведеться ввести заново); `agent.env`, allowlist broker, журнал broker `/var/lib/node-control-pm2-broker`.
- **Відновлення:** спершу в нову БД для перевірки ([DEPLOYMENT](DEPLOYMENT.md), «Міграції: backup, recovery, rollback»), потім рішення оператора; конфігурації — з backup із тими самими власником і правами.
- **Ротація ключа Agent:** UI «Видати новий ключ» → замінити `NC_AGENT_TOKEN` в `agent.env` (600, той самий власник; ключ не друкувати) → `systemctl restart node-control-agent`. Інсталятор ключі не ротує.

## 7. Діагностика

| Симптом | Безпечна перевірка (без секретів) |
|---|---|
| API не стартує | `systemctl status node-control-api`; `journalctl -u node-control-api -n 50 -o cat` (лише ключі й категорії помилок) |
| `/health/ready` 503 | `systemctl status postgresql`; `runuser -u nodecontrol -- env ENV_FILE=/etc/node-control/api.env /usr/bin/node /opt/node-control/current/backend/dist/migrate.js status` |
| Сайт не відкривається | `nginx -t`; `curl -sI https://<домен>/`; права читання `/opt/node-control/current/frontend/dist` |
| Вхід не працює | `AUTH_ALLOWED_ORIGINS` = точний `https://<домен>` (без шляху), сайт лише через HTTPS |
| Сервер «не на зв'язку» | `journalctl -u node-control-agent -n 20 -o cat` → `outcome` heartbeat |
| Немає застосунків | `journalctl -u node-control-pm2-exporter@<owner> -n 5 -o cat`; `stat -c '%U:%G %a' /var/lib/node-control-pm2/inventory.json` (`<owner>:nc-pm2-inventory 640`) |
| Дії недоступні | allowlist, `journalctl -u node-control-pm2-broker@<owner> -n 5 -o cat`, `PM2_CONTROL_ENABLED` на API |

Не друкуйте вміст `api.env`/`agent.env`, `systemctl show` чи `/proc/<pid>/environ`; не виконуйте `pm2 jlist`/`env` (містять env застосунків).

## 8. Наскрізна перевірка на чистій Ubuntu

### 8.1 Що виконано (2026-10-20)

На артефактах revision `7023523`: Ubuntu 26.04.1 LTS arm64, одноразові VM, без Docker, без production. Матриця з фактичними результатами й дефектами, знайденими під час прогону (виправлені), — у PROJECT_STATUS. Обсяг umask:

- під **обома** umask (`022` і `077`) пройдено фази встановлення API (plan, apply, повтор, Nginx/HTTPS, додавання ключів) і Agent (plan, heartbeat, повтор, inventory, broker);
- recovery-, негативні, журнальні сценарії й reboot виконано **лише під umask `022`**; під `077` ці фази не повторювались.

_Уточнення 2026-10-20 (за review Codex):_ попередня редакція цього розділу описувала частковий збій через `systemctl mask` і переривання Ctrl+C. Цих сценаріїв не виконували, а `mask` для цієї межі не підходить: masked unit — symlink, тож інсталятор зупиняється ще в перевірках, до запису конфігурації. Нижче — сценарії, які справді виконано (R1, R3), з точними кроками.

### 8.2 Як повторити (лише одноразові тестові VM)

Ін'єкції збоїв нижче — **лише для одноразових тестових VM, ніколи для production**. Кожен сценарій починати з чистого snapshot; якщо його перервано, повернути VM до snapshot (або виконати крок «відновлення» нижче), не продовжувати на «напівзламаній» VM.

1. Чиста VM: Ubuntu LTS із systemd, Node.js 22 у `/usr/bin/node`, PostgreSQL і Nginx з пакетів; синтетичний домен і самопідписаний сертифікат, довірений на тестовому «керованому» VM. Фази встановлення API й Agent — двічі, з чистого snapshot: в shell з `umask 022` і з `umask 077` (як після підготовки секретів); перевірити, що `nodecontrol`, `nodecontrol-agent`, власник PM2 і користувач Nginx читають потрібні файли релізів і конфігурацій, а секретні файли лишаються 600.
2. Central API: БД за розділом 2.1 → `server.js plan` (нічого не змінено: порівняти `getent passwd`, `ls /etc/systemd/system`, `/var/lib/node-control-install` до/після) → `apply` → `apply` ще раз (нічого не змінено, без restart: `systemctl show -p InvocationID node-control-api` до/після однаковий).
3. **R1 — збій після зміни конфігурації, до restart.** Передумова: API встановлено, у `api.env` ще немає `API_TRUSTED_PROXIES`.
   - Ін'єкція: тимчасово заборонити вхід тестової ролі — `runuser -u postgres -- psql -X -c 'ALTER ROLE node_control_user NOLOGIN'`. Порт PostgreSQL лишається відкритим, тож перевірки перед змінами проходять.
   - `server.js apply --artifact … --behind-nginx` → ключ дописано в `api.env`, потім `migrate.js status` падає (`code=28000`), exit 1; restart не виконано; `/var/lib/node-control-install/server.json` містить `"pending":["restart-api"]`. `server.js plan` цей файл не змінює.
   - Усунення причини (і відновлення при перериванні сценарію): `… -c 'ALTER ROLE node_control_user LOGIN'`.
   - Та сама команда `apply` → рівно один restart (InvocationID змінився), `pending` порожній; ще один повтор — нічого.
4. **R3 — невдалий restart.** Ін'єкція: тестова обгортка `/usr/local/sbin/systemctl` (у `PATH` root вона йде раніше за `/usr/bin`), яка один раз завершує `restart node-control-api.service` з кодом 1, а всі інші виклики передає `/usr/bin/systemctl`. `apply --behind-nginx` → «служба … не вдалося», у стані `restart-api`. Відновлення: видалити обгортку (`rm /usr/local/sbin/systemctl`) — це повертає точний початковий стан. Повтор → restart виконано, стан очищено; ще повтор — нічого. Той самий механізм використано для збою `daemon-reload` (R2) і для SIGKILL інсталятора одразу після успішного restart (R4).
5. Agent на другій VM з тестовим PM2-користувачем і процесами: `plan`, `apply` (heartbeat підтверджено), повтор, додавання `--pm2-owner/--pm2-home` і `--enable-control`; PID і час старту PM2-процесів не змінились; `pm2` не запускався (`ps`/journal).
6. Негативні: пошкоджений артефакт, чужий unit, `nodecontrol` з UID 0, відкликаний ключ (`unauthorized`), недоступний API.
7. Журнал: на цільовій версії systemd перевірити, що `systemctl show --property=InvocationID --value node-control-agent` повертає ідентифікатор, а `journalctl _SYSTEMD_INVOCATION_ID=<id> -o cat --no-pager -q` — лише рядки цього запуску з кодом виходу 0 (зокрема, коли записів немає); після `systemctl restart` старі записи не підтверджують новий запуск.
