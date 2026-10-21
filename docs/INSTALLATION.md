# Встановлення Node Control (self-hosted)

Єдине джерело інструкцій для первинного встановлення Central API, підключення серверів (Agent), діагностики та відновлення після часткової невдачі. Основний шлях — `git clone` → `./install.sh` (розділ «Основний маршрут»); розділи 1–3 — ручний/advanced маршрут і довідка про кожен крок. Процедура оновлення наявних інсталяцій і історія деплоїв — [DEPLOYMENT](DEPLOYMENT.md); архітектура — [ARCHITECTURE](ARCHITECTURE.md).

> **Стан перевірки (2026-10-21).** Основний маршрут `git clone` → `./install.sh` (підготовка runtime і релізу → майстер → `apply`) пройдено на нових одноразових VM **Ubuntu 26.04.1 LTS arm64**:
> - Central Server — звичайний користувач (umask 002), системний Node.js 22.22.1;
> - Agent — root без sudo, системний Node.js 21.7.3 → завантажений runtime 22.23.4, збирач `nodecontrol-build`.
>
> **x86_64 не перевірено:** на машині перевірки немає x86_64-середовища (розділ 8.1).

> **Стан перевірки неінтерактивних інсталяторів (2026-10-20).** Маршрут цього документа пройдено наскрізно на одноразових ізольованих VM: **Ubuntu 26.04.1 LTS (arm64)**, systemd 259, Node.js 22.22.1 і npm 9.2 з пакетів Ubuntu, PostgreSQL 18.6, Nginx 1.28.3; тестовий PM2 7.0.4 на окремій VM Agent. Перевірено первинне встановлення й повтори (API і Agent — під umask 022 і 077), Nginx/HTTPS-вхід, Agent з inventory і broker, часткові збої та відновлення, справжній systemd/journal, негативні сценарії й reboot (ці — під umask 022; матриця — розділ 8 і PROJECT_STATUS). Інші версії Ubuntu й архітектура x86_64 не перевірялись. Не запускайте інсталятори на серверах, де Node Control уже встановлено вручну: для них — [DEPLOYMENT](DEPLOYMENT.md).

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

- Ubuntu із systemd, x86_64 або arm64. Інші дистрибутиви й архітектури інсталятор відхиляє. Фактично перевірені платформи — розділ 8 і PROJECT_STATUS.
- **Node.js** — Node.js 22 не старший за `22.22.0`: це найнижча версія, яку приймають усі пакети `package-lock.json` (`react-router`: `>=22.22.0`). Перевіряється мінімальна версія, а не лише major 22; Node.js 21, 23, 24 і старші 22.x відхиляються. Усі служби, міграції, bootstrap адміністратора й release tooling використовують один абсолютний шлях `/opt/node-control-runtime/bin/node` (розділ «Runtime Node.js» нижче).
- На центральному сервері PostgreSQL готує оператор: `apt install postgresql nginx`; PostgreSQL слухає лише `127.0.0.1`. Стандартний `pg_hba.conf` Ubuntu уже дозволяє вхід за паролем із loopback.
- Docker не використовується. PostgreSQL і Nginx — host-служби, якими керує оператор. Інсталятор їх не налаштовує й не змінює сторонні БД, ролі, HBA, TLS чи firewall.
- Шляхи, користувачі й назви units фіксовані (deployment contract, [DEPLOYMENT](DEPLOYMENT.md)): один Central API на сервер; на керованому сервері — один власник PM2 для inventory і керування.
- Транзакційності системної інсталяції немає: кроки виконуються по черзі. За невдачі інсталятор зупиняється з поясненням, а повторний запуск продовжує.
- Довідка: `./install.sh --help`, `node server-bundle/install/server.js --help`, `node server-bundle/install/agent.js --help`. Коди виходу:
  - 0 — виконано (або план без перешкод);
  - 1 — зупинка: перевірка, конфлікт, невдалий крок чи невдала перевірка результату;
  - 2 — неправильні аргументи або немає термінала;
  - 130 — скасовано.

## Основний маршрут: `./install.sh`

```bash
git clone <URL репозиторію> node-control
cd node-control
./install.sh
```

Більше нічого запускати не потрібно: ні `npm ci`, ні збирання, ні пошуку артефактів, ні повторного запуску `install.sh`. Підготовку організовує сам інсталятор, системні кроки виконує після вашого явного «так». Дозволений довільний каталог checkout (зокрема шлях із пробілами), запуск з іншого cwd і через symlink на `install.sh`.

**Етапи одного запуску:**

| # | Що відбувається | Що змінюється |
|---|---|---|
| 1 | Вибір: Central Server або Agent — **до** будь-якого завантаження чи збирання (або `--component server\|agent`) | нічого |
| 2 | Перевірка середовища: термінал, root (див. нижче), Ubuntu, systemd, архітектура, наявний Node.js | нічого |
| 3 | Runtime Node.js: сумісний наявний — використовується; інакше пояснення й запит «Встановити runtime?» | лише після «так»: `/opt/node-control-runtime` |
| 4 | Перевірка checkout і передумов: чистий checkout, commit у `origin/main`, інший активний реліз (= оновлення, стоп), PostgreSQL на `127.0.0.1:5432` (для Central Server), вільне місце, HTTPS до `registry.npmjs.org` | нічого |
| 5 | План підготовки: хто збирає, що завантажується, куди потрапить реліз → «Підготувати реліз? так» | після «так»: див. «Підготовка релізу» |
| 6 | Збирання не від root, етапи з прогресом; копіювання й перевірка релізу від root | `/var/lib/node-control-releases/<ревізія>-<компонент>`, журнал |
| 7 | Майстер цього релізу: параметри (секрети не показуються) → `plan` (нічого не змінює) → «так» → `apply` → перевірка результату й наступні кроки | системні кроки інсталятора (розділи 2–3) |

Повторний запуск того самого commit не збирає знову: перевірений реліз зі сховища використовується одразу (крок 6 пропускається). Якщо збережений реліз не проходить перевірки, його буде перейменовано на `.invalid-<час>` і зібрано заново (це показується в плані).

**Хто що виконує (root, sudo, збирання):**

| Як запущено | Системні кроки | Збирання й npm (`--ignore-scripts`) |
|---|---|---|
| `./install.sh` звичайним користувачем | `install.sh` сам перезапускається через `sudo` (запит пароля sudo) | від вас (через `runuser`, порожнє середовище) |
| `sudo ./install.sh` | root | від користувача, що викликав sudo (`SUDO_USER` і `SUDO_UID` мають збігатися з обліковим записом, не root) |
| `./install.sh` від root без sudo | root | від окремого системного користувача `nodecontrol-build`: його створює інсталятор після «так»; без shell, без sudo, без доступу до секретів; home `/var/lib/node-control-build` (700) |

Збирання й npm lifecycle ніколи не виконуються від root. Наявний `nodecontrol-build`, який не відповідає цим вимогам (shell, групи `sudo`/`admin`/`wheel`/`adm`, UID поза 1–999, інший home), не використовується й не змінюється.

Середовище збирача не успадковується від root. Кожен процес збирача й git отримує лише перелічене середовище: `HOME`, `PATH`, `LANG`, тимчасові каталоги й змінні HTTP(S)-проксі, якщо вони задані.
- Несекретні змінні задає `env` у командному рядку.
- Змінні проксі (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` у обох регістрах) можуть містити пароль, тож передаються **лише через environment процесу** і ніколи не потрапляють в argv жодного процесу (`ps`, `/proc/<pid>/cmdline`).

**Що завантажується з мережі:**
- Node.js — лише якщо сумісного немає: `https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-<x64|arm64>.tar.gz` (~30 МБ).
- Пакети npm за `package-lock.json` з `registry.npmjs.org`:
  - Central Server: усі залежності (~200 МБ у робочому каталозі);
  - Agent: лише `typescript` і `@types/node` (~25 МБ), без збирання веб-інтерфейсу й API.

Проксі: задайте `HTTPS_PROXY`/`NO_PROXY` перед `./install.sh`.
- При перезапуску через `sudo` вони зберігаються **за назвою** (`sudo --preserve-env=HTTPS_PROXY,…`), значення в argv не передаються. Решту середовища користувача sudo скидає.
- Далі вони потрапляють до npm і git збирача; `curl` для Node.js їх теж враховує.
- Якщо політика sudo забороняє `--preserve-env`, sudo відмовить із поясненням; тоді запускайте від root зі змінними проксі.
- **Проксі з паролем і npm з пакета Ubuntu.** Перевірено: npm 9.2 з пакета Ubuntu не надсилає `Proxy-Authorization` (proxy відповідає 407, збирання зупиняється з `E407` у хвості журналу). npm 10.9.9 офіційного runtime надсилає.
  - Обхід: окремий runtime через `./install.sh --node-archive <файл>` з офіційним архівом, завантаженим через той самий проксі, наприклад `curl -O https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-x64.tar.gz`. Перевірка SHA-256 та сама.

Нічого не виконується з `curl | bash`, `eval` чи рядків shell із введених значень.

**Скасування.** До підтвердження (меню «0», відповідь не «так», Ctrl+C, Ctrl+D/EOF) система не змінюється. Якщо в цьому запуску вже встановлено runtime, повідомлення про скасування це називає.

Ctrl+C під час збирання зупиняє збирання. Робочий каталог прибирається, реліз не зберігається й не активується, повторний запуск починає збирання заново.

Скасування й помилки самого майстра — крок 4 нижче.

**Повтор і діагностика.** Будь-яку невдачу підготовки (завантаження, контрольна сума, `npm ci`, збирання, перевірка релізу) інсталятор показує так:
- назва етапу й причина;
- останні рядки журналу; облікові дані в URL замінено на `***`.

Неповний реліз не лишається як готовий і нічого не активується. Повторний запуск `./install.sh` безпечний.

Повний журнал збирання: `/var/log/node-control-install/build-<ревізія>-<компонент>-<час>.log` (каталог 700, файл 600 root). Права 600 — не заміна очищенню: кожен рядок очищається **до** запису.
- Облікові дані змінних проксі замінюються на `***`: сирі й percent-декодовані, **будь-якої довжини**, також поза URL. Будь-який `user:password@` в URL — так само.
  - Короткий пароль (1–2 символи) маскується в кожному входженні, навіть якщо ті самі символи трапляються у звичайному тексті. Рядки можуть стати менш читабельними, зате пароль не потрапить у журнал.
- Рядок, розірваний між фрагментами виводу, спершу збирається повністю.
- Те саме очищення застосовується до **всього** виводу підготовки в термінал (зокрема хвоста журналу й повідомлень про помилки). Неочікуваний виняток підготовки показується одним очищеним рядком, без сирого повідомлення й stack trace.
- Сирі дані в тимчасові файли не пишуться.

### Runtime Node.js

| Ситуація | Що робить `install.sh` |
|---|---|
| `/opt/node-control-runtime/bin/node` уже є | спершу перевірка довіри (нижче), потім версія — Node.js 22 ≥ 22.22.0. Якщо потрібен npm, він має бути довіреним і працювати на тому самому Node.js. Інакше — зупинка з причиною. Наявний runtime **ніколи** не замінюється й не перемикається автоматично; неповний runtime (без придатного npm) — зупинка з посиланням на [DEPLOYMENT](DEPLOYMENT.md), «Runtime Node.js» |
| runtime немає, `/usr/bin/node` довірений, 22 ≥ 22.22.0, npm поруч придатний (або npm не потрібен) | нічого не завантажує; служби використовуватимуть посилання `/opt/node-control-runtime/bin/node → /usr/bin/node` (крок «Node.js для служб» інсталятора, після «так») |
| runtime немає; системний Node.js відсутній, недовірений, несумісний (21, 23, 24, старший 22.x), або без придатного npm (немає, не запускається, працює на іншому Node.js) | пояснює причину й після «так» встановлює окремий runtime **у тому самому запуску**, далі підготовка продовжується. Системні Node.js і npm не змінюються; ручне `apt install npm` не потрібне |

**Коли потрібен npm:**
- основний маршрут — завжди (збирання);
- `--release … --component server` — так (production-залежності API);
- Agent із готового релізу (`--release … --component agent`, або компонент обирається в майстрі) — ні.

Якщо в `--release` без `--component` обрано Central Server, а npm непридатний, план інсталятора зупиниться з порадою `sudo ./install.sh --release <реліз> --component server`, і той запропонує окремий runtime.

**Перевірка довіри — до будь-якого запуску.** Правило однакове в `install.sh` (`executable_trusted`) і в інсталяторах (`executableTrust`, зокрема в прямих `server.js`/`agent.js plan|apply`). Перевіряються лише `stat`/`readlink`, нічого не виконується.

Шлях розбирається **покомпонентно**, так само, як його розв'язує ядро, і перевіряється **кожен** зустрінутий компонент: каталоги початкового шляху, кожне проміжне й кінцеве посилання, усі компоненти цілі кожного посилання (відносні, з `..` і `.`). Перевіряється не лише канонічний шлях: він приховав би небезпечні каталоги перед посиланням, а служби запускають саме початковий шлях.
- каталог — власник root, без запису для групи/інших; дозволено лише sticky-каталог root, як `/tmp`;
- посилання — власник root (лежить у перевіреному каталозі, тож інші не можуть його підмінити);
- кінцевий файл — звичайний виконуваний файл root без запису для групи/інших;
- щонайбільше 40 посилань: цикл відхиляється;
- для окремого runtime — усе дерево `/opt/node-control-runtime`, хоч би куди вело посилання. Якщо `/opt/node-control-runtime`, `bin` чи `bin/node` є посиланням, зокрема «висячим», runtime вважається наявним і перевіряється — тихого переходу до системного Node.js немає.

Легітимні системні посилання, наприклад `/bin → usr/bin` в Ubuntu, проходять, бо належать root і лежать у каталогах root.

Недовірений або «висячий» Node.js чи npm не запускається навіть для `--version`. Права чужих файлів не виправляються автоматично.

**Встановлення окремого runtime:**
1. Офіційний архів Node.js з `https://nodejs.org/dist/` (лише HTTPS, TLS ≥ 1.2, без переходу на http).
2. Фіксована версія: `NODE_VERSION` з `installer/bootstrap/node-runtime.env`, а не «latest».
3. Перевірка SHA-256 архіву за значенням, зафіксованим у тому самому файлі. Значення скопійовано з офіційного `SHASUMS256.txt` цієї версії.
4. Розпакування в тимчасовий каталог root (700) і перевірка, що двійковий файл запускається.
5. Атомарне перейменування в `/opt/node-control-runtime/versions/node-v<версія>-linux-<arch>/`; посилання `/opt/node-control-runtime/bin/node` на нього.

Обірване чи підмінене завантаження не стає runtime: тимчасовий каталог видаляється. Без мережі використовуйте `sudo ./install.sh --node-archive <файл>` — локальну копію того самого офіційного архіву з тією самою перевіркою.

**Модель довіри runtime:** HTTPS до `nodejs.org` + SHA-256, зафіксований у репозиторії. Довіра до правильності значення — це довіра до commit, з якого запущено `install.sh`. GPG-підпис `SHASUMS256.txt` інсталятор не перевіряє; при оновленні `NODE_VERSION` його варто перевірити під час review.

**Що не змінюється:**
- `/usr/bin/node`, системний npm, `PATH`, nvm, профілі shell;
- PM2, його startup і застосунки;
- сторонні служби.

**Власник і права:** `root:root`, каталоги 755, файли без запису для групи/інших. Служби (`nodecontrol`, `nodecontrol-agent`, власник PM2 для exporter/broker) runtime лише читають і виконують; від домашнього каталогу людини він не залежить.

**Довіра TLS-сертифікатам.** Служби API й Agent, а також майстер і підготовка, запускаються з `--use-system-ca`: перевірка HTTPS (Agent → API, API → Slack, `registry.npmjs.org`) спирається на системне сховище сертифікатів (`/etc/ssl/certs`, `update-ca-certificates`) за будь-якого runtime. Без цього офіційна збірка Node.js довіряла б лише вбудованому набору CA, і внутрішній CA, що працював із Node.js з пакета Ubuntu, перестав би діяти (виявлено на тестовій VM: `UNABLE_TO_VERIFY_LEAF_SIGNATURE`).

**Хто використовує `/opt/node-control-runtime/bin/node`:**
- units `node-control-api`, `node-control-agent`, `node-control-pm2-exporter@`, `node-control-pm2-broker@`;
- `server-release.js` (prepare/config/activate);
- `migrate.js`, `bootstrap-admin.js`;
- команда fingerprint broker.

`npm ci --omit=dev` релізу API виконує npm, що лежить поруч із цим Node.js. `server-release.js` ставить каталог runtime першим у `PATH` і перевіряє через `npm version`, що npm працює саме на цьому Node.js.

**Оновлення runtime** — свідома дія оператора, не інсталятора; старі версії в `versions/` не видаляються. Див. [DEPLOYMENT](DEPLOYMENT.md), «Runtime Node.js».

### Підготовка релізу

- **Лише закомічена ревізія.** `build-release.js --check` від власника checkout перевіряє:
  - робочий каталог чистий (зокрема без невідстежуваних файлів);
  - `HEAD` міститься в `origin/main` (віддалена гілка за замовчуванням; її перевіряє той самий код, що й у ручному маршруті).

  Зміни checkout інсталятор не чіпає: жодного commit, stash, reset чи `git pull`. За відмови він пояснює причину й показує змінені файли. Свіжий `git clone` проходить цю перевірку без додаткових дій.
- **Вихідний код** — `git archive` цієї ревізії, переданий потоком у тимчасовий робочий каталог збирача:
  - `/var/tmp/node-control-build.*` для користувача sudo;
  - `/var/lib/node-control-build/node-control-build.*` для `nodecontrol-build`.

  Код робочого дерева не встановлюється; checkout не змінюється й не стає «брудним».
- **Збирання** — чинний `scripts/deploy/build-release.js` цієї ревізії (`--from-tree`). Перед будь-яким npm він перевіряє версію Node.js і те, що npm у `PATH` працює на тому самому Node.js.

  Залежності: `npm ci --ignore-scripts --engine-strict` за lockfile. Несумісний engine — помилка, а не мовчазний пропуск optional-пакета.
  - **Central Server:** повний реліз (API, веб-інтерфейс, Agent, інсталятор).
  - **Agent** (`--component agent`): лише `typescript` і `@types/node` з їхніми залежностями. Вони беруться з чинного `package-lock.json` під час збирання (ті самі версії, URL і integrity), окремої копії lockfile немає. Компілюються лише Agent та інсталятор.
- **Передача й перевірка.** Збирач лише віддає tar-потік; root розпаковує його в каталог, недоступний збирачу (`/var/lib/node-control-releases`, 700 root). Перевіряється:
  - лише звичайні файли;
  - `BUNDLE.json` цієї ревізії й SHA-256 кожного файлу бандла;
  - `.sha256` артефактів.

  Лише тоді виконується атомарне перейменування в `<ревізія>-server` або `<ревізія>-agent`. Після цього збирач не може змінити реліз, який виконуватиме root. Робочий каталог видаляється (від імені збирача) за будь-якого результату.
- **Далі** — `install.sh --release <цей каталог> --component <компонент>`: ті самі перевірки довіри, що й для будь-якого релізу, і майстер саме цього релізу.

**Чотири різні речі, які не варто плутати:**

| Що | Де | Хто |
|---|---|---|
| checkout репозиторію | будь-який каталог: `/root/node-control`, `/home/<користувач>/src/node-control`, шлях із пробілами | звичайний користувач або root |
| підготовлений реліз | `/var/lib/node-control-releases/<ревізія>-<компонент>/` (артефакти, `.sha256`, `server-bundle/`) або, в advanced-маршруті, будь-який захищений каталог (`--release`) | готує інсталятор (збирає не root); запускає root |
| встановлена система | фіксовані `/opt/node-control*`, `/etc/node-control*`, `/var/lib/node-control*` — не checkout | root |
| PM2 на сервері Agent | власник PM2 (Linux-користувач, не root) і його `PM2_HOME` — окремо від того, хто запускає майстер | майстер пропонує, ви підтверджуєте |

### Майстер: питання, план, встановлення

**1. Відповісти на питання:**
- *Central Server:*
  - файл із `DB_*` (БД готується заздалегідь — розділ 2.1; якщо `api.env` уже є — не питається);
  - публічна HTTPS-адреса;
  - email першого адміністратора (пароль — прихований ввід самого bootstrap під час встановлення);
  - довіра до proxy (лише коли Nginx уже налаштовано за шаблоном `nginx-config`) і керування PM2 на рівні API — обидва за замовчуванням «ні».

  Nginx/TLS — розділ 2.3.
- *Agent:*
  - адреса Node Control і ключ із UI (прихований ввід; якщо `agent.env` уже є — ні адреса, ні ключ не питаються й не змінюються);
  - можливості: лише heartbeat, + inventory, + broker з порожньою allowlist (розділ 3.3).
- *Власник PM2:*
  - майстер шукає працюючі PM2 daemon лише за назвою процесу (`God Daemon (<PM2_HOME>)`) і реальним UID — без `pm2`-команд і без читання середовища процесів;
  - знайдені показуються списком, ви обираєте явно; daemon від root показується, але не підтримується (процеси не переносяться);
  - якщо daemon немає або потрібен інший — вручну: користувач (користувач, що запустив `sudo`, — лише підказка); домашній каталог береться з облікового запису, `<home>/.pm2` пропонується як типове місце, а не факт; можна ввести будь-який абсолютний `PM2_HOME`.

**2. План і підтвердження:** майстер показує параметри, виконує план; за блокувальних проблем зупиняється. Встановлення починається лише після введення слова «так».

`Ctrl+C`, `Ctrl+D`, кінець вводу (EOF) або «0» у меню до початку встановлення — скасування без змін. `Ctrl+D` під час прихованого вводу ключа теж скасовує: байт не стає частиною ключа.

Якщо встановлення вже почалося й перервалось, майстер не каже «нічого не змінено»: частину змін могло бути застосовано, повторний запуск продовжить (розділ 4).

**3. Повтор і помилки:** якщо встановлення зупинилось, усуньте причину й запустіть `./install.sh` ще раз із тими самими відповідями. Реліз береться зі сховища, виконані кроки пропускаються, незавершені `daemon-reload`/restart доводяться (розділ 4).

**Без термінала** (автоматизація) `install.sh` і майстер відмовляють (код 2) без змін. Для автоматизації — неінтерактивні `server.js`/`agent.js plan|apply` підготовленого релізу (розділи 2–3).

### Безпека: що виконує root

Root виконує код лише з місць, які не можуть змінити недовірені користувачі. Перевіряються:
- реліз (`--release` або сховище);
- частини checkout, які root виконує до збирання: `installer/bootstrap`, `scripts/deploy` і `.git` (git від root читає його конфігурацію, коли checkout належить root);
- runtime.

`install.sh` перевіряє це ще **до** запуску будь-якого коду з них:
- **довірені власники** — root, користувач, від якого запущено `install.sh`, і (під `sudo`) користувач, що викликав `sudo`. Він готував checkout і так може виконати що завгодно від root, тож від нього захисту немає й не обіцяється;
- жодних symlink, файлів чи каталогів із записом для інших або для **спільної** групи, лише довірені власники.
  - Запис для групи допускається лише через **приватну** групу довіреного користувача: група без учасників, основна рівно для одного облікового запису. Так звичайний `git clone` під umask 002 в Ubuntu проходить без `chmod`.
- **кожен каталог-предок аж до `/`** належить довіреному власнику (власник каталогу міг би перейменувати вкладене дерево й підставити інше). Запис для групи/інших дозволено лише sticky-каталогу, що належить root (як `/tmp`).
- runtime і npm — суворіше: лише root (правило «Перевірка довіри — до будь-якого запуску» у розділі «Runtime Node.js»), перевіряється до будь-якого запуску.
- наслідок: якщо root запускає `install.sh` напряму (без `sudo`), checkout чи реліз у домашньому каталозі іншого користувача відхиляються. Запустіть `sudo ./install.sh` від імені цього користувача або перенесіть файли в каталог root.

Обходу цих перевірок немає.

`server-bundle/BUNDLE.json` (пише `build-release.js`) фіксує ревізію й SHA-256 кожного файлу бандла. Майстер розбирає його як недовірені дані й відмовляє з поясненням (без stack trace і без змін), якщо:
- файл не є коректним JSON-об'єктом із 40-символьною ревізією та записами «відносний шлях → SHA-256»;
- бандл змінено, змішано з іншою збіркою або запущено не з бандла цього релізу;
- поруч лежать артефакти іншої ревізії.

Ця перевірка виконується вже кодом самого релізу, тому захистом від підміни є лише перевірки `install.sh` вище. SHA-256 доводить цілісність щодо `BUNDLE.json`, а не автентичність того, хто зібрав реліз.

### Advanced/offline: готовий реліз

Коли на сервері немає checkout або мережі до `registry.npmjs.org`, реліз готують на іншій машині (розділ 1) і передають каталог релізу цілком у захищений каталог сервера (`install -d -m 700 /root/node-control-install`, власник root). Далі:

```bash
sudo ./install.sh --release /root/node-control-install/<ревізія>                  # з checkout (runtime за потреби — як вище)
sudo ./install.sh --release /root/node-control-install/<ревізія> --node-archive /root/node-v22.23.4-linux-x64.tar.gz   # без мережі
sudo /opt/node-control-runtime/bin/node /root/node-control-install/<ревізія>/server-bundle/install/wizard.js \
     --release /root/node-control-install/<ревізія> [--component server|agent]   # без checkout, runtime уже є
```

Сумісний `/usr/bin/node` (22 ≥ 22.22.0) теж годиться для останньої команди. Тоді посилання runtime створить крок інсталятора.

## 1. Отримати артефакти (ручний / advanced маршрут)

На машині збирання (Node.js 22 ≥ 22.22.0 і його npm першими в `PATH`, checkout репозиторію, commit уже запушений), звичайним користувачем:

```bash
npm ci
node scripts/deploy/build-release.js                     # повний реліз; друкує revision, шляхи й SHA-256
node scripts/deploy/build-release.js --component agent   # лише Agent: без збирання веб-інтерфейсу й API
```

`build-release.js` сам відмовляє ще до `npm`, якщо:
- Node.js несумісний (наприклад, 21.7.3 або 24.x);
- npm у `PATH` працює на іншому Node.js.

Залежності встановлюються з `--engine-strict --ignore-scripts`.

У каталозі виводу:
- `node-control-api-<sha>.tar.gz` (+ `.sha256`), окрім `--component agent`;
- `node-control-agent-<sha>.tar.gz` (+ `.sha256`);
- `server-bundle/` — інструменти релізів і `install/`, тобто інсталятори.

Передайте на сервер у новий каталог, доступний лише root:

```bash
ssh root@<сервер> 'install -d -m 700 /root/node-control-install'
scp node-control-api-<sha>.tar.gz{,.sha256} root@<сервер>:/root/node-control-install/      # для керованого сервера — agent
scp -r server-bundle root@<сервер>:/root/node-control-install/
```

Нічого не завантажуйте й не виконуйте з інших джерел (жодного `curl | bash`). Інсталятор сам перевіряє SHA-256 артефакту й manifest кожного файлу. Неінтерактивні інсталятори нижче запускайте тим самим runtime (`/opt/node-control-runtime/bin/node`) або сумісним `/usr/bin/node`; `node` у прикладах означає саме його.

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

Перевірки до будь-яких змін: root, Ubuntu, systemd, Node.js (`/opt/node-control-runtime/bin/node` або сумісний `/usr/bin/node`, 22 ≥ 22.22.0, npm поруч), системні утиліти, SHA-256 артефакту, `server-release.js` поруч, вільний порт 3100, відсутність чужих файлів у `/opt/node-control`, відсутність іншого активного релізу, права й ключі `db.env`, TCP-доступ до PostgreSQL, формат `--public-url`.

| Крок | Що змінюється | Як перевірити | Якщо не вдалося |
|---|---|---|---|
| Користувач | `useradd --system --user-group --shell /usr/sbin/nologin nodecontrol` | `id nodecontrol` | наявний `nodecontrol` приймається лише як системний (UID 1–999, не UID 0, основна група не root, shell `nologin`/`false`); інакше — зупинка до змін, обліковий запис не змінюється |
| Node.js для служб | лише якщо `/opt/node-control-runtime/bin/node` ще немає: каталоги `/opt/node-control-runtime{,/bin}` (755 root) і посилання → `/usr/bin/node`; системний Node.js не змінюється | `ls -l /opt/node-control-runtime/bin/node` | наявний runtime не перемикається й не замінюється; чужий каталог — конфлікт |
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
# + broker для керування й логів (новий broker — режим auto: доступ визначає API за ролями й «Доступами»)
node server-bundle/install/agent.js apply --artifact $A --api-url https://control.example.com --token-file agent.key \
     --pm2-owner deploy --pm2-home /home/deploy/.pm2 --enable-control
# або лише ручний allowlist (створюється ПОРОЖНІМ)
node server-bundle/install/agent.js apply --artifact $A --api-url https://control.example.com --token-file agent.key \
     --pm2-owner deploy --pm2-home /home/deploy/.pm2 --enable-control --control-mode allowlist
```

Ключ можна також передати через `--token-stdin` (автоматизація) або ввести в прихований запит (без `--token-file`). Можливості додаються й пізніше: повторний `apply` з новими параметрами лише доводить відсутнє. Після встановлення `agent.key` видаліть (`shred -u agent.key`).

Перевірки до змін: root, Ubuntu, systemd, Node.js 22 ≥ 22.22.0 (runtime або сумісний `/usr/bin/node`), утиліти, SHA-256 артефакту, формат ключа й права файлу ключа (значення не друкується), HTTPS-доступ до API з перевіркою сертифіката (`GET /api/auth/me` → 401), а для PM2 — існування власника (не root), `PM2_HOME` цього власника, наявність `rpc.sock` (без нього — попередження: exporter звітуватиме «unavailable», PM2 не запускається) і те, що `nodecontrol-agent` не входить до основної групи власника PM2.

| Крок | Що змінюється | Якщо не вдалося |
|---|---|---|
| Користувач | `nodecontrol-agent` (системний, без shell) — **до** будь-яких каталогів чи файлів з його власністю | ті самі вимоги, що й для `nodecontrol` (не UID 0, не група root); інакше — зупинка до змін |
| Node.js для служб | як для API: посилання `/opt/node-control-runtime/bin/node` → `/usr/bin/node`, лише якщо runtime ще немає | наявний runtime не змінюється |
| Реліз | `/opt/node-control-agent` (755 root) → `prepare --no-install` → `activate` | як для API |
| Конфігурація | `/etc/node-control-agent` (750 `root:nodecontrol-agent`) → `agent.env` (600 `nodecontrol-agent`, атомарно): `NC_AGENT_API_URL`, `NC_AGENT_TOKEN` (+ ключі inventory/керування) — лише якщо файлу немає; інакше додаються лише відсутні ключі з `agent.env.bak-<час>` | наявний ключ ніколи не ротується |
| Unit | `node-control-agent.service` із релізу, `verify` → встановлення → `daemon-reload` — **до** `enable/start` | наявний інший unit Agent, exporter чи broker — зупинка ще в перевірках, до будь-яких змін |
| Inventory | група `nc-pm2-inventory`, членство Agent, `/var/lib/node-control-pm2` (2750 `<owner>:nc-pm2-inventory`), `/etc/node-control-pm2-exporter/<owner>.env` (644), units exporter, один пробний запуск, `enable --now` таймера | `journalctl -u node-control-pm2-exporter@<owner> -n 20 -o cat`; PM2 не змінювався |
| Керування | група `nc-pm2-control`, `/etc/node-control-pm2-broker/<owner>.env` (root, 644; новий — `NC_BROKER_MODE=auto`, з `--control-mode allowlist` — `NC_BROKER_ALLOWLIST` і **порожня** allowlist, наявна не змінюється), unit і служба broker, членство Agent. Наявний `<owner>.env` змінюється лише явним `--control-mode` (резервна копія `<owner>.env.bak-<час>`, restart broker); інший `NC_PM2_HOME` — конфлікт без змін | `journalctl -u node-control-pm2-broker@<owner> -n 20 -o cat` |
| Служба Agent | `enable` + `start` (`restart`, якщо змінено конфігурацію, unit або групи) | `journalctl -u node-control-agent -n 20 -o cat`; exit 2 — помилка конфігурації |

Результат: «служба запущена» → «зв'язок Agent підтверджено». Підтвердження дає лише **поточний запуск** Agent: інсталятор бере його `InvocationID` (`systemctl show --property=InvocationID --value node-control-agent`) і читає записи тільки цього запуску (`journalctl _SYSTEMD_INVOCATION_ID=<id> -o cat --no-pager -q`) потоково: з усього журналу запуску зберігається лише результат **останнього** рядка heartbeat (і останнього рядка inventory); сирий текст не зберігається й не виводиться.

Межі одного читання: 10 с (потім процес `journalctl` примусово завершується), 64 MiB виводу; рядки довші за 8 KiB пропускаються. Результати:

- останній результат `accepted` — успіх;
- `unauthorized`, `network` тощо — «не підтверджено» з порадою;
- жодного heartbeat — очікування до 15 повторів по 5 с;
- помилка `journalctl`, тайм-аут чи перевищення 64 MiB — явна відмова («не підтверджено», а не успіх).

Найгірший час перевірки обмежений: 15 × (≤ 10 с читання + 5 с паузи).

Що саме доводить успіх: процес поточного запуску Agent (той самий ключ і конфігурація) отримав від API підтвердження heartbeat і після цього не записав іншого результату. Agent пише рядок лише при зміні результату. Тому на незміненому працюючому Agent (повторний `apply`, без restart) підтвердження спирається на останню зміну в цьому запуску, а не на свіжий мережевий запит у момент перевірки. Записи попередніх запусків не враховуються. Якщо під час перевірки systemd перезапустив Agent, очікується звіт нового запуску. Сам `active` не є підтвердженням. `unauthorized` — ключ відхилено (не той сервер, відкликаний або сервер деактивовано); `network`/`timeout` — немає зв'язку або TLS; `unavailable` — помилка API. Для inventory додатково показується стан першого звіту.

### 3.3 Керування й логи: режими broker

Broker працює від власника PM2 і виконує лише типізовані `start`/`stop`/`restart` та обмежене читання хвоста логів; shell, шляхів чи аргументів немає. Режим задає `/etc/node-control-pm2-broker/<owner>.env` (ADR-028):

| Режим | Що доступно | Хто вирішує, хто й чим керує |
|---|---|---|
| `auto` (новий broker за замовчуванням) | усі процеси цього власника PM2 (до 500; більше — явне попередження в UI, не мовчазне обрізання) | API: роль (admin — усе; operator — керування й логи; viewer — лише перегляд) + надані сервери/сервіси в UI «Користувачі» → «Доступи». Без доступів operator/viewer нічого не бачать |
| `allowlist` | лише цілі root-allowlist (`"logs": true` — окремо) | API (ролі + «Доступи») **і** локальний allowlist |

В обох режимах перед кожною дією broker перевіряє, що ім'я відповідає рівно одному fork-процесу, і (протокол v2) що визначення процесу не змінилось з моменту авторизації в API; неоднозначні імена й cluster-процеси відхиляються. Broker у режимі `auto` працює лише з Agent і API, що підтримують scoped-доступ: старий Agent отримує відмову (`allowlist_invalid`), а новий Agent зі старим API нічого не виконує й пише попередження (fail closed). Broker у режимі `allowlist` зі старим API працює як раніше (протокол v1). **Логи:** operator/viewer читають логи лише через Agent і broker протоколу v2 (broker перед читанням перевіряє, що ціль — саме той сервіс і те саме визначення, на які API дав дозвіл); через старий Agent/broker (v1) логи доступні лише admin, для інших UI показує «Перегляд логів не підтримується: потрібні оновлені Agent і broker».

**Перехід наявного broker на `auto`** — без перевстановлення й без ротації ключа Agent, після оновлення API до версії зі scoped-доступом і надання доступів користувачам:

```bash
node server-bundle/install/agent.js plan  --artifact $A --api-url https://control.example.com \
     --pm2-owner deploy --pm2-home /home/deploy/.pm2 --enable-control --control-mode auto   # покаже «перемкнути режим allowlist → auto»
node server-bundle/install/agent.js apply --artifact $A --api-url https://control.example.com \
     --pm2-owner deploy --pm2-home /home/deploy/.pm2 --enable-control --control-mode auto
```

Інсталятор зберігає копію `<owner>.env.bak-<час>`, додає `NC_BROKER_MODE=auto` і перезапускає broker; allowlist залишається на місці (не читається). Повернення — той самий виклик із `--control-mode allowlist` (рядок замінюється на `NC_BROKER_MODE=allowlist`). Без `--control-mode` повторний `apply` режим не змінює.

**Режим `allowlist`** нічого не дозволяє, доки ви не додасте конкретні процеси:

```bash
OWNER=deploy; PM2_HOME=/home/deploy/.pm2; A=/etc/node-control-pm2-broker/$OWNER.allowlist.json
# fingerprint лише потрібних процесів (читає наявний daemon; виводить pm_id, name, exec_mode, fingerprint — без env)
runuser -u $OWNER -- env NC_PM2_HOME=$PM2_HOME NC_BROKER_ALLOWLIST=$A \
  /opt/node-control-runtime/bin/node /opt/node-control-agent/current/agent/dist/pm2-broker.js fingerprint
cp -p $A $A.bak-$(date -u +%Y%m%dT%H%M%SZ)
# відредагуйте $A (root, 644), наприклад:
# {"version":1,"targets":[{"id":"api-prod","name":"api","actions":["restart"],"fingerprint":"sha256:…"}]}
# "logs": true у записі — читання логів цього процесу, лише за окремим погодженням.
```

Broker перечитує allowlist сам. На центральному сервері керування увімкнене за замовчуванням (`PM2_CONTROL_ENABLED` типово `true`); `PM2_CONTROL_ENABLED=false` — аварійне вимкнення всіх команд (стан видно в UI). `server.js apply … --enable-pm2-control` лише записує `PM2_CONTROL_ENABLED=true` явно. Повний опис — [DEPLOYMENT](DEPLOYMENT.md), «Керування PM2» і «Перегляд логів».

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

**Наявні інсталяції й runtime.** Units ревізій від 2026-10-21 запускають `/opt/node-control-runtime/bin/node`; units раніше встановлених інсталяцій — `/usr/bin/node`. Автоматично наявні інсталяції не мігруються. Перед встановленням нових units під час оновлення потрібен runtime ([DEPLOYMENT](DEPLOYMENT.md), «Runtime Node.js»). `server-release.js rollback` units не змінює; встановлений unit з новим шляхом коректно запускає й попередній реліз, бо runtime лишається на місці.

**Rollback коду інсталятора** — окремий revert commit (`git revert`), без зміни історії. Після revert основним маршрутом знову стає ручне збирання (розділ 1). Уже встановлені runtime, релізи у сховищі, журнали й `nodecontrol-build` revert не прибирає — їх видаляють лише свідомо (нижче). Інсталятор ревізій `668ec23`–`b0f8d1d` файлу стану не знає: **не продовжуйте ним незавершений запуск нової версії** — він не виконає записаних reload/restart. Безпечний шлях: завершити незавершені дії вручну за переліком у файлі стану (розділ 4), потім, за потреби, повторити `apply` старою версією. Файл стану лишається на диску (без секретів) і нічого не ламає.

**Відкат первинного встановлення** (нічого не видаляється автоматично):

```bash
systemctl disable --now node-control-api                 # або node-control-agent / node-control-pm2-*@<owner>
```

Далі, лише свідомо: unit-файли в `/etc/systemd/system/node-control-*` (+ `daemon-reload`), `/opt/node-control` і `/opt/node-control-agent`, `/etc/node-control*`, `/var/lib/node-control-pm2*`, `/var/lib/node-control-install`, підготовлені релізи `/var/lib/node-control-releases`, журнали `/var/log/node-control-install`, користувачі `nodecontrol*` (зокрема `nodecontrol-build` з `/var/lib/node-control-build`: `userdel -r nodecontrol-build`), групи `nc-pm2-*`. Runtime `/opt/node-control-runtime` видаляйте останнім і лише коли жодна служба Node Control його не використовує (`grep -l node-control-runtime /etc/systemd/system/node-control-*`); інсталятор його ніколи не видаляє — він може знадобитися попередньому релізу. БД і роль Node Control видаляються лише окремим рішенням оператора (backup спершу). PM2 і застосунки цим не зачіпаються.

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
| `/health/ready` 503 | `systemctl status postgresql`; `runuser -u nodecontrol -- env ENV_FILE=/etc/node-control/api.env /opt/node-control-runtime/bin/node /opt/node-control/current/backend/dist/migrate.js status` |
| Підготовка релізу не вдалася | етап і причина — у виводі `install.sh`; повний журнал — `/var/log/node-control-install/build-*.log` (root, 600); неповний реліз не зберігається, повтор — `./install.sh` |
| «Node.js … не підходить» | `/opt/node-control-runtime/bin/node -v`, `/usr/bin/node -v`: потрібен 22 ≥ 22.22.0; без сумісного — `./install.sh` встановить runtime (розділ «Runtime Node.js») |
| Сайт не відкривається | `nginx -t`; `curl -sI https://<домен>/`; права читання `/opt/node-control/current/frontend/dist` |
| Вхід не працює | `AUTH_ALLOWED_ORIGINS` = точний `https://<домен>` (без шляху), сайт лише через HTTPS |
| Сервер «не на зв'язку» | `journalctl -u node-control-agent -n 20 -o cat` → `outcome` heartbeat |
| Немає застосунків | `journalctl -u node-control-pm2-exporter@<owner> -n 5 -o cat`; `stat -c '%U:%G %a' /var/lib/node-control-pm2/inventory.json` (`<owner>:nc-pm2-inventory 640`) |
| Дії недоступні | allowlist, `journalctl -u node-control-pm2-broker@<owner> -n 5 -o cat`, `PM2_CONTROL_ENABLED` на API |

Не друкуйте вміст `api.env`/`agent.env`, `systemctl show` чи `/proc/<pid>/environ`; не виконуйте `pm2 jlist`/`env` (містять env застосунків).

## 8. Наскрізна перевірка на чистій Ubuntu

### 8.1 Що виконано

**2026-10-21 — основний маршрут `./install.sh` з чистого clone.** Одноразові клони наявних тестових баз, Ubuntu 26.04.1 LTS **arm64**, без Docker і production. Перевірявся тестовий commit робочого дерева, отриманого через `git clone` з git bundle (`origin/main` містить commit). Матриця — у PROJECT_STATUS.
- **Central Server** (користувач `user`, umask 002, sudo; checkout у шляху з пробілом; системний Node.js 22.22.1 і npm 9.2 з Ubuntu):
  - `--help`; без термінала — відмова; брудний checkout — відмова зі списком файлів;
  - скасування перед підготовкою — без змін (порівняння стану);
  - повний маршрут: збирання від `user` (усі процеси npm/tsc/build-release — uid 501; root — лише обгортки `runuser`) → майстер → `apply` → health 200/200, адміністратор створено; units — `/opt/node-control-runtime/bin/node --use-system-ca`, runtime — посилання на `/usr/bin/node`;
  - повтор — реліз зі сховища без збирання, без restart; checkout лишився чистим.
- **Agent** (root без `SUDO_USER`, root-owned clone; системний Node.js замінено на офіційний 21.7.3):
  - runtime: підмінений `--node-archive` → відмова SHA-256; недоступний `nodejs.org` → відмова; скасування; завантаження 22.23.4 з перевіркою;
  - збій `npm ci` (недоступний проксі) → етап, хвіст журналу без пароля проксі, реліз не створено;
  - Ctrl+C під час збирання → 130, робочий каталог прибрано, процесів збирача не лишилось;
  - повний маршрут: `nodecontrol-build` (без shell і sudo, home 700), цільове збирання Agent без frontend/backend → майстер (inventory PM2 `pm2test`) → `apply` → heartbeat підтверджено;
  - `/usr/bin/node` лишився 21.7.3; PM2-процеси без змін; жодної pm2-команди; повтор — без збирання й restart.
- **Не перевірено:** x86_64. Ні qemu, ні іншої x86_64-VM немає. Rosetta для Linux на ядрі Ubuntu 26.04 не запускає x86_64-двійкові файли (`Failed to find vdso DT_HASH`).

**2026-10-20 — неінтерактивні інсталятори.**

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
