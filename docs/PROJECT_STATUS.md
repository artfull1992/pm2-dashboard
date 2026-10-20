# Поточний стан проєкту

## Незалежний повторний review Codex — вкладений --base і recovery: APPROVED (2026-10-20)

Перевірено commits `695c509`, `2c36a6a`, `15dd378` від бази `4541c0e`; початкове робоче дерево чисте. Обидва P2 попереднього review закрито. `ensureDirTree` відновлює вкладений `--base`, задає 755 лише новим каталогам, зберігає metadata наявних предків і відмовляє при конфлікті з файлом. Regression-тести перевіряють обидва umask, повтор і збереження прав/власника. Зайвих функціональних змін не виявлено.

**Code → Docs / Docs → Code:** INSTALLATION §8 тепер відділяє історичний прогін від процедури повторення, описує фактичні R1/R3 та відновлення лише на одноразових VM; обсяг umask уточнений. DEPLOYMENT і ADR-027 відповідають поведінці створення каталогів. Майстер `install.sh` залишається планом, не реалізованою можливістю.

**Незалежні поточні перевірки, Node.js 22:** `check:local` exit 0 — 136 unit, 500 backend, 10 smoke, 165 Agent (3 opt-in пропущені), 247 frontend, 107 installer; typecheck, lint, secrets і збірки успішні. Додатково з поточного tooling зібрано тимчасовий server-bundle: справжній CLI зі синтетичним tar.gz/manifest під umask 077 створив три відсутні рівні base з 755, повтор повернув `already-prepared`; перевірено metadata symlink-предка та `--help` обох інсталяторів. Тимчасові матеріали прибрано, код продукту reviewer не змінював.

**Межі:** нового прогону VM не виконано; історична Ubuntu-матриця залишається результатом revision `7023523`, первинні докази перевірено в попередньому review. x86_64, інші Ubuntu, оновлення наявної інсталяції та неохоплені VM шляхи вводу секретів залишаються неперевіреними. Production, VM, БД, Nginx і PM2 не змінювались; Task 001/готовність production цим review не підтверджуються. Попередній блокер знято, можна готувати погоджений наступний етап майстра встановлення.

## Ubuntu review: вкладений --base і інструкція recovery (2026-10-20) — готово до повторного review Codex

Статус: **готово до повторного review Codex** (APPROVED не виставлявся). База: `4541c0e`, гілка `main`. VM і production не змінювались; Linux-прогін на новій revision не повторювався (див. «Межі»).

| # | Причина | Виправлення | Файли | Regression (старий код → новий) |
|---|---|---|---|---|
| P2 `--base` | виправлення umask (`9cedd89`) замінило рекурсивний mkdir створенням лише `base` і `releases`; відсутній батьківський каталог давав ENOENT | `ensureDirTree`: створює всі відсутні рівні зверху вниз, кожен новий — з явним `chmod 755`; наявні предки й цілі symlink не змінюються; файл на місці каталогу — «exists and is not a directory» без перезапису | `scripts/deploy/lib/release-dir.js` | `deploy-release.test.js`: вкладений base (3 відсутні рівні) під umask 022 і 077 → усі нові рівні 755, повтор — `already-prepared`; наявний предок `0710` зберіг права, UID і GID — 3 тести падали → проходять; конфлікт із файлом (проходив і раніше: ENOTDIR) — закріплено; наявні тести ownership/umask/manifest — без змін (23/23) |
| P2 recovery | INSTALLATION §8 описував `systemctl mask` і Ctrl+C, яких не виконували; masked unit — symlink, тож інсталятор зупиняється ще в перевірках, до запису ключа | §8 розділено: «Що виконано» (факт, точний обсяг umask) і «Як повторити» (R1 — тимчасовий `ALTER ROLE … NOLOGIN`, R3 — одноразова обгортка `systemctl`; передумови, очікуваний pending state, усунення причини, відновлення, лише тестові VM); у примітці на початку документа уточнено обсяг umask | `docs/INSTALLATION.md` | джерела фактів: сценарії `r1.sh`, `r234.sh`, `final-run.sh` і журнали `final-R1.log`, `final-R234.log`, фаз API/Agent 022/077 (приватний scratchpad, не в репозиторії) |

Уточнення обсягу umask (не переписує попередніх записів): під 022 і 077 пройдено фази встановлення API й Agent; recovery-, негативні, журнальні сценарії й reboot — лише під 022.

| Перевірка (Node 22) | Результат |
|---|---|
| `node --test tests/unit/deploy-release.test.js` | на `4541c0e` з новими тестами: 3 падіння (fail 3, pass 20); після виправлення 23/23 |
| `npm run check:local` | exit 0: node:test 136/136, backend 500/500, smoke 10/10, agent 165/165 (+3 opt-in), frontend 247/247, installer 107/107, typecheck, lint, збірки, secrets |
| Пакування | `server-bundle` зібрано `stageServerBundle` з поточного tooling; справжній CLI `server-release.js prepare --no-install` зі синтетичним tar.gz і manifest у вкладений `--base` (3 відсутні рівні) під umask 077 → `prepared`, повтор → `already-prepared`, усі нові рівні 755; `--help` обох інсталяторів із бандла |
| `npm run test:installer`, `git diff --check`, `check:secrets` | 107/107 (у складі check:local); OK; OK |

**Межі.** Повтор на Lima VM не виконувався: зміна — логіка створення каталогів у `prepare`, перевірена на справжній файловій системі під umask 022/077 і через CLI `server-release.js` зі справжнім tar.gz; фіксовані шляхи інсталяторів (`/opt/node-control*`) мають наявного батька `/opt`, тобто поведінка інсталяторів на VM від цієї зміни не залежить. Матриця `7023523` не є прогоном нового коду.

**Узгоджений наступний етап (лише план, НЕ реалізовано до APPROVED):** майстер `git clone → cd node-control → sudo ./install.sh` з вибором «Central Server» або «Agent». Вимоги: каталог checkout довільний (не прив'язаний до `/home/ubuntu`); встановлення може виконувати root; власник PM2 визначається окремо; домашній каталог — із системного облікового запису; `PM2_HOME` — з фактичного daemon/конфігурації, а не з поточного `./`; кілька власників — явний вибір; нестандартний шлях можна вказати вручну; зберігається чинний versioned release workflow (артефакт, checksum/manifest, `prepare`/`activate`, rollback).

## Незалежний review Codex — Ubuntu E2E / ADR-027: CHANGES REQUIRED (2026-10-20)

Перевірено зміни `9cedd89`–`7023523` і документацію `2286fc5` від бази `6e98324`; початкове дерево чисте. Прочитано реалізацію прав/ownership, preflight units, звітів кроків, regression-тести й документацію Code → Docs / Docs → Code. Ubuntu-прогін підтверджується доступними первинними артефактами, але є два зауваження:

1. **P2 — регресія вкладеного --base у release tooling.** `scripts/deploy/lib/release-dir.js:94–95`: recursive mkdir замінено створенням лише base і releases. За відсутнього батьківського каталогу prepare падає ENOENT. Відтворено зі справжнім синтетичним tar.gz/manifest у тимчасовому каталозі: base `<temp>/parent/node-control`, parent відсутній; код `6e98324` успішно готує реліз, поточний — ENOENT на mkdir base. Це регресія наявного параметризованого server-release.js --base, незалежна від фіксованих шляхів installer. Потрібно відновити створення вкладеного дерева, задавати точні права лише новоствореним каталогам і не змінювати наявних батьків; regression під umask 022/077, повтор і збереження metadata наявного предка.
2. **P2 — опис recovery не відповідає виконаному прогону.** `docs/INSTALLATION.md:273–278` стверджує, що всі наведені пункти пройдені, але пункт 3 досі містить systemctl mask → apply → restart failure. Фактичний r1.sh і final-R1.log використовують ALTER ROLE ... NOLOGIN (збій migrate status після запису конфігурації); R3 використовує одноразову тестову обгортку systemctl. Mask-сценарій не еквівалентний: наявний regular unit не можна просто замінити mask, а masked symlink installer відхиляє у checkUnits до запису ключа. Додатково на чинному FakeHost відтворено masked unit → exit 1, changes=[], ключ proxy не додано. Потрібно описати фактично перевірені контрольовані ін'єкції й відновлення лише на одноразовій VM; не залишати неробочу команду під твердженням про виконану перевірку. Уточнити й формулювання «кожен сценарій двічі 022/077»: первинні API/Agent фази проходили обидва umask, recovery/негативні фази в оркестраторі не дублюються для кожного umask.

**Незалежно, Node.js 22:** check:local exit 0 — 132 unit, 500 backend, 10 smoke, 165 Agent (3 opt-in пропущені), 247 frontend, 107 installer; typecheck/lint/secrets/збірки. Два додаткові відтворення вище виконано поза репозиторієм (справжній tar/FS для --base; FakeHost для masked unit), код продукту не змінювався.

**Первинні докази Ubuntu:** у наданому оператором приватному scratchpad перевірено release3, final-run.sh, сценарії R1/R234 і журнали фінальних фаз. Обидва архіви мають SHA-256 зі звіту (API `88ce64236a3f0b9aba371eb8af92d230100574c75a9490c51d779608dc86f79f`, Agent `1933cb2559118c398be5a3cec784ded2d65724f60e9a23e8913241625ac81a6f`), manifest revision `7023523d7fe1db4f6b53b30f44d932608ac7a9dd`, 78/48 файлів, hashes без помилок і без missing/unexpected файлів. Release source = Git цієї revision, installer/dist = незалежно зібраний поточний код. Журнали API/Agent 022/077, R1–R5, X/XA, J1–J3, B1 узгоджуються з основними результатами матриці; зокрема R1 pending/відновлення, R4 exit 137, bounded scan і reboot. Для nc-agentr broker після reboot not-found/inactive відповідає R5 (inventory-only), а не дефекту автозапуску. Lima read-only list підтвердив 6 зупинених aarch64 VM.

**Межі:** reviewer не запускав VM і не повторював Linux E2E самостійно; перевірено первинні матеріали прогону Claude. x86_64, інші Ubuntu, оновлення встановленої системи та неохоплені VM шляхи вводу секретів залишаються обмеженнями зі звіту. Task 001/production цією перевіркою не підтверджуються. Production, VM, БД, Nginx і PM2 reviewer не змінював, VM/артефакти не видаляв. Змінено лише запис review; до виправлення зауважень нову функціональність не починати.

## Наскрізна перевірка інсталяторів на Ubuntu 26.04.1 LTS (2026-10-20) — готово до незалежного review Codex

Статус: **готово до незалежного review Codex** (APPROVED не виставлявся). База: `2687c35`; фінальна code revision прогону: `7023523`. Production не використовувався й не змінювався; справжніх Slack-повідомлень і керуючих дій над PM2-застосунками не було.

**Середовище** (за рішенням користувача — lima VM на ноутбуці замість Docker; Docker не використовувався): одноразові VM Ubuntu 26.04.1 LTS **arm64**, systemd 259, Node.js 22.22.1 і npm 9.2 з пакетів Ubuntu, PostgreSQL 18.6 (лише `127.0.0.1:5432`), Nginx 1.28.3; окрема VM Agent з тестовим non-root власником PM2 (`pm2test`, PM2 7.0.4, окремий `PM2_HOME`, 3 синтетичні застосунки; автозапуск PM2 — передумова тестового середовища). Тестовий домен у `/etc/hosts`, одноразовий тестовий CA, довірений на VM (перевірку TLS не вимикали). Скидання — клонування зупинених баз (еквівалент snapshot). Адреси, ключі й сирі журнали прогону — поза репозиторієм.

**Артефакти** (`build-release.js` із чистого запушеного commit, `sha256sum -c` на VM): `node-control-api-7023523d…` SHA-256 `88ce64236a3f0b9aba371eb8af92d230100574c75a9490c51d779608dc86f79f` (78 файлів); `node-control-agent-7023523d…` SHA-256 `1933cb2559118c398be5a3cec784ded2d65724f60e9a23e8913241625ac81a6f` (48 файлів); `server-bundle/`.

**Дефекти, знайдені прогоном (виправлено з regression):**

| # | Дефект | Виправлення | Regression |
|---|---|---|---|
| 1 | `npm ci` від root зберігав власника з tarball пакетів: 81 файл `node_modules/@types/*` з UID 1001 у релізі (контракт — `root:root`; користувач з UID 1001 міг би їх змінювати) | `ownTree` у `prepareRelease` (lchown без розіменування symlink, лише від root) | `deploy-release.test.js` (`ownTree`); на VM: `release non-root-owned: 0` |
| 2 | Чужий unit виявлявся лише на кроці 6 — після користувача, релізу, конфігурації й міграцій | preflight порівнює наявні units з копією в артефакті (`tar -xzOf`) для API, Agent, exporter, broker | тести server/agent (падали на попередньому коді); VM X2/XA2: відмова без жодної зміни |
| 3 | Повторний bootstrap рахувався як «Змінено: 1 крок» | крок може повідомити «нічого не змінено» | `server.test.ts` |
| 4 | Наступні кроки нумерувались із пропуском і радили `--behind-nginx`, коли його вже передано | список відкритих кроків, нумерація підряд | `server.test.ts` |
| — | umask 077 робив реліз і allowlist недоступними (знайдено під час підготовки, `9cedd89`) | — | підтверджено на VM: A6/G6 |

**Матриця (фінальна revision `7023523`, кожна фаза з чистої бази):**

| # | Сценарій | Очікування | Факт |
|---|---|---|---|
| A1 | БД за INSTALLATION §2.1 (прихований ввід емульовано pty) | роль без привілеїв, 5432 лише loopback | так |
| A2 | `server.js plan` | без змін | знімок стану до = після (з InvocationID) |
| A3 | `apply --admin-email` (umask 022) | non-root `nodecontrol` без shell; `api.env`/backup 600; міграції до активації; live/ready 200; стан очищено; пароль ніде | так; `applied=9`, 1 admin, усі файли релізу root, процес від `nodecontrol`, пароль у виводі — 0 |
| A4 | повтор A3 | без змін, без restart | знімок ідентичний; bootstrap «нічого не змінено» |
| A5 | `--behind-nginx --enable-pm2-control` + повтор | +2 ключі, 1 restart; повтор — нічого | так |
| A6 | A2–A5 під umask 077 | ті самі результати | так |
| N1 | `nginx-config` → `nginx -t` → reload; HTTPS | статика, SPA, `/api/`, Origin, cookie | 200/`no-store`/301/401/404; чужий Origin 403; login 200, `__Host-nc_session; HttpOnly; SameSite=Strict; Secure`; `www-data` читає статику, але не `api.env`; сторонній `default` vhost не змінено |
| G1–G3 | Agent plan, heartbeat-only, повтор | без змін; підтвердження поточним запуском; повтор без restart | так; ключ у виводі — 0 |
| G4/G5 | inventory, broker | групи без групи PM2 owner; snapshot 640, сокет 660; allowlist порожня; restart Agent | так; Agent не відкриває `rpc.sock`; у API 3 тестові процеси, цілей 0 |
| G6 | G1–G5 під umask 077 | ті самі | так (allowlist 644 читає broker) |
| — | PM2-застосунки | PID і час старту без змін, жодних pm2-команд | так (у журналі лише записи підготовки тестового середовища) |
| R1 | конфігурацію змінено, збій до restart (вхід ролі тимчасово заборонено) | стан `restart-api`; повтор — 1 restart; ще повтор — нічого | так |
| R2 | unit записано, `daemon-reload` упав (тестова обгортка `systemctl`) | повтор: reload до activate/start | так |
| R3 | restart упав | лишається в стані до успіху | так |
| R4 | SIGKILL інсталятора після restart до очищення | ще 1 restart, далі нічого | так |
| R5 | Agent: група/ключ записані, збій exporter до restart | процес без нової групи; повтор — restart, процес отримав групу | так |
| R6 | plan з pending; пошкоджений JSON; symlink; права 644 | plan не змінює; інші — відмова до змін | так |
| J1 | InvocationID і фільтр журналу | новий ID при restart; лише свій запуск; порожній результат — код 0 (з `-q` і без) | так |
| J2 | ключ відкликано; незмінений apply | без restart; «не підтверджено (unauthorized)», exit 1 | так |
| J3 | bounded scan на журналах ~3 MiB (`systemd-run`) | останній heartbeat; `limit`/`timeout` явно; без залишкових процесів | так; токен у звіті — 0 |
| X1–X4, X7 | пошкоджений артефакт; чужий unit; `nodecontrol` UID 0 / група root; `db.env` 644; інший активний реліз | відмова, знімок до = після | так |
| XA1–XA5 | API недоступний; чужий broker unit; пошкоджений артефакт; `nodecontrol-agent` UID 0; ключ 644 | відмова, без змін | так |
| B1 | reboot API і двох Agent VM | служби, health, зв'язок, inventory | так (сервери online, inventory current) |

**Не перевірено / межі:** x86_64 та інші версії Ubuntu; `--admin-password-file`, `--token-stdin` і прихований ввід ключа на VM (використано файл ключа й інтерактивний bootstrap через pty; ці шляхи покриті автоматичними тестами); тривала робота й оновлення через `server-release.js` після встановлення (поза цим завданням). Дрібне: після установки без `--admin-email` наступні кроки радять bootstrap, навіть якщо адміністратор уже є (інсталятор не читає БД заради підказки). Перший прогін на `2687c35` знайшов дефект 1; повтор на `29165cf` — дефект 2; фінальний — на `7023523`. Збої тестового harness (емуляція pty, копіювання в VM, пошук InvocationID у J3) виправлено в harness; відповідні сценарії повторено.

| Перевірка (Node 22, локально) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 132/132, backend 500/500, smoke 10/10, agent 165/165 (+3 opt-in), frontend 247/247, installer 107/107, typecheck, lint, збірки, secrets |
| `git diff --check`, `check:secrets` | OK |
| `test:backend:db`, UI Playwright, `test:e2e`, `test:integration` | не запускались: backend, frontend і БД не змінювались (integration — немає локального PostgreSQL) |

## Наскрізна перевірка інсталяторів на Ubuntu: підготовка й виправлення umask (2026-10-20) — прогін НЕ виконано, очікує тестових VM

Статус: **наскрізний прогін не виконаний** — погодженого ізольованого середовища немає (VM відсутні, засобів віртуалізації локально немає, встановлення VM tooling, платні ресурси й Docker не погоджені). Production не використовувався й не змінювався. База: `6e98324`, гілка `main`.

**Знайдено під час підготовки матриці (umask 077, крок INSTALLATION §2.1 радить його перед створенням `db.env` у тій самій сесії):**

1. `server-release.js prepare` створював `/opt/node-control*`, `releases/` і каталог релізу через `mkdirSync(…, { mode: 0o755 })`. Цей mode маскується umask: при 077 виходило `700 root`, і `nodecontrol`, `nodecontrol-agent`, власник PM2 (exporter/broker) та Nginx не змогли б прочитати реліз. Файли `npm ci` теж отримували права від umask. **Виправлення** (`scripts/deploy/lib/release-dir.js`): створені каталоги отримують явний `chmod 755`; реліз після встановлення залежностей нормалізується `chmod -R u+rwX,go=rX` (раніше `go-w`). Наявні чужі каталоги не змінюються.
2. `realHost.writeFileAtomic` інсталятора створював файл через `open(…, mode)`, і режим теж маскувався umask: allowlist broker `644` ставав `600`, тож broker (від власника PM2) не зміг би його прочитати. **Виправлення** (`installer/src/host.ts`): файл створюється не ширшим за `600`, і до запису вмісту отримує точний режим через `fchmod`.

| Перевірка (Node 22) | Результат |
|---|---|
| Regression `deploy-release.test.js` («prepare under umask 077») | старий код: падав; новий: 18/18 |
| Regression `real-host.test.ts` (umask 077: файл 644, каталог 2750) | старий код: падав (`0600` замість `0644`); новий: проходить |
| `npm run check:local` | exit 0: node:test 131/131, backend 500/500, smoke 10/10, agent 165/165 (+3 opt-in), frontend 247/247, installer 105/105, typecheck, lint, збірки, secrets |
| `git diff --check`, `check:secrets` | OK |
| Linux E2E (INSTALLATION §8, матриця A/N/G/R/J/X/B) | **не виконано** — немає VM |

Документація: INSTALLATION (права релізу незалежні від umask; §8 — кожен сценарій під umask 022 і 077), DEPLOYMENT (контракт прав релізу). Детальна матриця прогону й перелік ресурсів підготовлені поза репозиторієм.

**Потрібно від оператора:** дві одноразові Ubuntu LTS VM (api, agent) зі snapshot/reset, приватна мережа між ними, SSH alias кожної у локальному `~/.ssh/config` (вхід ключем, root через sudo). Паролі й ключі в чат не передаються. Після цього прогін виконується на артефактах фінальної revision.

## Незалежний review Codex — виправлення ADR-027: APPROVED у межах коду й локальних перевірок (2026-10-20)

Перевірено `0149eac`, `1d40129`, `0e41628` від бази `c0e196d`; початкове дерево чисте. Залишковий P2 закрито: журнал invocation читається потоково без накопичення всього stdout; зберігаються лише останні результати heartbeat/inventory, діють deadline 10 с, ліміт 64 MiB та межа рядка. Timeout/limit зупиняють дочірній процес і не дають хибного успіху. Попередні regression щодо invocation, незмінного повтору, durable reload/restart і UID 0 проходять. Нових блокувальних зауважень у перевіреному scope немає.

**Code → Docs / Docs → Code:** INSTALLATION/ADR описують ресурсні межі, помилки, відсутність heartbeat, максимальні 15 циклів читання/очікування та точний зміст успіху на незміненому Agent — останній записаний результат поточного invocation, а не свіжий мережевий запит. Pending state і правила rollback збережені. Сторонніх функціональних змін немає.

**Незалежно, Node.js 22:** check:local exit 0 — 130 unit, 500 backend, 10 smoke, 165 Agent (3 opt-in пропущені), 247 frontend, 104 installer; typecheck/lint/secrets/збірки успішні. Installer-набір включає справжні дочірні процеси: великий потік, останній heartbeat, ліміт виводу, deadline і завершення процесу. Додатково повторено попереднє відтворення поза репозиторієм: stable invocation + accepted на початку виводу понад 2 MiB через справжній realHost.scan → verification=true, без переповнення старого spawnSync-буфера.

**Обов'язкова межа висновку:** APPROVED стосується цього циклу code/docs-виправлень, а не перевіреного встановлення на Linux. Чиста Ubuntu VM, справжній systemd/journal, Linux ownership і повний install/update/recovery досі не підтверджені; наступний крок — окремий погоджений наскрізний прогін за INSTALLATION §8 перед заявою про готовий Linux installer. Production/Task 001 серверними перевірками в цьому review не підтверджувався. Backend DB/E2E/UI Playwright не повторювались (runtime продукту не змінено). Production, БД, Nginx і PM2 не змінювались; функціональний код reviewer не редагував.

## ADR-027: обмежена перевірка журналу Agent (2026-10-20) — готово до повторного review Codex

Статус: **готово до повторного review Codex** (APPROVED не виставлявся). База: `c0e196d`, гілка `main`. Production, сервери, БД, Nginx, PM2 не змінювались; інсталятори на реальних серверах не запускались. Pending state, перевірка облікових записів і release workflow не змінювались.

**Причина.** `verifyAgent` читав увесь журнал поточного invocation через `spawnSync` з типовим `maxBuffer` (≈ 1 MiB). На довгому запуску Agent журнал переповнював буфер, і повторний apply справної інсталяції завершувався «не вдалося прочитати журнал». Простий tail не годиться: стабільний `accepted` пишеться один раз.

**Виправлення.**
- Новий `Host.scan`: потокове читання stdout дочірнього процесу рядок за рядком. Межі: deadline (потім `SIGKILL`), ліміт байтів (результат `limit` + `SIGKILL`), рядки понад ліміт пропускаються без накопичення, stderr ігнорується; результати — `exit`/`timeout`/`limit`/`error`.
- `verifyAgent` викликає `journalctl _SYSTEMD_INVOCATION_ID=<id> -o cat --no-pager -q` з межами 10 с / 64 MiB / 8 KiB на рядок і зберігає лише результат останнього heartbeat та inventory (без сирого тексту).
- Помилка, тайм-аут і перевищення ліміту — явна відмова з поясненням.
- Решта лишилась як була: зміна invocation під час читання, очікування першого heartbeat (15 × 5 с), відсутність restart заради перевірки.

Файли: `installer/src/host.ts`, `installer/src/agent.ts`, `installer/test/fake-host.ts` (`scan` з тією самою семантикою: фільтр за invocation, ліміти, тайм-аут, помилка), новий `installer/test/journal.test.ts`.

| Перевірка (Node 22) | Результат |
|---|---|
| Відтворення на коді `c0e196d` (справжній дочірній Node як `journalctl`, 2,5 MiB журналу) | 2 із 3 тестів падали: ранній `accepted` + понад 2 MiB → хибна відмова; пізній `unauthorized` серед мегабайтів подій → не розпізнано. Після виправлення — 3/3 |
| `journal.test.ts` | 13/13: великий журнал; `unauthorized` після `accepted`; старий `unauthorized` + новий `accepted`; синтетичний секрет у журналі не потрапляє у вивід; тайм-аут; журнал > 64 MiB (справжній процес) → явна відмова; помилка `journalctl`; порожній журнал і лише inventory-події ≠ `accepted`; inventory з того самого проходу не підміняє heartbeat; запит завжди з поточним InvocationID. `realHost.scan` на справжніх процесах: 4 МБ потоком (40 001 рядок, останній без `\n`); > ліміту → `limit` і процес знищено; завислий процес → `timeout` за < 3 с і процес знищено; задовгі рядки пропускаються, код виходу передається, stderr не захоплюється; неіснуюча команда → `error` |
| Попередні regression (`recovery.test.ts`) | без змін, проходять (зміна invocation, незмінений повтор без restart, pending state, UID 0) |
| `npm run test:installer` | 104/104 (було 91) |
| `npm run check:local` | exit 0: node:test 130/130, backend 500/500, smoke 10/10, agent 165/165 (+3 opt-in), frontend 247/247, installer 104/104, typecheck, lint, збірки, secrets |
| Пакування | `installer:build`; `stageServerBundle` на тимчасовому stage → `server-bundle/install/` містить усі модулі й `package.json`; `--help` обох CLI з бандла; імпорти лише `node:*` і власні |
| `git diff --check`, `check:secrets` | OK |
| `test:backend:db`, UI Playwright, `test:e2e`, `test:integration` | не запускались: backend, frontend і БД не змінювались; для integration немає локального PostgreSQL |

Перша спроба оновити документацію через Python-heredoc не застосувалась (локаль C, помилка кодування) — повторено скриптом у UTF-8. Це помилка інструмента, не коду.

**Документація:** INSTALLATION — як обирається останній heartbeat, межі часу й обсягу, порожній журнал, тайм-аут, що саме доводить успіх на незміненому Agent; сценарій майбутньої Ubuntu-перевірки доповнено перевіркою `InvocationID` і `journalctl _SYSTEMD_INVOCATION_ID=… -q`. ADR-027 — датоване уточнення.

**Межі.** Справжній systemd/journal не перевірявся: поведінка `_SYSTEMD_INVOCATION_ID`, `-q` і коду виходу при порожньому результаті взята з документації systemd і підлягає перевірці в сценарії INSTALLATION, розділ 8. **Наскрізне встановлення на чистій Ubuntu VM ще не виконане.** Rollback — окремий revert commit; заборона продовжувати pending-операції старим інсталятором і збереження файлів стану діють як раніше.

## Повторний незалежний review Codex — ADR-027: CHANGES REQUIRED (2026-10-20)

Перевірено `b819cac` і `84814f7` від бази `0fb6501`, новий state, порядок intent/change/reload/restart/clear, verification Agent, account preflight, тести й документацію в обох напрямках. Початкове дерево чисте. Попередні три P2 закриті в перевірених сценаріях: pending дії переживають помилки, daemon-reload відновлюється, UID/GID 0 відхиляються до мутацій, записи попередніх invocation не підтверджують новий Agent. Документація описує state, відновлення та обмеження старого інсталятора. Залишилось нове зауваження:

**P2 — читання всього журналу invocation переповнює буфер verification.** `installer/src/agent.ts:200–203` викликає journalctl без ліміту кількості/обсягу та без фільтра лише потрібних повідомлень. `installer/src/host.ts:105–106` використовує spawnSync з типовим maxBuffer. На довгому запуску Agent його журнал може перевищити цей ліміт, і повторний apply справної інсталяції помилково завершиться exit 1 «не вдалося прочитати журнал». Відтворено локально без systemd: verifyAgent бачить active і стабільний InvocationID; підставний journalctl через справжній realHost.run запускає дочірній Node, який друкує синтетичний accepted і 2 MiB заповнення. Команда повертає code=1, захоплено 1114112 байт, verification=false. Потрібно bounded читання/вибір потрібних подій і обмеження часу subprocess, зі збереженням правильної останньої heartbeat-події поточного invocation. Просто збільшити maxBuffer або обрізати загальний tail недостатньо: steady accepted пишеться один раз і може бути старішим за багато інших записів. Regression: великий журнал з раннім accepted, останній unauthorized після accepted, багато сторонніх подій, зміна invocation, bounded ресурси/час і жодних сирих журналів у звіті.

**Незалежно на Node.js 22:** check:local exit 0 — 130 unit, 500 backend, 10 smoke, 165 Agent (3 opt-in пропущені), 247 frontend, 91 installer, typecheck/lint/secrets/збірки. Додаткове відтворення — тимчасовий TS-сценарій поза репозиторієм, FakeHost для systemd metadata + справжній realHost.run для переповнення stdout. Системні служби, користувачі й конфігурації хоста не змінювались.

**Межі:** чиста Ubuntu VM, справжні systemd InvocationID/journal-фільтри та повний Linux install досі не перевірені; INSTALLATION і звіт Claude це чесно позначають. Backend DB/E2E/UI Playwright не повторювались, runtime продукту не змінювався. Production, БД, Nginx, PM2 reviewer не змінював, інсталятори на чинних серверах не запускав; функціональний код не редагував. До закриття зауваження нових функцій і production-встановлення не починати.

## ADR-027: виправлення за review Codex (2026-10-20) — готово до повторного review Codex

Статус: **готово до повторного review Codex** (APPROVED не виставлявся). База: `0fb6501`, гілка `main`. Production, сервери, БД, Nginx, PM2 не змінювались; інсталятори на реальних серверах не запускались.

| # | Причина | Виправлення | Файли | Regression (старий код → новий) |
|---|---|---|---|---|
| P2 restart | ефекти (`restart`, `daemon-reload`) жили лише в пам'яті запуску; після збою до restart повтор вважав службу актуальною | durable стан `/var/lib/node-control-install/{server,agent}.json` (root 700/600, лише назви дій): намір записується до зміни ресурсу, прибирається після успішного reload/restart; `daemon-reload` — окремий durable ефект кроку unit; `plan` стан лише читає; пошкоджений/чужий стан — зупинка до змін | `state.ts` (новий), `engine.ts`, `cli.ts`, `resources.ts`, `server.ts`, `agent.ts` | API: збій `migrate status` після запису конфігурації; збій запису конфігурації після наміру; невдалий restart; збій очищення після restart; збій `daemon-reload`; Agent: збій exporter після груп/конфігурації; порядок «намір → зміна → restart → очищення»; збій запису наміру → ресурс не змінено; `plan` без змін стану; незмінений повтор без restart; стан без секретів, чужий/symlink/пошкоджений → зупинка |
| P2 heartbeat | перевірка читала останні 200 записів усіх запусків; старий `accepted` давав «підтверджено» | `InvocationID` служби → `journalctl _SYSTEMD_INVOCATION_ID=…` лише поточного запуску → останній результат heartbeat; зміна запуску під час перевірки — очікування нового; журнал недоступний → не підтверджено; без restart заради перевірки | `agent.ts` | старий accepted без нового → exit 1; старий accepted + поточний unauthorized → exit 1; зміна запуску під час перевірки; журнал недоступний; (проходили й раніше: старий unauthorized + новий accepted, очікування першого heartbeat, незмінений повтор без restart) |
| P2 UID 0 | `systemUser` перевіряв лише верхню межу UID і shell | preflight і крок користувача відхиляють UID 0 або основну групу root; обліковий запис не змінюється | `resources.ts`, `server.ts`, `agent.ts` | `nodecontrol` uid 0, `nodecontrol` з групою root, `nodecontrol-agent` uid 0 → зупинка без жодної зміни (і без стану); PM2 owner з іншим іменем і UID 0 → відмова; non-root системний обліковий запис попередньої спроби — приймається |

**Докази.** Новий `installer/test/recovery.test.ts` на коді `0fb6501`: 14 із 22 тодішніх тестів падали (усі три дефекти відтворено; ті, що проходили, — позитивні сценарії та вже правильна поведінка). Після виправлення — 24/24 (додано ще 2 тести меж наміру). FakeHost тепер моделює InvocationID (новий на кожен start/restart), журнал за запусками (`-u` повертає всі запуски, як справжній), збої запису файлів; записи стану ведуться окремо від системних змін.

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run test:installer` | 91/91 (було 70) |
| `npm run check:local` | exit 0: node:test 130/130, backend 500/500, smoke 10/10, agent 165/165 (+3 opt-in), frontend 247/247, installer 91/91, typecheck, lint, збірки, secrets |
| Пакування | `installer:build` — `state.js` у `installer/dist` (server-bundle копіює весь dist); `--help` обох CLI; імпорти лише `node:*` і власні модулі |
| `git diff --check`, `check:secrets` | перший запис ADR дав зайвий порожній рядок у кінці DECISIONS.md (виправлено); повтор OK |
| `test:backend:db`, UI Playwright, `test:e2e`, `test:integration` | не запускались: backend, frontend і БД не змінювались; integration — немає локального PostgreSQL |

**Документація:** INSTALLATION (вимоги до облікових записів, актуальне підтвердження Agent, розділ «Стан незавершених дій», rollback коду й старий інсталятор, сценарій майбутньої Ubuntu-перевірки), ADR-027 (датоване уточнення).

**Rollback.** Git — окремий revert commit. Інсталятор `668ec23`–`b0f8d1d` стану не знає: не використовувати його для продовження незавершеного запуску нової версії — спершу вручну виконати дії з файлу стану (INSTALLATION, розділ 4). Файл стану без секретів лишається на диску.

**Межі.** Наскрізного встановлення на чистій Ubuntu VM **немає** (погодженого ізольованого середовища немає; Docker заборонено; VM tooling не встановлювався). Перевірене встановлення на Linux не заявляється; сценарій прогону — INSTALLATION, розділ 8. Реальною системою не перевірені: InvocationID і фільтр журналу за `_SYSTEMD_INVOCATION_ID`, `useradd`/`systemctl`/`runuser`, права на Linux.

## Незалежний review Codex — ADR-027: CHANGES REQUIRED (2026-10-20)

Перевірено `668ec23`, `115ba7b`, `b0f8d1d` від бази `9a8be52`: інсталятори, host abstraction, release integration, тести, README/INSTALLATION/DEPLOYMENT/ADR і правила. Початкове дерево чисте. Повторне використання versioned release tooling і явний опис відсутності Ubuntu E2E відповідають напрямку завдання, але знайдено три дефекти:

1. **P2 — після часткового збою губиться потрібний restart.** `installer/src/cli.ts:44`, `installer/src/engine.ts:73`, `installer/src/resources.ts:165–168`: effects існують лише в пам'яті запуску. На FakeHost відтворено: успішне первинне apply → повтор з --behind-nginx дописує API_TRUSTED_PROXIES → штучний одноразовий збій migrate.js status до restart → наступний той самий apply повертає 0, changes=[], restart відсутній. Чинний процес лишається зі старою конфігурацією, health цього не виявляє. Те саме стосується Agent при додаванні можливостей і зупинці до restart. Потрібно переживати переривання й підтверджувати застосування змін процесом (безпечний durable pending state або еквівалент), не перезапускаючи справді незмінену інсталяцію. Regression: збій/Ctrl+C між config/group/unit і restart, повторний apply, завершений повтор без зайвого restart; документаційна обіцянка відновлення має відповідати коду.
2. **P2 — історичний heartbeat дає хибне підтвердження зв'язку.** `installer/src/agent.ts:198–202`: journalctl читає останні 200 записів без межі часу/поточного invocation, а accepted одразу завершує перевірку. Відтворено verifyAgent на FakeHost: active service і єдиний heartbeat з time=1, outcome=accepted → true і «зв'язок підтверджено», хоча поточних доказів немає. Після перевстановлення або зміни конфігурації можна отримати успіх за старим ключем/запуском до першого актуального звіту. Потрібно підтвердження від поточного запуску Agent у визначеному вікні часу; старі accepted/unauthorized не мають визначати результат нового запуску. Regression: історичний accepted без нового, новий unauthorized після старого accepted, очікування актуального accepted, повтор на незміненому активному Agent; не друкувати сирі журнали/секрети.
3. **P2 — service account із UID 0 вважається безпечним.** `installer/src/resources.ts:24`: перевіряється лише верхня межа UID і nologin, UID 0 не відхиляється. Відтворено FakeHost із nodecontrol uid=0 та /usr/sbin/nologin: serverMain apply повертає 0. systemd User=nodecontrol тоді означає root, усупереч мінімальним привілеям і правилам проєкту. Потрібно явно відхиляти UID 0 для service accounts до будь-яких мутацій, без зміни чужого користувача; tests для API/Agent і позитивний non-root system account.

**Незалежно, Node.js 22:** check:local exit 0 — 130 unit, 500 backend, 10 smoke, 165 Agent (3 opt-in пропущені), 247 frontend, 70 installer; typecheck/lint/secrets/збірки успішні. Три додаткові відтворення — тимчасовий TS-сценарій поза репозиторієм з чинним FakeHost; реальні користувачі/systemd/файли хоста не змінювались. Code → Docs / Docs → Code: інструкції повторного запуску й актуального підтвердження Agent потребують узгодження з виправленнями; INSTALLATION чесно позначає неперевіреність чистої Ubuntu.

**Межі й наступна перевірка:** наскрізне встановлення на чистій Ubuntu VM не виконано ні Claude, ні reviewer; 70 тестів не підтверджують useradd/systemd/runuser, Linux ownership і фактичний запуск установчих маршрутів. Потрібен окремий погоджений ізольований Linux-прогін перед заявою про перевірене встановлення. Production, БД, Nginx і PM2 не змінювались; інсталятори на чинних серверах не запускались. Backend DB/E2E/UI Playwright не повторювались (runtime код не змінений). Функціональний код reviewer не редагував. Нових функцій і production-встановлення до закриття зауважень не починати.

## Інсталятори й документація self-hosted встановлення (2026-10-20, ADR-027) — готово до незалежного review Codex

Статус: **готово до незалежного review Codex** (APPROVED не виставлявся). База: `9a8be52`, гілка `main`. Production, сервери, БД, Nginx і PM2 не змінювались; інсталятори на реальних серверах не запускались. APPROVED виправлення Slack/alerts цим завданням не деплоїлись.

**Що зроблено.** Новий TypeScript-проєкт `installer/` (лише вбудовані модулі Node.js): `server.js` (Central API) і `agent.js` (Agent; опційно PM2 inventory і broker), команди `plan` (без змін) / `apply` (повторюваний) / `--help`, для сервера також `nginx-config` (лише вивід конфігу). Інсталятори використовують наявні `server-release.js` (prepare/config/activate), `migrate.js` (до активації), `bootstrap-admin.js` і units із релізу; власної системи релізів немає. `build-release.js` збирає `installer/dist` в обидва артефакти й у `server-bundle/install/`. Документація: нова [INSTALLATION](INSTALLATION.md) — єдине джерело для встановлення, Agent, allowlist, повторних запусків, відновлення, секретів і діагностики; README (короткий маршрут), DEPLOYMENT (посилання, склад артефакту), ARCHITECTURE, DEVELOPMENT_RULES, AGENTS, ADR-027.

**Гарантії (перевірені тестами на змодельованому хості).**
- **Preflight до будь-яких змін:** root, Ubuntu, systemd, Node 22 у `/usr/bin/node`, утиліти, SHA-256 артефакту, чужі файли в каталозі релізів, інший активний реліз, права й ключі файлів секретів, TCP до PostgreSQL / HTTPS до API, PM2 owner і `PM2_HOME`, членство Agent в основній групі owner.
- **Порядок кроків:** користувач → каталоги → реліз → конфігурація → unit (verify до встановлення) → активація → служба.
- **Наявне не змінюється:** конфігурації лише доповнюються відсутніми ключами з резервною копією 600; секрети не ротуються; чужі користувачі, файли, units і allowlist — конфлікт без перезапису; БД із наявною схемою — зупинка (це оновлення); нічого не видаляється.
- **Секрети:** лише з файлу (root, 600), stdin або прихованого вводу; не в argv і не у виводі.
- **PM2:** жодної команди `pm2`; allowlist створюється порожньою.
- **Результат** окремо звітує «служба запущена», «health пройдено» і «зв'язок Agent підтверджено».

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 130/130 (+1 тест server-bundle), backend 500/500, smoke 10/10, agent 165/165 (+3 opt-in), frontend 247/247, **installer 70/70**, typecheck, lint, збірки (у т.ч. `installer:build`), secrets |
| `git diff --check` | перший прогін — зайвий порожній рядок у кінці DECISIONS.md (виправлено), повтор OK |
| Скомпільований CLI на macOS (не root, не Ubuntu) | `--help` і `nginx-config` працюють; `plan` зупиняється в перевірках без змін (exit 1) |
| `test:backend:db`, UI Playwright, `test:e2e` | не запускались: backend, frontend і схема БД не змінювались; результати 2026-10-19 — історичні |
| `npm run test:integration` | не запускався: немає локального PostgreSQL на `127.0.0.1:5432` |

**Обмеження.** Наскрізне встановлення на **чистій Ubuntu VM не виконано**: засобів VM у цьому середовищі немає (Docker заборонено, production-сервери для тестів не використовуються). Тому маршрут **не підтверджений end-to-end**, і точна версія Ubuntu не заявляється. Реальною системою не перевірені: `useradd`/`groupadd`/`usermod`, `systemctl`, `systemd-analyze`, `runuser`, `chown` на інших користувачів, приховане введення в TTY, фактичні права після `prepare` на Linux. Інсталятори призначені лише для нових інсталяцій; наявні оновлюються за DEPLOYMENT.

Наступний крок після review: наскрізний прогін `plan`/`apply`/повтор/частковий збій на чистій погодженій Ubuntu VM і фіксація перевіреної версії.

## Фінальний незалежний review Codex — стабілізація Slack/alerts: APPROVED (2026-10-19)

Перевірено `a877c8c`, `a592f10`, `68d03cb` від бази `daa6337`, пов'язані transport/worker/store/API-тести й документацію. Початкове дерево чисте. Обидва залишкові P2 закрито: oversized має окремий результат і не підтверджує sent за префіксом; reminder закритого інциденту не отримує наступну спробу після retry або expired lease, терміналізується як cancelled/superseded і не затримує recovery своїми повторами. Володіння claim зберігається, запізнілий finish не відновлює скасований запис. Перевірені попередні regression для порядку подій і generation проходять. Нових блокувальних зауважень у межах цього циклу стабілізації не виявлено.

**Code → Docs / Docs → Code:** описані класифікація oversized/interrupted, worker і разовий admin test, reminder під час resolve, термінальні коди, межа для поточної HTTP-спроби й сумісний rollback. Документація відрізняє майбутні повтори від запиту, який уже міг бути надісланий; гарантія для claim після коміту resolve відповідає реалізації. Нових статусів, міграцій чи залежностей немає, сторонні компоненти не змінені.

**Незалежно на Node.js 22:** check:local exit 0 — 129 unit, 500 backend, 10 smoke, 165 Agent (3 opt-in пропущені), 247 frontend, typecheck/lint/secrets/збірки. Real-DB `alerts-recovery`, `alerts`, `settings` — 44/44, власні тимчасові схеми ізольованої тестової БД через SSH-тунель. Додатково повторено попереднє потокове відтворення: Response 200, chunks `ok` і 1025 байт `x` → permanent/unexpected_response, assertion проходить.

**Межі:** повний real-DB suite, UI Playwright, E2E проти backend, infrastructure integration, real-PM2 і фактичний production rollback у цьому фінальному повторі не запускались; результати Claude нижче історичні. Frontend/Agent не змінені. Task 001 не отримує нового підтвердження серверних перевірок. Production, справжній Slack і PM2 reviewer не змінював, функціональний код не редагував. APPROVED завершує цей цикл виправлень Slack/alerts; не означає фактичного деплою або загальної готовності продукту до production. Подальший деплой — окреме завдання за DEPLOYMENT.

## Сповіщення: два залишкові дефекти за повторним review (2026-10-19) — готово до повторного review Codex

Статус: **готово до повторного review Codex** (APPROVED не виставлявся). База: `daa6337`, гілка `main`. Production не змінювався; справжні Slack-повідомлення не надсилались (синтетичні потоки, mock-транспорт, синтетичні webhook). Міграцій, залежностей, змін frontend, Agent/broker і алгоритму рестартів немає.

| # | Причина | Виправлення | Файли | Regression (старий код → новий) |
|---|---|---|---|---|
| P2 oversized | `readBounded` після перевищення 1 KiB повертав `complete` з префіксом, тож `ok` + понад 1024 байт давало `sent` | три результати читання: complete, oversized, interrupted; `sent` — лише повне 200 `ok`; oversized 2xx → `failed`/`unexpected_response`, 4xx → `http_<status>` (код Slack із завеликого тіла не довіряється); interrupted 2xx → `unknown`; 429/5xx — за статусом | `slack.ts` | transport (окремий chunk `ok` + 1025, один chunk, побайтово, рівно 1024 / 1025, повні `ok`, обрив після `o`/`ok`, 429/502/404), worker (`failed`, не `sent`), API тест (`failed`, 1 виклик): 4 падали → проходять |
| P2 reminder | при resolve скасовувались лише queued reminders; reminder у польоті після retry повертався в чергу й видавався знову, а recovery чекав його повторів | `claim` не видає reminder закритого інциденту й скасовує queued і протерміновані (`superseded`); `finish` з повтором для такого reminder у тому самому операторі, що й перевірка володіння, робить `cancelled`/`superseded` | `store.ts` | real-DB через справжні claim/finish: retry 0 і 600 с, протермінований lease + запізнілий finish, cleanup без участі evaluation, активний reminder і незалежний інцидент, worker з реальним store: 6 падали → проходять; фінальні sent/unknown/failed і «retry до resolve» — проходили й раніше (закріплення) |

**Семантика.** Oversized — повна, але неочікувана відповідь, а не мережевий збій. Reminder після resolve: нова спроба не починається, але поточна HTTP-спроба не відкликається — її фінальний результат записується як є, і recovery чекає лише на неї (≤ lease чи HTTP-тайм-аут). Межа гарантії: claim, що почався після коміту resolve, reminder закритого інциденту не видає; claim, конкурентний із комітом, може почати одну спробу, яка вважається поточною. Коди `cancelled` для діагностики — у DEPLOYMENT.

**Сумісність і rollback.** Нових статусів чи колонок немає; `cancelled`/`superseded` існували раніше. Попередній реліз (`4ca012d` / production `b8959a7`) читає ці записи як звичайні термінальні. Після rollback повертається поведінка з дефектами: `ok` + oversized → `sent`; reminder у польоті після resolve може повторюватись.

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | перший прогін **exit 1**: lint (`no-base-to-string`) у новому real-DB тесті, виправлено; повтор exit 0: node:test 129/129, backend 500/500, smoke 10/10, agent 165/165 (+3 opt-in), frontend 247/247, typecheck, lint, збірки, secrets |
| `npm run test:backend:db` (ізольована тестова БД, тимчасові схеми) | 129/129; після lint-правки `alerts-recovery` окремо 28/28; залишкових схем `nc_test_*` — 0 |
| `npx playwright test -c e2e/ui.config.ts` | 26/26 (frontend не змінювався; прогнано для повноти) |
| `npm run test:e2e` (ізольований backend, включно з `alerts.spec`, без Slack) | 18/18 (+1 opt-in) |
| `npm run test:integration` | не запускався: PostgreSQL на локальному `127.0.0.1:5432` відсутній (порт закритий) |
| `git diff --check`, `check:secrets` | OK |

**Деплой не виконувався.** План (після APPROVED): штатний versioned artifact `build-release.js` для фінальної revision → `sha256sum -c`, manifest → `prepare` → `migrate status` (pending=0) → `activate` → restart лише `node-control-api` → systemd active, live/ready 200, журнал без нових `error`/`fatal` і без секретів, черга в UI без помилок. Rollback: `server-release.js rollback` на `b8959a7` + restart `node-control-api`; БД не відкочується; обмеження — абзац вище.

Ризики: recovery може затримуватись на одну поточну спробу reminder (≤ HTTP-тайм-аут, на практиці ≤ lease 60 с); конкурентна з евалюацією зміна того самого рядка outbox може дати serialization failure у REPEATABLE READ — evaluation повторюється наступним тактом (поведінка не нова).

## Повторний незалежний review Codex — Slack/alerts: CHANGES REQUIRED (2026-10-19)

Перевірено `e74979c`, `1d36be0`, `58d32c6`, `4ca012d` від бази `bd62f64`; початкове дерево чисте. Попередні сценарії виправлено: backoff/lease більше не дають recovery обігнати firing, announced обмежено generation, обрив тіла після headers оброблено як unknown, довгі вікна рестартів зберігають span у bounded samples, неточність про повтор unknown уточнено. Перевірено документацію Code → Docs / Docs → Code, опис thinning, формату стану й обмежень rollback. Залишились два відтворені дефекти:

1. **P2 — oversized відповідь може помилково підтвердити успіх.** `backend/src/alerts/slack.ts:94–101`: після перевищення MAX_RESPONSE_BYTES читання скасовується, але повертається `complete: true` з попередніми chunks. Синтетичний ReadableStream у Response 200: перший chunk `ok`, другий — 1025 символів `x`; фактичний результат sendToSlack — `{kind: 'sent'}`. Повна відповідь не є `ok`, тіло перевищує ліміт; документація обіцяє unexpected_response. Потрібно окремо передавати ознаку oversized та не використовувати збережений префікс як підтвердження успіху; regression для різного поділу на chunks, у т.ч. `ok` до перевищення ліміту, і для worker/admin test.
2. **P2 — повтор reminder після закриття інциденту.** `backend/src/alerts/store.ts:208–209,275–292`: при recovery скасовуються лише queued reminder. Якщо reminder був sending і після recovery finish повернув його в queued (наприклад, http_500), наступний claim знову видає reminder для resolved інциденту. Незалежний real-DB regression: firing sent → reminder claimed → recover → finish(reminder, queued/http_500) → claim повертає reminder з incident.resolution=recovered. Залежність старших записів додатково затримує recovery на повтори вже неактуального reminder. Потрібно не повторювати застарілі reminders після resolve (включно з lease expiry/retry), переводити їх у термінальний стан й розблоковувати recovery, не заявляючи можливість відкликати вже надісланий HTTP-запит. Regression: retry після resolve, expired lease, повторні claim/finish та reminder активного інциденту; документація має відповідати точним гарантіям.

**Незалежні перевірки, Node.js 22:** check:local exit 0 — 129 unit, 491 backend, 10 smoke, 165 Agent (3 opt-in пропущені), 247 frontend; typecheck/lint/secrets/збірки успішні. Real-DB `alerts-recovery`, `alerts`, `settings` — 34/34 (ізольована тестова БД, власні тимчасові схеми). Окремий тимчасовий real-DB regression поза репозиторієм — 1 падіння, яке підтверджує пункт 2; потокове відтворення пункту 1 виконано окремо через compiled sendToSlack, лише синтетичні дані.

**Межі:** повний real-DB suite, UI Playwright, E2E проти backend, infrastructure integration, real-PM2 та фактичний запуск старого релізу для rollback у цьому повторному review не запускались; відповідні звіти Claude нижче — історичні. Production, Slack і PM2 не змінювались; функціональний код reviewer не редагував. Нові функції й production-деплой до закриття зауважень не починати.

## Сповіщення: виправлення за review Codex від 2026-10-19 — готово до повторного review Codex

Статус: **готово до повторного review Codex** (APPROVED не виставлявся). База: `bd62f64`, гілка `main`. Production не змінювався; справжні Slack-повідомлення не надсилались (лише локальний TCP або mock-транспорт, синтетичні webhook і ключі). Міграцій, нових залежностей, змін Agent/broker/frontend немає.

| # | Зауваження | Виправлення | Файли | Regression (до → після) |
|---|---|---|---|---|
| 1 | P2: recovery обганяє проблему | `claim` видає recovery/reminder лише після того, як повідомлення про проблему тієї самої generation стало `sent`/`unknown` і жоден старіший запис інциденту не в `queued`/`sending`. Неоголошувані (`failed`/`cancelled`/`dropped`/інша generation) → `cancelled`, `problem_not_announced`. Reminder, що чекає, при відновленні → `superseded` | `store.ts` | real-DB `alerts-recovery`: backoff, in-flight, lease, retry, failed, unknown, cancelled, конкурентні claim + незалежний інцидент, без дублів: 6 падали → проходять |
| 2 | P2: recovery у нову generation | право на recovery і reminder — лише за проблемою тієї самої generation | `store.ts` | sent/unknown старої generation, remove + configure, sending, скасований заміною, та сама generation: 4 падали → проходять |
| 3 | P2: обрив тіла відповіді → `failed` | `readBounded` повертає ознаку повноти; недочитане тіло 2xx/3xx → `unknown` (`connection_lost`/`timeout`/`aborted`); 429/5xx/4xx — за статусом; повна некоректна/завелика відповідь — як раніше | `slack.ts` | локальний TCP (обрив, timeout, abort після headers; повні 200/некоректна/oversized/404/429/500), worker (повтор unknown, на останній спробі `unknown`), API тестового повідомлення (`unknown`, 1 виклик): 5 падали → проходять |
| 4 | P2: довге вікно рестартів не відновлюється | ≤ 64 точки на все вікно (проріджування з найближчими сусідами; anchor і найновіша точка зберігаються); формат jsonb той самий | `rules.ts`, `store.ts` | 120 хв/30 с, накопичення за межами 64 вибірок, коротке вікно (точно), 2/600/1440 хв × 10/30/60/300 с, 2 доби з частими рестартами, reset/identity, null, стан попереднього релізу: 10 падали → проходять |
| 5 | P3: «unknown без повтору» | датоване уточнення в записі 2026-10-17; ADR-021 і DEPLOYMENT розділяють тестове повідомлення (без повтору) і worker (обмежені повтори, можливі дублікати) | docs | — |

**Часова семантика рестартів.** delta = лічильник зараз − лічильник у anchor, де anchor — найновіша збережена точка перед `now − window`. Problem: delta ≥ порогу й anchor не старіший за 1,5 вікна. Recovery: delta = 0 і anchor не новіший за `now − window`. Поки вибірок не більше 64 (наприклад, типові 10 хв при 30 с), обчислення точне, як раніше. Для довших вікон anchor може бути старішим за межу не більше ніж на ≈ 2·вікно/63 (≈ 3 %; 24 год → ≈ 46 хв): можуть бути враховані трохи раніші рестарти, а recovery може настати на стільки ж пізніше. Стан ≤ 64 × ≈ 50 байт на процес. Скидання лічильника чи зміна identity задають нову базу; null і повторний sample нічого не додають; відсутні дані не означають recovery.

**Сумісність і rollback.** Новий код читає стан попереднього релізу: тест показує завершення інциденту через одне вікно від найстарішої збереженої точки. Попередній реліз читає новий стан без помилок (перевірено тимчасовим тестом поза commit на коді `bd62f64`): формат і межа 64 ті самі, але він повертається до старої поведінки — довгі вікна не відновлюються, recovery знову може обігнати проблему. Записи `cancelled` з `problem_not_announced`/`superseded` старий код вважає звичайними термінальними. Відкат БД не потрібен.

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | перший прогін **exit 1**: lint (`no-unnecessary-condition`, 4 помилки) у новому real-DB тесті — виправлено; повтор exit 0: node:test 129/129, backend 491/491, smoke 10/10, agent 165/165 (+3 opt-in), frontend 247/247, typecheck, lint, збірки, secrets |
| `npm run test:backend:db` (ізольована тестова БД через SSH-тунель, тимчасові схеми) | 119/119; після lint-правки `alerts-recovery` окремо 18/18; залишкових схем `nc_test_*` — 0 |
| `npx playwright test -c e2e/ui.config.ts` | 26/26 |
| `npm run test:e2e` (ізольований backend, без Slack) | 18/18 (+1 opt-in) |
| `npm run test:integration` | не запускався: передумова — PostgreSQL на локальному `127.0.0.1:5432` — відсутня (порт закритий); на інше середовище не спрямовувався |
| `git diff --check`, `check:secrets` | OK |

**Деплой не виконувався.** План (лише після APPROVED і окремого завдання): `build-release.js` для фінальної revision → `sha256sum -c`, manifest → `prepare` → `migrate status` (pending=0, міграцій немає) → `activate` → restart лише `node-control-api` → systemd active, live/ready 200, журнал без нових `error`/`fatal` і без секретів, у UI «Сповіщення» стан черги без помилок. Rollback: `server-release.js rollback` на `b8959a7` + restart `node-control-api`; БД не відкочується; наслідки — абзац вище.

Ризики: похибка довгого вікна до ≈ 3 %; recovery і reminder можуть затримуватись на час повторів проблеми (до «Макс. спроб» з backoff ≤ 30 хв); для проблем, оголошених у старий webhook, recovery після заміни не надсилається (свідомо, без повторного оголошення).

## Незалежний review Codex — Slack/alerts: CHANGES REQUIRED (2026-10-19)

Перевірено `4cc7c5f`, `3719378`, `896b79b` від бази `bba57a7`, пов'язані чинні worker/rules/settings, тести й документацію Code → Docs / Docs → Code. Початкове дерево чисте. Нової функціональності до APPROVED не починати; production-деплой не погоджений.

1. **P2 — recovery обганяє проблему.** `backend/src/alerts/store.ts:185,246–262`: recovery дозволено для queued/sending firing, але claim не враховує залежності подій інциденту. Відтворено в тестовій БД: firing з `next_attempt_at = now() + 10 minutes`, потім recovery; `claim(5, 1)` повертає лише `resolved`. Канал спершу бачить відновлення, а проблему — пізніше або ніколи. Потрібно забезпечити залежність доставки, включно з backoff, in-flight/lease і остаточним failed/cancelled firing; одного ORDER BY недостатньо. Regression має проходити через claim/delivery, а не лише перевіряти порядок INSERT.
2. **P2 — recovery у новий канал без повідомлення про проблему.** `backend/src/alerts/store.ts:184–186`: announced-запит не фільтрує generation. Відтворено: firing sent у generation 1 → configureSlack generation 2 → recovery → `claim(5, 2)` повертає `resolved`. Потрібно прив'язати право на recovery до оголошення проблеми в поточній generation; покрити sent/unknown старої generation, видалення й повторне налаштування інтеграції. Чинне пояснення про новий канал у коментарі й документації гарантується лише для скасованих pending-повідомлень.
3. **P2 — обрив читання відповіді помилково остаточний.** `backend/src/alerts/slack.ts:78–95,132–140`: readBounded ковтає помилку потоку й повертає порожній рядок, тож нова класифікація catch(fetch) не охоплює збій після headers. Реальний локальний TCP transport: отримано запит, відповідь `200 OK`, Content-Length 2, тіло лише `o`, обрив → `{kind: permanent, code: unexpected_response}`. Доставка могла відбутися, але worker припиняє повтори, а тестове повідомлення показує failed замість unknown. Потрібно зберігати результат/причину читання тіла й коректно класифікувати обрив, timeout та abort після headers; додати transport/API regression без Slack.
4. **P2 — довге вікно рестартів не відновлюється.** `backend/src/alerts/rules.ts:128–137`, `backend/src/alerts/store.ts:198`: обрізання до останніх 64 samples втрачає часовий baseline, а recovery вимагає span >= window. Детерміноване відтворення через compiled evaluate: вікно 120 хв (дозволений UI/API діапазон 2–1440), samples кожні 30 с, лічильник 0 → 3 і далі незмінний; після 200 хв opens=1, resolves=0, state=firing, збережений span=31,5 хв. Також втрачається можливість рахувати повне довге вікно. Потрібна обмежена за ресурсами репрезентація, що зберігає погоджену часову семантику, і тести довгого вікна, restart/serialization та відсутності нових рестартів; не просто збільшити необмежений масив.
5. **P3 — суперечність звіту поведінці unknown.** У записі стабілізації нижче сказано «unknown без повтору, ... не дубль». `backend/src/alerts/engine.ts` повторює unknown до maxAttempts (at-least-once), як правильно описано в DEPLOYMENT/ADR-021. Уточнити, що без автоматичного повтору лише разова тестова доставка; для черги можливі дублікати. Виправити актуальні інструкції за результатами пунктів вище, історичні факти не підміняти.

**Незалежні перевірки, Node.js 22:** `check:local` exit 0 — 129 unit, 465 backend, 10 smoke, 165 Agent (3 opt-in пропущені), 247 frontend, typecheck/lint/secrets/збірки; UI Playwright 26/26; повний real-DB suite 107/107 (ізольована тестова БД, тимчасові схеми). Додатковий тимчасовий real-DB набір поза репозиторієм: 6 штатних regression пройшли, 2 незалежні сценарії пунктів 1/2 впали з фактично виданим `resolved`. Повторний паралельний запуск цього набору не відбувся: тунель уже закрився, beforeAll не підключився; це не доказ дефекту й не успішний прогін. Локальне TCP-відтворення пункту 3 та чиста симуляція пункту 4 виконані окремо, без зміни коду продукту.

**Межі:** production, справжній Slack і PM2 не змінювались; E2E проти backend, старий infrastructure `test:integration` та real-PM2 у цьому review не повторювались. Відоме обмеження старого integration suite — потреба PostgreSQL на локальному хості; результати Claude нижче історичні. Функціональний код reviewer не редагував, зміна лише в записі review.

## Сповіщення (Slack/alerts): перевірка та стабілізація перед review (2026-10-17) — готово до незалежного review Codex

Статус: **готово до незалежного review Codex** (APPROVED не виставлявся). Початкова revision: `bba57a7`, гілка `main`. Нової функціональності, міграцій, змін Agent/broker немає; виведені серверні метрики й правило `server_memory` не повертались. Production не змінювався, справжні Slack-повідомлення не надсилались (лише mock або локальний TCP-транспорт, синтетичні webhook і ключі).

**Перевірено за кодом і тестами:** правила (offline/stale/unknown, PM2 CPU > 100 % на багатоядерних серверах, restarts delta і зменшення лічильника, гістерезис, підтвердження, той самий sample не рахується, відсутні дані ≠ recovery, cooldown, reminders), перезапуск API без дублів, видалення/деактивація сервера, виведене правило не відкривається й не доставляється; черга (транзакційність, dedupe, `FOR UPDATE SKIP LOCKED`, lease, межі, класифікація success/retry/permanent/unknown, 429/5xx/timeout, обмежені повтори, вимкнення engine/delivery, generation webhook, graceful shutdown, at-least-once без заяви про exactly-once); безпека (лише admin, RBAC/Origin/CSRF/схеми, audit без секретів, optimistic concurrency, env не перезаписує збережені налаштування, webhook не повертається й не логується, AES-256-GCM з AAD generation і версією ключа, строгий URL, без redirect, обмежені timeout/відповідь, безпечний текст); UI налаштувань (завантаження, помилки, конфлікт, прихований webhook, результати тестового повідомлення, подвійне надсилання).

**Виправлені дефекти (з regression):**

1. *Recovery для неоголошеної проблеми* (`store.ts`). Recovery ставився в чергу, якщо повідомлення про проблему не було `dropped` — зокрема для `cancelled` (webhook замінено або доставку вимкнено: новий канал проблеми не бачив) і `failed` (постійна помилка). Тепер — лише якщо проблема `queued`/`sending`/`sent`/`unknown`. Новий real-DB `alerts-recovery.test.ts`: до виправлення 3 з 6 падали, після — 6/6.
2. *Обрив з'єднання після надсилання вважався «не доставлено»* (`slack.ts`). Будь-яка мережева помилка fetch давала `retry/network` (повтор і для тестового повідомлення — «не надіслано»), хоча запит міг дійти до Slack. Тепер `retry/network` — лише коли запит точно не пішов (DNS, відмова з'єднання, недосяжна мережа, timeout з'єднання, TLS); обрив/reset/невідома причина → `unknown/connection_lost`. Новий `alerts-transport.test.ts` (справжній Node fetch проти локального TCP-сервера; тіло запиту фактично отримане перед обривом): до виправлення 2 з 13 падали, після — 13/13. Оновлено тести, що закріплювали стару семантику (`alerts-delivery`, `settings-api`), додано UI-тест: результати `failed/network` і `unknown/connection_lost` ніколи не показуються як «успішно».
3. *Документація:* DEPLOYMENT описував застарілі env-прапорці вмикання й rollback на `e8f61c5`, несумісний після ADR-023/ADR-025. Виправлено; додано розділи про канал (прив'язка webhook до каналу, приватний канал), чергу й результати, діагностику без секретів. Ротацію ключа не описано — її немає в коді. ADR-021/022 — датовані уточнення.

Додано також тести правил на CPU > 100 % і гістерезис (проходять і на старому коді — закріплення контракту).

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 129/129, backend 465/465, smoke 10/10, agent 165/165 (+3 opt-in), frontend 247/247; typecheck, lint, збірки, secrets |
| `npm run test:backend:db` (ізольована тестова БД, тимчасові схеми через SSH-тунель) | 107/107; залишкових схем `nc_test_*` після прогону — 0 |
| `npx playwright test -c e2e/ui.config.ts` | 26/26 |
| `npm run test:e2e` (тестовий backend, без Slack) | 18/18 (+1 opt-in) |
| `npm run test:integration` | **не виконано в цьому середовищі**: 10 з 12 падають з `ECONNREFUSED` на loopback:5432 — локального PostgreSQL немає (тести розраховані на хост з БД; 1 пропущений — потрібен root на хості PostgreSQL). Це проблема середовища, не дефект змін; production-БД для цього не використовувалась |
| `check:secrets`, `git diff --check`, пошук бренду | OK; OK; 0 |

**Деплой не виконувався.** План на майбутнє (лише після APPROVED і окремого завдання): `build-release.js` для нової revision → `sha256sum -c` і manifest → `prepare` → `migrate status` (очікується pending=0, міграцій немає) → `activate` → restart лише `node-control-api` → systemd status, live/ready, журнал без нових помилок і без секретів; налаштування сповіщень і webhook у БД не змінюються. Rollback: `server-release.js rollback` на `b8959a7` (сумісний layout, без відкату БД) + restart `node-control-api`. Після відкату повертається стара класифікація (обрив → повтор) і старе правило recovery.

Ризики/межі: класифікація мережевих помилок спирається на коди undici/Node — невідомий код консервативно вважається `unknown` (без повтору, можлива втрата одного повідомлення, але не дубль — _уточнення 2026-10-19 за review Codex: неточно; без автоматичного повтору лише разове тестове повідомлення, worker черги повторює `unknown` до «Макс. спроб», можливі дублікати (at-least-once), див. ADR-021_); reminders і далі ставляться для будь-якої не-`dropped` проблеми (не контрактно, задокументовано); перевірка UI на мобільних/темах — у межах наявних Playwright-сценаріїв.

## Незалежний review Codex — ADR-026: APPROVED (2026-10-17)

Перевірено реалізацію `756e370`, `0cbb453`, `a2f1d02`, `3b9553e` і документацію `b8959a7` / `e12bab2`; початкове дерево чисте. Блокувальних зауважень у межах завдання не виявлено. Перевірено компактну таблицю з однією панеллю, повторне використання керування та логів, відкладене завантаження вкладок, глобальний пошук із контекстом cursor, SQL-фільтрацію історії за сервером і ціллю до LIMIT, виправлення FormDialog. Документацію зіставлено з реалізацією в обох напрямках; обмеження історії та rollback описані.

Незалежно на Node.js 22: `check:local` exit 0 — 129 unit, 449 backend, 10 smoke, 165 Agent (3 opt-in пропущені), 245 frontend; typecheck, lint, secrets і збірки успішні. UI Playwright — 26/26. Окремий real-DB `application-search.test.ts` — 3/3: глобальний пошук і пагінація на 515+ записах, літеральний ввід і фільтри, план запиту, історія цілі до LIMIT та ізоляція серверів. БД — лише ізольована тестова, власні тимчасові схеми через SSH-тунель.

Межі: повний real-DB suite, E2E проти backend, real-PM2 та production UI/health у цьому review повторно не запускались; відповідні результати Claude нижче є історичними. Production, PM2 та функціональний код reviewer не змінював. APPROVED стосується ADR-026, а не загальної готовності продукту до production.

Оновлено: 2026-10-16 (застосунки: панель, inline-логи, історія, пошук; FormDialog — готово до review). Початковий commit: `ccbba13dbea512d962dbea5fbeb8bd1cd8b8a5eb` (`chore: initialize node control infrastructure`), гілка `main`, remote `origin`. Початкове робоче дерево чисте. Перевірка доступної історії охопила один commit; це не підтверджує актуальний стан remote або факт попереднього push.

> **Назви й шляхи в історичних записах (2026-10-16, ADR-025).** Продукт перейменовано на Node Control. У записах нижче шляхи встановлення наведено в чинних нейтральних назвах (`/opt/node-control`, `/etc/node-control/…`, `/opt/node-control-agent`, `/var/lib/node-control-pm2…`, `/run/node-control-pm2-broker`); на момент тих подій каталоги мали попередні назви з префіксом колишнього корпоративного бренду — точні значення є в історії Git і в units відповідних релізів. Revisions, результати й факти операцій не змінювались.

## Застосунки: розгорнута панель, inline-логи, історія цілі, пошук; виправлення FormDialog (2026-10-16, ADR-026) — готово до review Codex

Статус: **готово до review Codex** (APPROVED не виставлявся).

**FormDialog** (`756e370`) — закрито обидва відомі дефекти: поля під час підтвердження закриття справді приховані (`[hidden]` переважає `display` `.form-grid`) і `inert`, форма не надсилається (ні Enter, ні `requestSubmit`); «Повернутися до форми» повертає дані й фокус на поле, яке редагувалось. Regression: jsdom (на старому `Dialog.tsx` — падає) і браузер для створення сервера й користувача (на старому коді — 2 падіння «поля видимі»).

**API** (`0cbb453`): `GET /api/applications?q=` — літеральний підрядок назви без урахування регістру (`strpos(lower())`), trim, ≤ 128, без керівних символів, разом із фільтрами до `LIMIT`; cursor несе відбиток фільтрів (cursor іншого списку → 400; cursor, виданий раніше, — працює без пошуку). `GET /api/servers/:id/control-commands?targetKey=` — команди однієї цілі allowlist, фільтр у SQL до `LIMIT`. Міграцій немає; індекси не додавались.

**UI** (`ApplicationsPage`, `Inventory`/`ApplicationsTable`, новий `ApplicationDetail`, `LogViewer` → `LogTail` + dialog): поле «Пошук за назвою» (debounce 300 мс, `q` в URL, Back/Forward, «Очистити»); назва рядка — кнопка розгортання; одна панель (рядок `colSpan`); вкладки «Огляд» (дані рядка, без запитів), «Логи» (той самий обмежений перегляд, один цикл читання, лише на цій вкладці; «Переглянути логи» з меню відкриває її), «Історія дій» (лише для підтвердженої broker-цілі, ≤ 10 команд, scope ключа allowlist показано; без цілі — пояснення, без запиту); кнопки Start/Stop/Restart — ті самі пункти `rowMenu` (та сама перевірка перед POST, підтвердження, idempotency, ліміт 5 активних, tracking після згортання). Новий список/зниклий або перейменований рядок закриває панель; polling її не скидає; згортання повертає фокус на кнопку рядка. Сторінка сервера: modal-логи без змін.

Кількість запитів: розгортання — capabilities сервера (до 2 GET, кеш/дедуплікація ADR-024; повторно не запитуються в межах кешу); «Огляд» — 0; «Логи» — 1 цикл читання ADR-018 (POST + GET результату, автооновлення 5 с лише поки вкладка відкрита); «Історія» — 1 GET при відкритті й після прийнятої/завершеної команди цього сервера; polling-ів на рядок немає.

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 129/129, backend 449/449 (+3 API-тести пошуку/cursor/targetKey), smoke 10/10, agent 165/165 (+3 opt-in), frontend 245/245 (нові: `application-detail` 11, FormDialog 1), typecheck, lint, збірки, secrets |
| Real-DB `test:backend:db` | 101/101 (новий `application-search` 3: 515+ застосунків, пошук за межами першої сторінки, комбінації фільтрів, кирилиця, літеральні `%`/`_`/`\`, ін'єкційний ввід, 510 збігів посторінково без пропусків/дублів, план запиту — `Limit` над одним скануванням; історія цілі до `LIMIT`, той самий ключ на іншому сервері не змішується). Перший повний прогін: тест історії перевищив 15 с (14,8 с і окремо — 38 послідовних вставок через тунель); вставки переписано пакетно (7,9 с), повтор — 101/101 |
| `npx playwright test -c e2e/ui.config.ts` | 26/26 (новий `applications-detail` 5: 1440/390 × light/dark — пошук → панель → огляд/логи/історія, один додатковий рядок, логи в обмеженому блоці з власним scroll, без page overflow, stale/offline рядок із поясненням; клавіатура вкладок, повернення фокуса, порожня історія, довга назва, overlay-меню не змінює геометрію, підтверджена дія — рівно один POST) |
| E2E (тестовий backend) | 18/18 (+1 opt-in); `inventory.spec` — пошук і розгортання проти реального API |
| Real-PM2 E2E (opt-in) | 1/1 |
| `check:secrets`, `git diff --check`, пошук старого бренду | OK; 0 |

Обмеження: історія показується лише користувачам із `processes:control` (зіставлення через їхні capabilities); пошук регістронезалежний для кирилиці лише за UTF-8 `lc_ctype` БД; в одному ранньому UI-прогоні (без `caffeinate`) `row-menus` завис на 2,3 хв понад timeout тесту — у повторних прогонах зелено, причину не встановлено (ймовірне призупинення процесу).

**Деплой (2026-10-16).** Active API/UI: **`b8959a709e8f85d6aad51d0cfd3ace0b990f6e2e`**, previous — `2340c00` (сумісний; той самий layout шляхів). Штатно: `build-release.js` → `sha256sum -c` OK, manifest 65 файлів без помилок, `frontend/dist` і міграції = тестована збірка → `prepare` → `migrate status` applied=9 pending=0 (міграцій немає) → unit без змін → `activate` → restart лише `node-control-api`. Після: systemd active, live/ready 200, warning/error/fatal у журналі API — 0; публічний сайт віддає новий bundle (з пошуком), `/applications?q=` 200, `/api/applications?q=` без сесії 401; nginx і PostgreSQL active. Agent/broker/exporter не передеплоювались; PM2-процеси керованої ноди без змін (PID і час старту). Login у production не виконувався, керуючих команд і читання логів застосунків не було — авторизований UI оператор перевіряє вручну без дій.

**Rollback:** `server-release.js rollback` (→ `2340c00`) + `systemctl restart node-control-api`; міграцій і відкату БД немає. Попередній UI не має пошуку й панелі; API-параметри `q`/`targetKey` попередній API відхиляє (400) — новий UI після відкату не залишається (статика з того самого релізу). Не повертатися на pre-ADR-023 `c016beb`.
## Фінальний незалежний review Codex — ADR-025: APPROVED (2026-10-16)

Перевірено фікс `c2fff84` і документацію `2022a18`; початкове дерево чисте. Попередній alias-P2 закрито: preflight перевіряє фактичний об'єкт і точну ціль symlink, чужі об'єкти відхиляються до змін; перед деструктивними кроками передумови перевіряються повторно. Regression охоплює непорожній/порожній каталог, файл, чужий та dangling symlink, незмінність env/state/layout при відмові, finalize, interrupted/repeated rollback, legacy-state і зміну після перевірки. Попередні фікси збереження env і захисту metadata збережено. Нових зауважень у переглянутому diff не знайдено.

Незалежно на Node.js 22: check:local exit 0 — 129 unit (у т.ч. 39 тестів міграції), 446 backend, 10 smoke, 165 Agent (+3 opt-in пропущені), 233 frontend; typecheck/lint/secrets/збірки успішні. Обидва артефакти `c2fff84` перевірені: SHA-256 збігаються із sidecar і документацією, manifests валідні (API 65, Agent 35), migration tool і бібліотека побайтово відповідають source. Code → Docs / Docs → Code для alias/recovery узгоджені, локальні файлові посилання шести головних документів цілі (anchors не перевірялись); у tracked-іменах/вмісті збігів старого бренду немає.

UI Playwright 19/19 з попереднього незалежного review належать незміненому UI; заново браузерні suite, Linux sandbox, production dry-run, real-DB і real-PM2 в цьому проході не виконувались. Linux і stress-результати Claude нижче не видаються за незалежно повторені. Production не змінювався; runtime API/Agent залишився без змін від alias-фікса. Рекомендований інструмент для майбутнього rollback — `c2fff84`; попередні версії з відомими дефектами не використовувати.

APPROVED закриває ADR-025 і його review-фікси, не загальну production-готовність. Release blockers і окремі дефекти FormDialog лишаються відкритими. Reviewer змінює лише цей запис; функціональний код і production не змінювались. Попередні CHANGES REQUIRED нижче — історія вже виправлених зауважень.

## Повторний незалежний review Codex — ADR-025: CHANGES REQUIRED (2026-10-16)

Перевірено `d7ee0cc`, `3dcd90b`, `9f7af27`; початкове дерево чисте. Попередні два P2 (затирання незалежних env-змін і перенесення metadata) виправлені в передбачених сценаріях; нові regression перевіряють ці гарантії й legacy-state. Синхронізація browser polling тепер чекає response.

**Новий P2 — змінений alias не розпізнається як конфлікт до rollback.** `scripts/deploy/lib/path-migration.js:335`: перевірка існуючого source пропускає конфлікт, якщо в журналі є alias-крок для цього шляху, навіть коли шлях уже не є очікуваним symlink. Відтворено лише в тимчасовому каталозі: apply із rewrite та alias → alias замінений звичайним непорожнім каталогом → `rollback --dry-run` успішний → реальний rollback змінює env, потім падає з ENOTEMPTY на rename. Сторонній файл не видалено, але конфігурація вже змінена. Потрібно перевіряти фактичний тип і точну ціль усіх alias до будь-яких змін; звичайний каталог/файл/чужий symlink має давати відмову і в dry-run, і в реальному rollback зі збереженням env, журналу та layout. Це також потрібно для відповідності гарантії DEPLOYMENT «за конфлікту — відмова до будь-якої зміни».

Незалежно на Node.js 22: check:local exit 0 — 117 unit, 446 backend, 10 smoke, 165 Agent (+3 opt-in пропущені), 233 frontend; typecheck/lint/secrets/збірки успішні. UI Playwright 19/19. Перевірено обидва артефакти `3dcd90b`: SHA-256 збігаються з sidecar і звітом, manifests валідні (API 65, Agent 35), migration tool та його бібліотека побайтово відповідають source. Перевірено Code → Docs / Docs → Code для recovery й metadata; локальні файлові посилання шести головних документів цілі (anchors не перевірялись). Linux sandbox, stress-серії Claude, production dry-run, real-DB і real-PM2 заново не виконувались; наведені нижче результати Claude не є поточними незалежними перевірками.

Функціональний код і production reviewer не змінював; reproduction використовував лише синтетичні файли, тимчасовий каталог видалено. Змінено лише цей запис. До APPROVED нову функціональність не починати.

## Незалежний review Codex — ADR-025: CHANGES REQUIRED (2026-10-16)

Перевірено `14daaca`, `a79b8d9`, `2340c00` і звіт `aa1dcde`; початкове дерево чисте. Відкриті два P2 у новому інструменті міграції:

1. **Rollback затирає зміни env після міграції.** `scripts/deploy/lib/path-migration.js:203` відновлює весь файл із початкового backup. Відтворено в тимчасовому каталозі: apply переписує path у agent.env → синтетичний токен змінено → rollback повертає попередній токен. Це суперечить вимозі зберегти актуальні секрети/нові дані й обіцянці повного rollback у DEPLOYMENT. Потрібне відновлення лише мігрованих посилань зі збереженням інших актуальних значень або явна відмова до перезапису при конфлікті; regression для ротації токена/інших змін env.
2. **Preflight дозволяє перенести власний журнал.** `scripts/deploy/lib/path-migration.js:141–150` перевіряє для state/backup лише абсолютність. Відтворено `--state` усередині source-каталогу: plan дозволяє, apply переносить каталог і падає з ENOENT при збереженні state; журнал уже не за вказаним шляхом. Потрібно до будь-яких змін відхиляти перетин metadata (state/backup) із move/alias/rewrite targets, урахувати resolved/symlink paths; перевірити відсутність змін після невдалого preflight.

Незалежно на Node.js 22: check:local exit 0 — 104 unit, 446 backend, 10 smoke, 165 Agent (+3 opt-in пропущені), 233 frontend; typecheck/lint/secrets/збірки успішні. У tracked-іменах/вмісті та frontend/dist збігів старого бренду немає. UI Playwright: 18/19; command-limit впав на очікуванні кількості GET після page.clock.runFor (0 замість >0); окремий повтор цього тесту 1/1. Причина нестабільності не встановлена, весь UI-прогін успішним не вважається. Real-DB, real-PM2, Linux migration sandbox та фактичний production rollback у цьому review не виконувались; результати Claude нижче історичні.

Read-only SSH: API і Agent current `2340c00`; API/Nginx та Agent/broker/exporter timer active, API ready успішний. Reviewer не змінював production або функціональний код; два reproduction-сценарії виконано лише в тимчасових каталогах із синтетичними значеннями, каталоги видалено. Змінено лише цей запис review. Наступна функціональність до APPROVED заблокована.

## ADR-025: перевірка фактичного alias перед rollback (2026-10-16) — готово до повторного review Codex

Статус: **готово до повторного review Codex** (APPROVED не виставлявся). Runtime API/Agent не змінювався; production не змінювався й не передеплоювався (production apply/rollback не виконувались).

**P2 — сторонній об'єкт замість alias — виправлено** (`c2fff84`, `scripts/deploy/lib/path-migration.js`). Причина: preflight кроку move пропускав наявний старий шлях, якщо в журналі був pending alias-крок; самі alias-кроки фактичним станом не перевірялися — rollback переписував env, а `rename` падав `ENOTEMPTY`. Тепер перевірки спираються на диск: alias — лише точно symlink цієї міграції або відсутній (finalize, перерваний rollback); старий шлях переміщення вільний, лише якщо відсутній або цей alias; інакше (каталог, файл, symlink на іншу ціль, «висячий») — відмова до будь-якого unlink/rewrite/rename/запису state, повідомлення з шляхом і типом об'єкта, без значень. Перед кожною деструктивною дією передумова перевіряється повторно: об'єкт, що з'явився під час rollback, не видаляється й не перезаписується (у т.ч. порожній каталог, який `rename(2)` інакше замінив би) — зупинка, виконані кроки в журналі. Повторний rollback відкоченого state нічого не записує. Формат state не змінювався.

| Сценарій (`tests/unit/path-migration-alias.test.js`, 12) | До фікса (`afd23b3`) | Після |
|---|---|---|
| alias → непорожній каталог / порожній каталог / звичайний файл / symlink на інший наявний шлях / «висячий» symlink: dry-run і rollback відмовляють; env, state байт-у-байт, дерево (lstat/readlink) і стороння ціль — без змін | 5 × fail | 5 × pass |
| конфлікт alias виявлено до rewrite інших env-файлів | fail | pass |
| alias замінено після перевірок — сторонній каталог не видалено, журнал коректний | fail | pass |
| старий шлях з'явився перед зворотним rename — не перейменовано поверх (дані лишились на новому шляху) | fail | pass |
| перерваний rollback після видалення alias → продовження; повторний — без змін; ротований токен збережено | fail | pass |
| очікуваний alias; alias, прибраний finalize; state старого формату з alias | pass | pass |

| Перевірка (Node 22) | Результат |
|---|---|
| Попередні набори (`path-migration` 14, `path-migration-recovery` 13) на коді до фікса / після | 27/27 / 27/27 |
| `npm test` | 129/129 |
| `npm run check:local` | exit 0: node:test 129/129, backend 446/446, smoke 10/10, agent 165/165 (+3 opt-in), frontend 233/233, typecheck, lint, збірки, secrets |
| `npx playwright test -c e2e/ui.config.ts` | 19/19 |
| Linux, root, власна тимчасова пісочниця (керована нода; без служб і production-файлів) | apply (move+rewrite+alias) → ротація синтетичного токена → alias замінено непорожнім каталогом: dry-run і rollback відмовили; кожен шлях, тип, власник, права, symlink і SHA-256 файлів (env, state, сторонній) — без змін; після перенесення стороннього каталогу вбік (дані збережено) — rollback: власники/права/setgid ідентичні стану до apply, ротований токен збережено; повторний — «nothing to do». (Під час recovery alias було вручну відтворено — не обов'язково: відсутній шлях теж допустимий.) |
| `check:secrets`, `git diff --check`, пошук бренду | OK; 0 збігів |

**Рекомендований інструмент.** Артефакти `c2fff84f19fed8c39a587059d9518bf1bafd901d` (штатний `build-release.js`, тимчасовий worktree): API SHA-256 `650527f74e1eeb99cd27a80de526dac501412e64d3b0b598243838d920a2dc64`, Agent SHA-256 `269ee9742883385b5446323a3d763eb843850de4df79c611431960561ab3e4bd`; manifest без помилок (65 / 35); `migrate-paths.js` і `lib/path-migration.js` в обох = протестований код; `server-bundle` = `scripts/deploy` (без `build-release.js`). Зберігаються в оператора поза репозиторієм (`release-artifacts/c2fff84`). Майбутній rollback міграції 2026-10-16 — лише `server-bundle/migrate-paths.js` цієї (чи новішої) ревізії. Історичні, не рекомендовані (артефакти не змінювались): `2340c00` (затирання env, без перевірки state) і `3dcd90b` (не перевіряв фактичний alias).

Межі гарантії: відмова «без жодних змін» — для конфліктів, наявних на момент запуску; одночасна зміна файлової системи під час rollback виявляється на відповідному кроці (без атомарності всього rollback), виконані кроки лишаються в журналі. Recovery стороннього об'єкта — лише після перевірки походження, зі збереженням даних (DEPLOYMENT).

## ADR-025: безпечний rollback конфігурації й захист журналу міграції (2026-10-16) — готово до review Codex

Статус: **готово до review Codex** (APPROVED не виставлявся). Runtime API/Agent не змінювався — production не передеплоювався; на production нічого не змінено (лише read-only `rollback --dry-run`, нижче).

1. **P2 — rollback затирав актуальні значення env — виправлено** (`d7ee0cc`, `scripts/deploy/lib/path-migration.js`, `migrate-paths.js`). Причина: `rollbackMigration` записував увесь backup-файл поверх поточного. Тепер `apply` журналює точні змінені рядки («до → після»), а rollback у поточному вмісті повертає лише їх, якщо кожен знайдено однозначно; інший вміст (ротовані токени, додані/видалені ключі, коментарі) зберігається, права й власник — поточні. Спершу перевіряються всі кроки (зворотні переміщення, рядки); будь-який конфлікт — відмова до будь-якої зміни (повідомлення з файлом і ключем, без значень); файл, змінений між перевіркою й записом, не перезаписується; рядок, уже повернутий перерваним запуском, визнається відновленим. Новий `rollback --dry-run`. State попередньої версії (`version` 1, без рядків і `maps`): rewrite-кроки — лише з тими самими `--legacy-map`, що й `--map` при apply; зміни виводяться з backup і перевіряються, а рядок із шляхом, не пояснений міграцією, — відмова (захист від неповних maps); відсутній backup — відмова. Ручний recovery — DEPLOYMENT.
2. **P2 — state міг переміститися разом із source — виправлено.** `--state`/`--backup-dir` не можуть лежати всередині (чи дорівнювати) старого/нового шляху `--move`, `--rewrite` (обидва розташування) або `--alias`; `--backup-dir` не може містити такий шлях; `--state` не може мати імені backup-файлу; перевірка за resolved-шляхами (realpath найближчого наявного предка + решта, тож symlink не обходить її), до створення будь-яких метаданих; `plan` перевіряє це, коли метадані задано. State в окремому backup-каталозі (чинний сценарій) дозволений.
3. **`command-limit` нестабільний — причину встановлено, виправлено тест** (`3dcd90b`). Інструментована копія (не закомічена) фіксувала в момент assertion надіслані браузером і оброблені route GET першої команди: 30 повторів під навантаженням паралельного frontend-suite — 4 падіння, у всіх `issued=0 handled=0`; другий діагностичний прогін (30/30) після `runFor` робив ще один виклик у браузер — щоразу браузерний годинник просунувся на 4 503–4 507 мс і обидва GET уже надіслані. Висновок: `page.clock.runFor()` завершується після виконання браузерних таймерів, а події/обробка запитів, які вони запустили, доходять до процесу тесту пізніше; polling продукту спрацьовує вчасно (дефекту немає). Виправлення: `waitForResponse` для GET цієї команди, зареєстрований до `runFor`, потім перевірка лічильника. Без sleep/retries; якщо polling зупиниться — тест упаде на timeout.

| Перевірка (Node 22) | Результат |
|---|---|
| Нові regression `path-migration-recovery` (13) на попередній реалізації (код з `HEAD` до фікса у тимчасовому каталозі) | 11 падінь, 1 зелений (rollback без змін після apply); попередній `path-migration` на старому коді — 14/14 |
| Після фікса: `npm test` | 117/117 (`path-migration` 14, `path-migration-recovery` 13, решта без змін) |
| `npm run check:local` | exit 0: node:test 117/117, backend 446/446, smoke 10/10, agent 165/165 (+3 opt-in), frontend 233/233, typecheck, lint, збірки, secrets |
| `npx playwright test -c e2e/ui.config.ts` | 19/19 |
| `command-limit` під навантаженням: до виправлення / після | 26/30 (4 падіння) / 60/60 (2 × 30) |
| Linux, root, власна тимчасова пісочниця (керована нода, без служб і production-файлів) | небезпечний state усередині source — відмова, нічого не створено/змінено; apply — власники (`nodecontrol-agent`, `ubuntu:nc-pm2-inventory`), права, setgid збережені; ротація синтетичного токена після apply → `rollback --dry-run` пройшов → rollback: новий токен збережено, старого немає, шляхи inventory і сокета повернуто, `600 nodecontrol-agent`, власники/права/setgid ідентичні; state старого формату: без `--legacy-map` — відмова без змін, з ним — rollback, ротований токен збережено, права ідентичні (окремий чистий прогін — перша перевірка прав у спільному прогоні включала власний новий backup-каталог) |
| Production state-файли 2026-10-16 (read-only `rollback --dry-run` новою версією з тимчасової копії, потім видалена) | центральний (v1, лише переміщення й alias) — перевірка пройдена, state незмінний (SHA-256); керована нода (v1, 3 rewrite) — без `--legacy-map` відмова для кожного env-файлу; з `--map` apply — перевірка 9 кроків пройдена; state і 3 env-файли незмінні (SHA-256 до/після) |
| `check:secrets`, `git diff --check`, пошук бренду | OK; 0 збігів |

_Уточнення (2026-10-16): `3dcd90b` має відомий alias-дефект — не рекомендований; рекомендована версія — розділ вище._ **Перевірений інструмент.** Артефакти `3dcd90b28637c63995907216b34c782dd781e4c4` (штатний `build-release.js`, тимчасовий worktree): API SHA-256 `75a83fe050bef18c5dbcdbae888b996a83f9472b34bf0c515259f251a85ee1d6`, Agent SHA-256 `f245e582888d9d486b5021d4fbbafa5720f8c36fc596361fff7df41169fac798`; manifest без помилок (65 / 35 файлів); `migrate-paths.js` і `lib/path-migration.js` в обох = закомічене виправлення; `server-bundle` = `scripts/deploy` (без `build-release.js`). Зберігаються в оператора поза репозиторієм (`release-artifacts/3dcd90b`). Для rollback міграції 2026-10-16 використовувати `server-bundle/migrate-paths.js` цієї (чи новішої) ревізії, не копію з `2340c00` або попередніх релізів (відомі дефекти, не рекомендовані; старі артефакти не змінювались).

Обмеження: перевірка повноти для state старого формату консервативна — рядки зі шляхами, додані після міграції, блокують автоматичний rollback (ручний recovery); стабільність `command-limit` за будь-якого навантаження не заявляється. Real-DB/real-PM2 не запускались (логіка не змінювалась).

## Нейтральна назва продукту й шляхів встановлення (2026-10-16, ADR-025) — готово до review Codex

Статус: **готово до review Codex** (APPROVED не виставлявся). Нова функціональність не розроблялась.

**Що змінено.** Продукт — Node Control (slug `node-control`, Agent — Node Control Agent): UI (`<title>`, бокова панель, сторінка входу), метадані пакетів і lockfile (лише поля `name`), текст тестового Slack-повідомлення, коментарі, units (`Description`, шляхи), `server-release.js` (типові `--base/--config`), типові шляхи broker, формат snapshot inventory (`node-control/pm2-inventory`), перевірка bundle на витік серверного конфігу (`/etc/node-control`), `.env.example`, тести, документація. Назви units, користувачів, груп, ключі `NC_*`, БД і ролі — без змін. Новий `scripts/deploy/migrate-paths.js` (в обох артефактах) і `setup-test-db.js --previous-comment`. Таблиця шляхів і процедура — DEPLOYMENT, «Перейменування шляхів встановлення».

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 104/104 (нові: `path-migration` 14, `test-db-plan` +1), backend 446/446, smoke 10/10, agent 165/165 (+3 opt-in), frontend 233/233, typecheck, lint, збірки, secrets |
| `npx playwright test -c e2e/ui.config.ts` | 19/19 |
| `npm run test:e2e` / `test:e2e:pm2` / `test:agent:pm2` | 18/18 (+1 opt-in) / 1/1 / 3/3 (одноразовий PM2) |
| `systemd-analyze verify` (Linux, тимчасові копії units) | API — exit 0 на центральному сервері; Agent, broker@, exporter@ service/timer — exit 0 на керованій ноді |
| `migrate-paths.js` під root на Linux (пісочниця в /tmp) | власники (`nodecontrol-agent`, `ubuntu:nc-pm2-inventory`, setgid), права й типи збережені після apply і rollback; env переписано (`600` збережено), backup `0600 root`; повторний apply — 0 змін; конфлікт destination — зупинка; rollback — env байт-у-байт |
| Пошук бренду (case-insensitive) | tracked-текст, імена tracked-файлів, нові неігноровані файли, `frontend/dist`, обидва артефакти та `server-bundle` — 0 збігів |

**Деплой і міграція (2026-10-16).** Артефакти `2340c00bce16c13692b8a5cd0ac82cf846527bb6`: checksum OK, manifest без помилок (API 65, Agent 35 файлів), `frontend/dist` = тестована збірка.
- *Центральний сервер:* preflight `plan` (6 кроків, 0 конфліктів) → backups units і vhost (`/root/node-control-backups/paths-<ts>/`) → `prepare` у поточну базу (міграцій БД немає, pending=0) → зупинка API → `apply` (5 переміщень + тимчасовий alias) → нові units API і (вимкненого) Agent → `config` (лише валідація) → `activate` → старт API. Nginx: лише vhost Node Control — `nginx -t` до/після, `root` → `/opt/node-control/current/frontend/dist`, reload; після перевірки сайту `finalize` прибрав alias. Посилань на попередні шляхи в Nginx, units і конфігах немає. Active API/UI — **`2340c00`**, previous — `cd4cb2c`; live/ready 200, 0 warning/error; публічний сайт: `<title>Node Control</title>`, bundle без згадок бренду, `/applications` 200, `/api/auth/me` 401. Вимкнений Agent на цьому сервері лишився на своєму попередньому релізі (не вмикався).
- *Керована нода:* preflight `plan` (9 кроків, 0 конфліктів) → backups 4 units → `prepare` у поточну базу → зупинка timer exporter, Agent, broker → `apply` (6 переміщень, 3 env-файли переписано: лише ключі `NC_AGENT_INVENTORY_FILE`, `NC_AGENT_CONTROL_SOCKET`, `NC_PM2_SNAPSHOT_FILE`, `NC_BROKER_ALLOWLIST`; `--map` для сокета під `/run`) → нові units → `verify` → `activate` (Agent `2340c00`, previous `cf2f0f7`) → broker → exporter один раз (snapshot `node-control/pm2-inventory`, 5 процесів) → Agent → timer. Після: усі units active, 0 warning у журналах Agent/broker/exporter, цикли heartbeat/inventory/control/logs poll, звіти inventory і керування свіжі (53 с / 1 с); сокет `0660 ubuntu:nc-pm2-control`, snapshot `0640`, каталог `2750`, журнал `0700`, `agent.env` `600 nodecontrol-agent`; allowlist той самий (SHA-256 збігається); нових інцидентів сповіщень за 30 хв — 0. **PM2 baseline:** PID і час старту всіх процесів без змін, 5 застосунків online, restarts 0 до й після. PM2-команди, керуючі дії, читання логів застосунків і Slack-тести не виконувались.

_Уточнення (review Codex, 2026-10-16): описаний тут rollback попередньої версії інструмента відновлював env-файли з backup повністю (затирав зміни після міграції) і не перевіряв розміщення state — виправлено, див. розділ вище; rollback — лише виправленою версією._ **Rollback** — DEPLOYMENT, «Rollback перейменування»: API — `server-release.js rollback` (→ `cd4cb2c`, чинний unit підходить); Agent — лише повний (зупинка → `migrate-paths.js rollback --state /root/node-control-backups/paths-<ts>/state.json` → unit-файли з backup → `server-release.js rollback --base <попередня база>` → broker, exporter один раз, Agent, timer). БД не відкочується.

**Залишки поза поточним деревом.** Історія Git (старі commits, compatibility-гілка `70ddd1f` і її артефакт) не переписувалась і містить попередню назву. Зовнішні системи не змінювались: назва репозиторію й remote, публічний домен і назва файлу vhost (за доменом), TLS, Slack, коментар правила в `pg_hba.conf` і `COMMENT` тестових ресурсів PostgreSQL (перемічаються лише явним `setup-test-db.js --previous-comment`), приватні env-значення (`ALERTS_PUBLIC_URL` тощо). На хостах лишаються давні операторські backups (`*.bak-<дата>`, у т.ч. env-файли з попередніми шляхами) і backups цієї міграції — видаляти разом після стабільної роботи.

## Незалежний review Codex — ADR-024: APPROVED (2026-10-16)

Перевірено фінальні `0833249` (тести) і `54e8348` (документація) поверх tracking-фікса `32b29f1`; початкове дерево чисте. Зауваження попередніх проходів ADR-024 закриті: прийняті активні команди не витісняються, ліміт блокує новий POST до фінального результату; README/DEPLOYMENT та опис capabilities актуалізовані; AGENTS узгоджено з охопленням typecheck/lint; regression дійсно моделює HTTP 503 і rejected fetch, збереження busy/ліміту, відновлення polling і звільнення слота. Локальні таймаути jsdom-тестів обґрунтовані задокументованими вимірами; assertions, workers і retries не послаблені. Нової функціональності чи runtime-змін у фінальному diff немає.

Незалежно на Node.js 22: check:local exit 0 — 89 unit, 446 backend, 10 smoke, 165 Agent (+3 opt-in пропущені), 233 frontend; typecheck, lint, secrets і збірки успішні. Перевірено Code → Docs / Docs → Code для виправлених тем, локальні файлові посилання у восьми головних документах (0 відсутніх цілей; anchors не перевірялись). Браузерні 19/19 з попереднього review належать незміненому runtime; заново UI/E2E, stress-серію Claude, real-DB, real-PM2 і production у цьому проході не перевіряли. Виміри старої/нової ревізії та stress-прогони у звіті Claude залишаються його результатами, не незалежно повтореними.

APPROVED стосується ADR-024 і його review-фіксів, не загальної production-готовності. Відомі окремі дефекти FormDialog та release blockers лишаються відкритими. Прибирання корпоративного бренду погоджене як окремий наступний scope, ще не виконане; розгорнуті панелі й пошук Applications не реалізовані. Reviewer змінює лише цей запис; код, конфігурації й production не змінювались.

## ADR-024: залишкові зауваження review (2026-10-16) — готово до повторного review Codex

Статус: **готово до повторного review Codex** (APPROVED не виставлявся). Runtime не змінювався, деплою немає (зміни лише в тестах, документації та коментарі `eslint.config.js`); production — `cd4cb2c`.

1. **P3 — AGENTS.md суперечив охопленню перевірок — виправлено** (вузька правка, погоджена користувачем). `typecheck` і `lint` — загальні перевірки `backend/`, `frontend/`, `e2e/`, `agent/` (звірено: скрипт `typecheck` — чотири `tsconfig`, `eslint.config.js` — блоки для чотирьох каталогів); перелік scripts розділено на загальні, backend, agent, frontend, E2E (усі назви існують у `package.json`). Коментар `eslint.config.js` доповнено `agent`. Інші правила AGENTS не змінювались.
2. **P3 — тест polling errors не моделював збою — виправлено.** Попереднє твердження (розділ нижче: «помилка/незмінний статус не звільняє слот») перевіряло лише незмінний `queued` без збою GET; фрагмент замінено. Новий regression `command-tracking` › «a failing status read…»: після заповнення ліміту `GET /api/control-commands/:id` першої команди спершу повертає **HTTP 503**, потім **fetch відхиляється** (мережева помилка); тест дочікується саме цих невдалих циклів (мок їх фіксує) і перевіряє: команда лишається у списку зі статусом «У черзі», busy, ліміт не звільнений, фінальний статус не вигаданий, нова команда за ліміту — без POST; після відновлення GET polling триває (успішні читання, збоїв більше немає); фінальний `succeeded` від сервера звільняє слот, відкритий діалог надсилає команду один раз. Мутаційна перевірка: якщо помилка polling вигадує фінальний статус — тест падає. Runtime не змінювався (дефекту не виявлено).
3. **Нестабільні frontend-тести — причину встановлено.** Відтворено ті самі падіння, що в review (`logs` › «operator opens…»: `Unable to find "Дії: api"` ≈1,15 с; `users-paging` › «230 users»: timeout 5 с), запуском двох повних frontend-suite одночасно (у першому з двох раундів обидва, плюс сусідній «a user on page 2»). Обидва тести чекають правильного стану (не гонка й не дефект продукту); перевищено часові бюджети: (а) перший тест файлу платить холодний перший рендер застосунку у worker — ≈250–300 мс окремо, проти 20–70 мс для наступних тестів того ж файлу, >1 с під навантаженням, при 1 с за замовчуванням у `findBy`; (б) тести з двома й більше повними сторінками по 100 рядків CPU-bound у jsdom — «230 users» ≈0,65 с окремо, 1,4–1,9 с у штатному паралельному suite, 3,9–5,3 с під подвійним навантаженням при межі 5 с. **Ревізія до ADR-024 (`83b787d`) під тим самим навантаженням теж падала** (logs) і мала 3,9–4,5 с для «230 users» — регресії ADR-024 немає. Виправлення лише в тестах, з поясненням і вимірами в коментарях: `logs.test.tsx` — явна межа 5 с лише для очікування готовності сторінки (`PAGE_READY`); `users-paging.test.tsx` — межа 15 с (`MULTI_PAGE_TEST_MS`) для п'яти тестів, що рендерять ≥2 повні сторінки по 100 рядків. Assertions, кількість workers, retries — без змін; sleep не додавались.

| Перевірка (Node 22) | Результат |
|---|---|
| Ізольовано, до/після ADR-024 (3 × цільові файли на кожній ревізії) | logs 247–326 мс, «230 users» 641–957 мс — без суттєвої різниці |
| Повний frontend-suite, штатно, до виправлення (3) | 233/233 кожен; logs 580–722 мс, «230 users» 1411–1909 мс |
| Подвійне навантаження до виправлення (2 раунди × 2 suite) | раунд 1: обидва suite — ті самі падіння, що в review (+ «a user on page 2»); раунд 2: 233/233 з межовими тривалостями. На `83b787d` (2 × 2): 1 падіння logs |
| Після виправлення: цільові файли (5 + 3 прогони) | 32/32 кожен |
| Після першої версії виправлення: подвійне навантаження (3 × 2) | обидва діагностовані тести не впали (logs 1,7–3,6 с; «230 users» 5,6–9,9 с); у раунді 1 упали інші тести з межею 5 с: `users-paging` › «a late answer…» (2 suite) — рендерить сторінку 1 двічі, тобто той самий критерій ≥2 повних сторінок → межу застосовано й до нього та до «a failed next page…»; `control` › «"accepted" is not success» (1 suite) — не змінювався, див. обмеження |
| Після остаточного виправлення: подвійне навантаження (3 × 2) | 6/6 suite — 233/233 |
| Повний frontend-suite після виправлення (3 + 1) | 233/233 кожен |
| `npm run check:local` | exit 0: node:test 89/89, backend 446/446, smoke 10/10, agent 165/165 (+3 opt-in), frontend 233/233, typecheck, lint, збірки, secrets (до двох останніх маркерів межі в `users-paging`; після них — typecheck, lint і повний frontend-suite окремо) |
| `npx playwright test -c e2e/ui.config.ts` | 19/19 |
| Документація | посилання змінених документів цілі; scripts AGENTS ↔ `package.json` звірено |

Обмеження: подвійне навантаження — штучний стрес понад умови `check:local`; стабільність за будь-якого навантаження не заявляється. Тест `control` › «"accepted" is not success» чекає реальних 2-секундних циклів polling і один раз перевищив 5 с у цьому стресі; у штатних прогонах і в review не падав — не змінювався, щоб не підганяти межі без окремої діагностики. Real-DB і real-PM2 не запускались (backend/Agent не змінювались). Відомі дефекти FormDialog не виправлені.

## Виправлення зауважень review ADR-024 (2026-10-15) — готово до повторного review Codex

Статус: **готово до повторного review Codex** (APPROVED не виставлявся). Нова функціональність не розроблялась.

1. **P2 — втрата незавершених команд — виправлено.** Причина: `useProcessCommands` обрізав увесь список `slice(0, 5)` без розрізнення активних і завершених. Тепер (`frontend/src/components/processActions.tsx`): до `MAX_ACTIVE_COMMANDS = 5` незавершених команд відстежуються одночасно й ніколи не витісняються; обрізається лише завершена історія (`MAX_FINISHED_COMMANDS = 5`, найновіші); поки активних 5 — пункти керування в меню недоступні з поясненням «Уже виконується 5 команд — нова стане доступною, коли одна з них завершиться», а в уже відкритому діалозі POST не надсилається (помилка, той самий idempotency key лишається для пізнішого явного повтору); слот звільняє лише фінальний статус від сервера (помилка polling команду не завершує); синхронний guard від подвійного натискання. Busy — за `serverId + targetKey`. Однаково для сторінки сервера й «Застосунків».
2. **P2 — документація суперечила продукту — виправлено.** README (стан можливостей, `.env` скриптів vs `/etc/node-control/api.env` API — звірено з `deploy/systemd/node-control-api.service`, ролі за `backend/src/auth/rbac.ts`, міграції 0…8, inventory/керування, UI-сторінки, дії з процесами й ліміт команд, lint-охоплення, `check:local`), вступ і «Факти» DEPLOYMENT (чинна процедура vs історичні розділи, вміст артефакту й прапорці `build-release.js`, health endpoints), ARCHITECTURE (підсумок можливостей, сторінки, спільні модулі дій), DEVELOPMENT_RULES (охоплення typecheck/lint/check:local), ADR-024 (ліміт відстеження). Історичні звіти деплоїв не переписувались.
3. **P3 — кількість capabilities-запитів — виправлено в документації** (реалізація без змін): перед POST `ensure(serverId, {fresh: true})` запитує `/control` і за `logs:read` — `/log-targets` (до двох GET) або використовує вже запущене завантаження; рішення — за `control`. ADR-024 уточнено; історичний звіт нижче позначено явним уточненням.

| Перевірка (Node 22) | Результат |
|---|---|
| Regression `command-tracking` (5) | ліміт активних: 6-та команда — без POST, з поясненням, записи не втрачаються; перша команда далі опитується й лишається busy; помилка/незмінний статус не звільняє слот _(уточнення 2026-10-16: цей фрагмент перевіряв лише незмінний `queued` без збою GET; справжній збій — розділ вище)_; фінальний статус звільняє → явний повтор у тому ж діалозі прийнято один раз; обрізається лише завершена історія; double-click — 1 POST; втрачена відповідь → повтор із тим самим ключем без дубліката; busy за `serverId + targetKey`; `unknown` фінальний; logout зупиняє відстеження. Мутаційна перевірка: зі старим `slice(0, 5)` без guard падають 2 ключові тести |
| Браузер `e2e/ui-tests/command-limit.spec.ts` (синтетичний API) | 5 команд у «Застосунках» → 6-та недоступна з поясненням, клік нічого не надсилає; перша опитується; її завершення → 6-та прийнята; 6 POST з різними ключами |
| `npm run check:local` | exit 0: node:test 89/89, backend 446/446, smoke 10/10, agent 165/165 (+3 opt-in), frontend 232/232, typecheck, lint, збірки, `check:secrets` OK (перший прогін впав на lint нового тест-файлу — виправлено, повторено) |
| `npx playwright test -c e2e/ui.config.ts` | 19/19 |
| `npm run test:e2e` (тестовий backend) | 18/18 (+1 opt-in пропущено) |
| Документація | локальні посилання змінених документів — 0 битих; npm scripts і шляхи, згадані в змінених розділах, звірено з `package.json`, units і `scripts/deploy` (статично) |

Не виконувалось: real-DB `test:backend:db` (backend не змінювався), opt-in `test:e2e:pm2` (control-логіка backend/Agent не змінювалась; tracking перевірено синтетично). Відомі обмеження: якщо відповідь на POST втрачено і користувач закрив діалог, UI не відстежує цю команду (backend її виконує; сторінка сервера показує її в «Останніх командах», «Застосунки» — ні); відомі дефекти FormDialog не виправлялися. `AGENTS.md` досі каже, що lint налаштований лише для `backend/` — файл інструкцій не змінювався, потрібне рішення користувача/Codex.

**Деплой (2026-10-15).** Active API/UI: **`cd4cb2c91ae7cd05bc9f66f37d67949221700279`** (містить fix `32b29f1`), previous — `4737bfc`. Штатно: `build-release.js` → `sha256sum -c` OK, manifest 63 файли без помилок, `frontend/dist` і міграції = тестована збірка → `prepare` → `migrate status` applied=9 pending=0 (міграції не запускались) → unit без змін → `activate` → restart лише `node-control-api`. Після: systemd active, live/ready 200; warning/error/fatal у журналі API — 0; публічний сайт віддає новий bundle (з повідомленням про ліміт команд), `/applications` 200, `/api/auth/me` без cookie 401; nginx і PostgreSQL active. Agent/broker/exporter не передеплоювались; PM2-процеси керованої ноди без змін (PID і час старту); production-команд не надсилалось, login у production не виконувався — авторизований UI оператор перевіряє вручну без виконання дій.

**Rollback:** `server-release.js rollback` (→ `4737bfc`) + `systemctl restart node-control-api`, без міграцій і відкату БД. Застереження: `4737bfc` має відомий дефект tracking (6-та прийнята команда витісняє першу з відстеження; backend від повторної дії захищений). Сумісні з ADR-023 також `cf2f0f7`; несумісний pre-ADR-023 `c016beb` не використовувати; аварійна ціль відкату самого ADR-023 — compatibility-реліз `70ddd1f`.

## Незалежний review Codex — ADR-024: CHANGES REQUIRED (2026-10-15)

Перевірено code commit `4737bfc` і docs commit `ed5e04e`; перед документуванням review дерево чисте. Нові постійні правила користувача інтегровано в AI_WORKFLOW, AGENTS містить посилання: обов'язкові Code → Docs і Docs → Code, явний висновок, виправлення й повторний review до APPROVED. Новий промпт на наступну функціональність до APPROVED не створювати; раніше підготовлений промпт розгорнутих панелей не означає схвалення ADR-024.

Відкриті зауваження:

1. **P2 — втрата незавершених команд.** `frontend/src/components/processActions.tsx:184`: безумовний `slice(0, MAX_TRACKED)` видаляє першу pending-команду після прийняття шостої. У попередній перевірці цього самого коду відтворено браузером із синтетичним API: 6 queued-команд → 5 видимих статусів, перша не відстежується, дія знову доступна. Потрібно зберігати всі прийняті незавершені команди, обмежувати завершену історію; за ліміту активних — не надсилати нові команди й пояснювати причину. Додати regression на перевищення ліміту та звільнення місця після фінального результату.
2. **P2 — актуальні вхідні інструкції суперечать продукту.** `README.md:5,95,100` заявляє відсутність PM2/користувачів/логів та подає legacy env-шлях як поточний; вступ `docs/DEPLOYMENT.md` змішує Task 006 і сучасні інструкції. Потрібно актуалізувати можливості, runtime/env-шляхи й межі актуальних інструкцій, залишивши історичні факти явно історичними. Це документація наявної поведінки, не завдання створити новий installer.
3. **P3 — неточна кількість capabilities-запитів.** Звіт ADR-024 нижче стверджує «перед POST — 1 GET /control». Фактично ApplicationsView викликає `ensure(..., {fresh:true})`, а useServerCapabilities запитує control і log-targets за наявними правами: до двох GET, або спільний уже запущений запит. Потрібно узгодити опис із реалізацією; якщо оптимізується код — перевірити дедуплікацію та права.

Перевірки реалізації з попереднього проходу на незміненому `4737bfc`: check:local exit 0 (89 unit, 446 backend, 10 smoke, 165 Agent +3 opt-in пропущені, 227 frontend; typecheck/lint/secrets/збірки), UI Playwright 18/18. У цьому повторному проході повторно зіставлено код і документацію; зазначені функціональні suite й браузерне відтворення заново не запускались. Real-DB і повні E2E незалежно в цих проходах не повторювались. Перевірки змін правил документуються окремо нижче.

Для змін правил на Node.js 22 заново виконано: npm test 89/89, npm run typecheck, npm run lint, npm run check:secrets і git diff --check — успішно. Функціональний код, конфігурації й production у цьому проході не змінювались; змінено лише правила та запис review. Окремі відомі дефекти FormDialog лишаються відкритими й не є новими регресіями ADR-024.

## Дії в розділі «Застосунки» і floating-меню рядка (2026-10-15, ADR-024)

**Що змінено (лише frontend; backend, Agent, broker, міграції — без змін):**
- «Застосунки» тепер дозволяють керування (запуск, зупинка, перезапуск) і перегляд логів **за правами** — без переходу на сторінку сервера. Колонка «Дії» — лише з `processes:control` або `logs:read`; viewer її не бачить. Пункти, назви й порядок ті самі, що на сторінці сервера.
- Кожна дія адресована `serverId` рядка + `targetKey`, підтвердженим broker для того самого імені й PM2 id. Підтвердження називає застосунок, сервер і операцію; після прийняття показується реальний lifecycle до фінального статусу («accepted» ≠ «succeeded», `unknown` пояснюється). Логи — той самий захищений `LogViewer`.
- Спільна логіка (`processActions.tsx`: `rowMenu`, `useProcessCommands`) замість дублювання `ProcessControl`; сторінка сервера переведена на неї. Блокується лише рядок цілі з незавершеною командою.
- Можливості в загальному списку — ліниво (`useServerCapabilities`): 2 GET (`/control`, `/log-targets`; лише ті, на які є право) на **сервер** при першому відкритті меню, дедуплікація одночасних відкриттів, кеш 10 с, лише сервери поточної сторінки; без polling. Перед POST — ще 1 свіжий `GET /control` для перевірки цілі; при розбіжності POST не надсилається. _Уточнення (review Codex P3): «1 GET» неточно — свіже завантаження запитує `/control` і, за `logs:read`, `/log-targets` (до двох GET) або використовує вже запущене завантаження; рішення — за `control`. Див. ADR-024._
- `ActionMenu` — overlay через portal (`position: fixed`), відкривається вниз/вгору, обмежена висота з власним scroll, перепозиціонування при scroll/resize, одне меню, повна клавіатурна семантика menu button. Таблиця користувачів використовує те саме меню.
- Відомі окремі дефекти `FormDialog` (submit під час підтвердження закриття, повернення фокуса) цим завданням не виправлялися.

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 446/446, smoke 10/10, agent 165/165 (+3 opt-in), frontend 227/227, typecheck, lint, збірки, `check:secrets` OK |
| Нові frontend-тести | `action-menu` 8 (overlay у `<body>`, aria, клавіатура, Tab/Escape, disabled, одне меню, polling, зникнення рядка, lazy loading, розміщення біля країв); `application-actions` 21 (viewer без колонки; ліниве завантаження й кеш; дедуплікація; однакові назви/PM2 id на двох серверах → правильні `serverId`/`targetKey`; підтвердження до POST; один POST із CSRF та idempotency; lifecycle; `unknown`; явний повтор з тим самим ключем; зміна можливостей перед POST → без POST; offline/stale/вимкнене керування/застарілий broker/fingerprint/не в allowlist/неоднозначність; незалежні control і logs; логи правильного сервера; зміна фільтра під час завантаження й під час POST; logout під час POST) |
| `npx playwright test -c e2e/ui.config.ts` | 18/18, новий `row-menus.spec.ts`: 1440/390 × light/dark — висоти рядків, розміри таблиці, scroll-контейнера й сторінки до/після відкриття однакові; меню в межах viewport і не перекрите; нижній рядок → угору; горизонтально прокручена таблиця (390); сторінка сервера й користувачі; клавіатура, outside click, scroll, polling, зникнення рядка, фільтр; 0 мутацій |
| E2E (тестовий backend) | 18/18 (+1 opt-in) |
| Real-PM2 E2E (opt-in, одноразовий PM2) | 1/1, додано перезапуск зі сторінки «Застосунки» → «Виконано й підтверджено», audit `process.command_*` |

Перший прогін знайшов дефекти тестів (lint у нових тестах, неоднозначний локатор `inventory.spec` через нову кнопку «Дії: e2e-api на …»); виправлено й повторено повністю.

**Деплой (2026-10-15).** Active API/UI: **`4737bfc9e3c6cdbdef84bdeed2387a2fff89a65a`** (`feat(ui): add application actions and floating row menus`), previous — `cf2f0f7` (ADR-023, сумісний). Штатний `build-release.js` → `sha256sum -c` OK, manifest 63 файли без помилок, `frontend/dist` і міграції = тестована збірка → `prepare` → `migrate status` applied=9 pending=0 (міграції не запускались) → unit без змін → `activate` → restart лише `node-control-api`. Після: systemd active, live/ready 200, `127.0.0.1:3100`, `nodecontrol`; warning/error/fatal у журналі API — 0; публічний сайт віддає новий bundle (з overlay-меню), `/applications` 200, `/api/auth/me` без cookie 401; nginx і PostgreSQL active. Agent/broker/exporter не передеплоювались і не перезапускались; PM2-процеси керованої ноди без змін (PID і час старту). Авторизований UI у production автоматично не перевірявся (login у production не виконується), production-команд не надсилалось — ручна перевірка оператором: «Застосунки» → «Дії» → відкрити меню, дію не виконувати.

**Rollback:** `server-release.js rollback` (або `activate --revision cf2f0f7e7c2e89965031fe877e678cc543cf0931`) + `systemctl restart node-control-api`; без міграцій і без відкату БД. Не повертатися на несумісний pre-ADR-023 `c016beb`. Аварійна ціль відкату самого ADR-023 — окремий compatibility-реліз `70ddd1f` (розділ нижче).

## Незалежний review Codex — Task 011 (2026-10-14)

Переглянуто фінальний code commit `20896dd` та docs-звіт `2ce89c7`; початкове дерево чисте. Review незавершеного робочого дерева раніше було зупинено користувачем; він не є висновком щодо фінального commit.

Знайдено два P2:

1. **Запізнілий успіх зміни пароля змінює глобальний стан авторизації після unmount.** `frontend/src/pages/AccountPage.tsx:72` після await не перевіряє controller.signal.aborted та викликає passwordChanged(); apiRequest також не перевіряє abort на успішному 204. Відтворено із synthetic deferred response: pending зміна пароля → logout → новий login → Огляд → успішна відповідь старої форми; нова сесія UI скидається, з’являється «Пароль змінено». Потрібні перевірка актуальності/скасування перед побічними ефектами, захист меж сесій і regression-тест. Перевірити також успішні гілки create/update users. Це клієнтська гонка, не доказ обходу авторизації backend.
2. **Після перших 100 користувачів UI не дозволяє керувати рештою.** usersApi.list завжди запитує limit=100 без after; `frontend/src/pages/UsersPage.tsx:194` лише повідомляє про перші 100. API cursor реалізований, але frontend не використовує nextAfter. Потрібні пагінація/завантаження наступних сторінок, коректне оновлення після мутацій і regression для понад 100 користувачів, включно зі щойно створеним.

Незалежні перевірки фінального коду на Node.js 22: check:local exit 0 (89 node:test, 380 backend, 10 smoke, 164 agent +3 opt-in пропущені, 136 frontend; lint/typecheck/secrets/збірки). Окремо real-DB db/users: 12/12 у per-run схемах ізольованої тестової БД через власний тимчасовий SSH-тунель; тунель автоматично закрито. Перевірено CAS password changes, login проти committed/uncommitted changes, concurrent admin changes, audit rollback. Повний real-DB/E2E фінального commit не повторювався; результати Claude нижче історичні. Тимчасовий frontend reproduction-тест підтвердив перший P2 і видалений; після видалення check:local повторено успішно.

Read-only SSH: control-server current `20896ddcb0c70f22cb101ba539cac048c333513a`, API/Nginx active, ready 200. Production-користувачі, паролі, конфігурації та PM2-процеси не змінювалися. Функціональний код reviewer не змінював; запис підготовлено локально без commit/push/deploy. Task 011 потребує виправлень; після них наступна задача — Dashboard, Jenkins лишається далеким backlog.

## Незалежний review Codex — Task 011.1 (2026-10-14)

Переглянуто `ac4d967` і docs-звіт `034794c`; початкове дерево чисте. Обидва попередні P2 виправлені: відповіді прив’язані до auth epoch/abort, користувачі доступні через cursor-пагінацію.

**Новий P2 — успіх створення користувача перезавантажує покинуту сторінку списку.** `frontend/src/pages/UsersPage.tsx:67`: pending CreateUserForm зберігає старий onCreated; пагінація дозволена під час створення, форма не unmount. Callback використовує data/reload старого cursor (`UsersPage.tsx:203`). Відтворено synthetic deferred POST: створення на сторінці 1 → «Далі» → рядки сторінки 2 → успішний POST → GET першої сторінки без after. Номер лишається «Сторінка 2», але рядки зникають до наступного polling: keyed resource отримує owned data старого ключа. Це не виправляється auth binding, оскільки сесія не змінилася. Потрібно застосовувати callback/reload актуальної сторінки або не дозволяти зміну cursor під час pending створення; додати regression для цього сценарію й помилки створення після переходу.

Незалежний check:local на Node.js 22 exit 0: 89 node:test, 380 backend, 10 smoke, 164 agent +3 opt-in пропущені, 151 frontend; lint/typecheck/secrets/збірки. UI Playwright із synthetic API: 2/2 desktop/mobile. Новий окремий reproduction-тест підтвердив дефект і видалений. Real-DB та повні user E2E цього разу не повторювалися (backend не змінено).

Read-only SSH: control-server current `ac4d967679a723db04185f04f2cdd4e1b6a1d259`, API/Nginx active, ready 200. Production-користувачі/паролі/конфігурації не змінювались. Task 011.1 потребує одного додаткового frontend-виправлення перед переходом до Dashboard. Запис review локальний, без commit/push/deploy; функціональний код reviewer не змінював.

## Незалежний review Codex — Task 011.2 (2026-10-14)

Переглянуто фінальний code commit `0b85151` і docs-звіт `cd48ef8`; початкове дерево чисте. Попередній P2 закрито: CreateUserForm викликає актуальний onCreated, що використовує data/reload поточного cursor. Нових блокувальних дефектів у переглянутому diff не знайдено. Це закриває зауваження review Task 011/011.1 у межах реалізованих сценаріїв.

Незалежно на Node.js 22: 157/157 frontend-тестів (включно з шістьма новими create-while-paging regression), typecheck, lint, frontend build, check:secrets і diff check успішні; UI Playwright із synthetic API 2/2 desktop/mobile. Початковий frontend-прогін був розпочатий перед перериванням review й завершився успішно; порівняння підтвердило той самий фінальний код. Повний check:local, real-DB і user E2E цього разу незалежно не повторювалися; результати Claude вище є історичними. Backend/схема/Agent не змінені.

Read-only SSH: control-server current `0b851511612096c05ba7825b15ab6c51f50975e7`, API/Nginx active, ready 200. Production-користувачі, паролі й конфігурації не змінювались. Запис review підготовлено локально без commit/push/deploy; функціональний код не змінено. Наступна задача — Dashboard за погодженим roadmap, потім Slack, історія метрик і production-підготовка.

## Незалежний review Codex — Task 012 (2026-10-14)

Переглянуто завершений code commit `1c6c58d` і docs-звіт `fe25d5e`; початкове робоче дерево чисте. Перевірено агрегати, freshness, виключення неактивних серверів, розділення live/notLive, bounded списки, permission-aware recentActions і read-only узгоджений snapshot. Нових блокувальних дефектів у переглянутих змінах Dashboard не знайдено.

Незалежно на Node.js 22: check:local exit 0 (89 node:test, 387 backend, 10 smoke, 164 agent +3 opt-in пропущені, 165 frontend; lint/typecheck/secrets/збірки). Окремі real-DB dashboard-тести — 6/6 у per-run схемах ізольованої тестової БД: порожня система, рахунки/JOIN, межі свіжості, обмежені списки й totals, права/overdue/read-only, READ ONLY транзакція. Власний тимчасовий SSH-тунель автоматично закрито. Локальні UI Playwright regression — 2/2 desktop/mobile зі synthetic API. Повний real-DB suite, dashboard E2E і real-PM2 E2E у цьому review не повторювались; їхні результати Claude вище є історичними.

Read-only SSH: control-server current `1c6c58df90083438cf2000a60c63ebe1c38e7eaa`, API/Nginx active, ready 200. Production-користувачі, passwords, серверні дані, Agent/broker і PM2-процеси reviewer не змінював. Відомий timeout graceful shutdown із long-poll описано у звіті деплою; у цьому review не відтворювався і не закритий — потрібна окрема перевірка/виправлення до фінальної production-підготовки.

Dashboard пройшов review; наступна задача за погодженим roadmap — Slack/alerts, потім історія метрик і production-підготовка. Запис review локальний без commit/push/deploy, функціональний код не змінено.

## Завершено за фактичними файлами

- Каркас каталогів, npm manifest/lockfile та залежність `pg`.
- Скрипти налаштування PostgreSQL, перевірки з'єднання та секретів; допоміжна логіка env/SCRAM/SQL/HBA.
- Unit та integration suites, `.env.example`, `.gitignore`, README і серверний звіт Task 001.
- Початкова інтеграція AI-контексту: AGENTS, ARCHITECTURE, DECISIONS, DEVELOPMENT_RULES, AI_WORKFLOW та цей документ. Код функцій не змінено, деплой не виконувався.

## Task 001 — частково підтверджено

Код і commit перевірені. Історичний серверний звіт Task 001 (роль/БД, HBA reload, `.env`, 46 unit + 15 integration тестів) винесено з публічного репозиторію; цей результат не відтворено незалежно. Task 001 не має статусу повністю технічно підтвердженого.

## Перевірки початкової інтеграції (`c6af8eb`)

| Перевірка | Результат |
|---|---|
| Середовище | Локальний macOS, Node.js v24.14.0, npm 11.9.0; ціль Node.js 22 LTS не перевірена |
| `npm run check:secrets` | Успіх до та після документування; `.env` ігнорується та не tracked |
| Доступна Git-історія | 1 початковий commit, 0 знахідок за чинними шаблонами й поточним DB_PASS; значення не виводились |
| `npm test` | 46/46 успішно |
| `npm run check` | Невдалий: integration-з'єднання заблоковано sandbox (`EPERM`) |
| Повторний `npm run test:integration` поза sandbox | 2 успішно, 10 невдало: `ECONNRESET` / `ECONNREFUSED` на `127.0.0.1:5432` |
| Привілейовані integration checks | Suite пропущено: потрібен root на хості PostgreSQL; 3 вкладені серверні тести не виконано |
| Lint/formatter, API/E2E | Інструменти lint/format не налаштовані; API та UI ще відсутні |

Звичайні integration-тести тоді не були штучно пропущені. Повний check не успішний. Початковий push було відкладено за умовою попереднього запиту. Ці результати не є новим запуском повного suite.

## Фіналізація архітектури та workflow (2026-10-12)

Completed: повторно прочитані код, тести, документація, Git history; вихідне дерево чисте, два commits (`ccbba13`, `c6af8eb`). Оновлено AGENTS, ARCHITECTURE, DECISIONS (ADR-001–005), DEVELOPMENT_RULES, AI_WORKFLOW, README та цей статус; створено DEPLOYMENT. Функціональні файли, production-конфігурації й служби не змінені; SSH-аудит сервера не виконувався.

Зафіксовано systemd для API/Agents, PM2 лише для керованих застосунків, статичний frontend через host Nginx, TypeScript для нових компонентів, Vitest за замовчуванням зі збереженням чинного node:test; контейнеризація API/Agents — окрема майбутня фаза. PostgreSQL/Nginx залишаються на хості.

| Поточна перевірка | Результат |
|---|---|
| `npm test` | 46/46 успішно, Node.js v24.14.0 / npm 11.9.0 |
| Вибрані env integration tests (`^#11\|^#12`) | 2/2: `.env` існує, валідний, права 600, власник поточний; ignored/untracked, скан секретів успішний |
| `npm run db:check` | Sandbox: EPERM; повтор поза sandbox: ECONNREFUSED на 127.0.0.1:5432; БД не підтверджена |
| Повний integration suite | Не повторювався: має DDL/DML, тестове середовище не підтверджено; нова вимога забороняє зміну production-даних |
| Lint/typecheck | Scripts/config відсутні; функціональний код не змінювався |

Актуальний запит дозволяє документаційний push за політиками гілки після успішних релевантних перевірок із чесним описом недоступності БД; попередня заборона push через повний check для цієї документаційної задачі уточнена. Commit hash і фактичний push status повідомляються у фінальному звіті; hash самого commit не записується в його власний вміст.

## Task 002 — базовий Central API (2026-10-12)

Стартовий стан: `main` = `d1c58b3`, робоче дерево чисте. Реалізовано `backend/` (TypeScript strict + Fastify 5): валідована env-конфігурація (process env > `.env`), `pg.Pool` з обмеженнями, `GET /health/live`, `GET /health/ready`, логування з redaction і request ID, 404/500 handlers, graceful shutdown. Додано Vitest, ESLint, typecheck, build, smoke і opt-in real-DB тест. Authentication/RBAC, міграції, CRUD, Agent, WebSocket, frontend і production-деплой **не реалізовані**. `.env`, production-конфігурації, БД, HBA, firewall і служби не змінювались; `db:setup` не запускався.

| Перевірка (поточна сесія) | Результат |
|---|---|
| Середовище | macOS; системний Node.js v24.14.0; перевірки на Node.js **v22.23.3** через `npx -y node@22` |
| `npm run typecheck` | Успіх (0 помилок) |
| `npm run lint` | Успіх (0 проблем) |
| `npm run backend:build` | Успіх |
| `test:backend` на Node 22 | 56/56 (config, API inject, database, lifecycle) |
| Smoke скомпільованого API на Node 22 | 5/5: live 200 / ready 503 без БД, SIGTERM/SIGINT → exit 0, подвійний SIGTERM, невалідна конфігурація → exit 1 без значень, зайнятий порт → exit 1 |
| `test:backend:db` (реальна PostgreSQL) | 1/1 успішно через SSH-тунель `127.0.0.1:15432` → сервер `127.0.0.1:5432`, `node_control_user`: `/health/ready` 200, пул після закриття 0 |
| Ручний loopback smoke | `127.0.0.1:3100` (перед стартом вільний), live 200, ready 200 (`DB_PORT=15432` з process env поверх `.env`), 404; SIGTERM → процес завершився, порт звільнено, пароль у логах відсутній. Тунель і процес закрито |
| Старі unit-тести (`npm test`) | 46/46 на Node 22 і на Node 24 |
| `npm run check:secrets`, `git diff --check` | Успіх |
| Старий `test:integration` (DDL/DML) | Не запускався свідомо — суперечить забороні змінювати production-дані |

Real-DB тест підтверджує лише: роль `node_control_user` може автентифікуватися в `node_control_db` через loopback сервера і виконати `SELECT 1`. Він не перевіряє HBA, firewall, TLS чи стан сторонніх служб — Task 001 у цій частині лишається частково підтвердженим.

## Task 002.1 — виправлення за review Codex (2026-10-12)

Review Codex (стан `36befba`) повторив 46 старих unit, 56 backend і 5 smoke тестів на Node v22.23.3, lint/typecheck/build/secrets — успішно; real-DB тест у review не повторювався. Знайдено два дефекти загальних error handlers (перевірено через тестові маршрути; health endpoints реальних credentials не розкривали):

1. 500-handler логував необроблений `Error` — синтетичний секрет із `message` потрапляв у логи.
2. 4xx-handler повертав довільні `error.name`/`error.message` — `statusCode: 400` не робить текст безпечним.

Виправлено (ADR-007): новий `backend/src/errors.ts` — у логи/stderr лише `category` + allowlisted `code`; клієнту — фіксований контракт (validation → `location/path/rule` зі схеми; інші 4xx → стандартний HTTP-текст; решта → загальний 500). `toSafeError`, що зберігав довільний `message`, видалено; `database`, `lifecycle`, `main` переведено на метадані; додано fatal handlers без message/stack. Lifecycle: `StartupError{cleanedUp}`; новий `server.ts` (`runServer`) гарантує завершення executable після невдалого старту (одразу при завислому cleanup, інакше unref-таймер). `freePort()` у тестах тепер відхиляє Promise при помилці listen і закриває сервер.

| Перевірка (поточна сесія, macOS) | Результат |
|---|---|
| `npm test` (старі node:test) | 46/46 на Node v22.23.3 і v24.14.0 |
| `npm run typecheck` / `npm run lint` / `npm run backend:build` | успіх |
| `test:backend` на Node v22.23.3 | 81/81 (було 56; нові: errors, server, helpers, lifecycle) |
| Перевірка regression-тестів на старому handler | тимчасово повернутий старий error handler → 14 тестів падають; код відновлено |
| `test:backend:smoke` на Node v22.23.3 | 7/7, у т.ч. процес із завислим cleanup та з відкритим handle завершується з кодом 1 за ~0,45 с |
| `test:backend:db` | 1/1 через SSH-тунель `127.0.0.1:15432` → сервер `127.0.0.1:5432`, лише `SELECT 1`; тунель закрито після тесту |
| `npm run check:local`, `check:secrets`, `git diff --check` | успіх |
| Старий `test:integration` (DDL/DML) | не запускався свідомо |

Production, реальний `.env`, БД, HBA, firewall і служби не змінювались; деплою не було. Окремо (до Task 002.1, на прямий запит користувача) код Task 002 був залитий у `/etc/pm2-dashboard` і зібраний там; API як сервіс не запускався. Код Task 002.1 на сервер не заливався.

## Task 003 — деплой Central API через systemd (2026-10-12)

**Active code revision на сервері: `5e7c11c8f217fc8d8161fdf023f42b593a1196d7`** (`feat: deploy central API with systemd`). Цей звіт додано пізнішим docs-commit, який на сервер не деплоївся.

Read-only аудит перед деплоєм (поточна сесія): hostname `control-server`, Ubuntu 26.04.1 LTS; `/usr/bin/node` v22.23.2 (nodesource), npm 10.9.8; порт 3100 вільний; користувача/групи `nodecontrol`, unit-ів `node-control*`, `/opt/node-control`, `/etc/node-control` не існувало; PM2 не встановлений; `/etc/pm2-dashboard/.env` — `600 root:root`, ключі `DB_*`; `SELECT 1` від `node_control_user` на `127.0.0.1:5432` — успіх. Baseline: `postgresql@18-main`, `nginx`, `docker` active; failed units 0; `secrets-manager`, `secrets-manager-cache` up; менеджер секретів API 200.

| Крок | Результат |
|---|---|
| Локальні перевірки перед commit | `npm test` 73/73 (46 старих + 27 deploy) на Node 22 і 24; typecheck, lint, build OK; `test:backend` 81/81 і smoke 7/7 на Node v22.23.3; `check:secrets`, `git diff --check`, `check:local` OK |
| Git | `5e7c11c` запушено в `origin/main` до деплою (без force) |
| Артефакт | `build-release.js` на Node v22.23.3 з `git archive 5e7c11c`; 14 файлів у manifest; без `.env*`, `.git`, `node_modules`, сирців, тестів, `.map`; SHA-256 архіву `2ad0ac39…3fced5b` |
| Передача | `scp` у новий `/root/node-control-deploy/<sha>/` (700); `sha256sum -c` на сервері — OK |
| Користувач | `nodecontrol` (system, `/usr/sbin/nologin`, home `/nonexistent`, без sudo) |
| Prepare | checksum → manifest → `npm ci --omit=dev` (61 пакет) → `releases/5e7c11c…` `root:root 755/644`; запис для `nodecontrol` неможливий |
| Конфіг | `/etc/node-control/api.env` створено з `DB_*` legacy + `NODE_ENV=production`, `API_HOST=127.0.0.1`, `API_PORT=3100`, `LOG_LEVEL=info`; `600 nodecontrol:nodecontrol`, каталог `750 root:nodecontrol`; legacy `.env` не змінено й недоступний `nodecontrol` |
| Unit | `systemd-analyze verify` — exit 0 (попередження лише від чужих xfs units); `systemd-analyze security` — exposure 1.3 OK |
| Запуск | `activate` (previous=none) → `enable` → `restart`; `enabled`, `active`; процес `nodecontrol`, `/usr/bin/node /opt/node-control/current/backend/dist/main.js` |
| Health | `/health/live` 200 `{"status":"ok"}`, `/health/ready` 200 `{"status":"ready"}`; обидва `Cache-Control: no-store`, `x-request-id`; `/nope` → 404 |
| Мережа | listener лише `127.0.0.1:3100` (без `0.0.0.0`/IPv6); з публічної адреси 3100 недоступний; SSH forwarding з Mac → ready 200 |
| Journal | рівнів warn/error/fatal — 0; входжень DB_PASS — 0 |
| Restart | `systemctl restart` → чистий shutdown, новий PID, health 200; SIGKILL власного процесу → `Restart=on-failure` підняв за ~5 с (`NRestarts=1`), ready 200 |
| Revision | `current → releases/5e7c11c…`, `RELEASE.json.revision` збігається |
| Сторонні служби після | ті самі active, failed 0, менеджер секретів 200, нових listeners крім `127.0.0.1:3100` немає; нових FATAL/ERROR у лозі PostgreSQL немає |

Rollback підготовлено до першого старту (перший деплой: `systemctl disable --now node-control-api`); не знадобився. Автозапуск після reboot забезпечено `enable` (`multi-user.target.wants`), але реальний reboot не виконувався — сервер спільний. `db:setup`, HBA, firewall, PostgreSQL/Nginx/менеджер секретів не змінювались і не перезапускались; старий integration suite не запускався.

## Task 004 — ізольована тестова БД і версійні міграції (2026-10-12)

**Active code revision на сервері: `5ec6ece9a1055afb5c7f9708e509e21c788acd94`** (`feat: add isolated database tests and versioned migrations`); previous — `5e7c11c`. Цей звіт — пізніший docs-commit, на сервер не деплоївся.

Read-only аудит перед змінами (поточна сесія): hostname `control-server`, `/usr/bin/node` v22.23.2; `node-control-api` enabled/active, current `5e7c11c`, live/ready 200; `node_control_db` — жодних об'єктів у `public`; ролей/БД `node_control_test%` не існувало; baseline: `postgresql@18-main`, `nginx`, `docker` active, failed 0, менеджер секретів up/200.

| Крок | Результат |
|---|---|
| Тестові ресурси | `scripts/setup-test-db.js` (root, з тимчасової копії `/root/node-control-tools`, 700): створено `node_control_test_user` (LOGIN, без SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS, без членств, `COMMENT`-маркер) і `node_control_test_db` (owner — тестова роль, `REVOKE ALL FROM PUBLIC`). Isolation check: немає `CONNECT` до `node_control_db`. Повторний запуск — без ротації. Credentials: `/root/.config/node-control/test-db.env` `600 root`; локально `.env.test` `600`, ignored |
| Unit / regression (Node v22.23.3) | `npm test` 80/80 (node:test; також на Node 24); `test:backend` 121/121; smoke 7/7; typecheck, lint, build, `check:secrets`, `git diff --check` — OK |
| Real-DB suite | `test:backend:db` 15/15 через SSH-тунель `127.0.0.1:15432`: ізоляція (production DB → 42501, CREATE DATABASE → 42501, атрибути/членства), чистий up → структура, повторний up no-op, status, email-політика, NOT NULL/defaults/trigger, rollback помилкової міграції, 3 конкурентні up → 1 запис, cleanup лише власної схеми. Після прогону в тестовій БД 0 схем `nc_test_*` |
| Старий `test:integration` | переведено на read-only; 12/12 проти production через тимчасовий тунель (закрито) |
| Git / артефакт | `5ec6ece` запушено до деплою; `build-release.js` на Node 22: 18 файлів (+ `migrate*.js`, `migrations.js`, SQL-міграція), без тестів/fixtures/`.env*`/`.map`; SHA-256 `23521bd8…4da613a`; `sha256sum -c` на сервері OK |
| Prepare | `npm ci --omit=dev` (86 пакетів): є `node-pg-migrate`, `pg`, `fastify`; немає `tsx`/`vitest`/`typescript`; `api.env` — `kept` (не змінено) |
| Репетиція CLI з артефакту | на `node_control_test_db` (схема `public`, роль тестова): status → up → повторний up (no-op) → status; `down` → usage, exit 2. У тестовій БД лишились `users`/`pgmigrations` у `public` — очікуваний стан репетиції |
| Backup | `pg_dump -Fc node_control_db` → `/root/node-control-backups/node_control_db-20261012T160501Z-pre-5ec6ece….dump` (`600 root`, каталог 700); `pg_restore --list` читає; 0 об'єктів — БД до міграції була порожня |
| Production migration | як `nodecontrol` з `releases/5ec6ece…`, `ENV_FILE=/etc/node-control/api.env`: status pending=1 → `up` застосував `1791900000000_create-users` → status applied=1 pending=0 |
| Read-only перевірка схеми | `users`: 6 колонок/типи/defaults за ADR-010; constraints `users_pkey`, `users_email_key`, `users_email_normalized`, `users_email_format`, `users_password_hash_not_empty`; тригер `users_set_updated_at`; власник об'єктів `node_control_user`; `pgmigrations` — 1 рядок; **`users` — 0 рядків** |
| Активація | `activate` (previous=`5e7c11c`) → `systemctl restart node-control-api`; enabled/active; процес `nodecontrol`; listener лише `127.0.0.1:3100`; ззовні 3100 недоступний |
| Health | live 200 `{"status":"ok"}`, ready 200 `{"status":"ready"}`, `no-store`, `x-request-id`; `/nope` 404 |
| Journal / сторонні | warn+ 0, входжень DB_PASS 0; PostgreSQL/Nginx/Docker active, failed 0, менеджер секретів up/200 |

Rollback підготовлено до production `up`: код — `server-release.js rollback` (current↔previous) + restart лише API; схема additive і сумісна з health-only `5e7c11c`, тож лишається. Не застосовувався. Restore з backup — лише окремим рішенням (DEPLOYMENT). PostgreSQL-лог після деплою: лише очікувані помилки негативних тестів у `node_control_test_db`.

## Release blockers (до публічного production-запуску)

1. **Мережева політика PostgreSQL** production-сервера потребує окремої перевірки й обмеження (деталі — лише в приватних операційних нотатках). Відкрито.
2. **NC-SEC-001** (Ajv `instancePath` для динамічних ключів) — відкрито; схеми лише з явними `properties` і `additionalProperties: false`.
3. **Публічний сайт `https://control.example.com`** налаштований власником (Nginx + Let's Encrypt, `conf.d/control.example.com.conf`); задачі Node Control його не змінюють. Рекомендовано власнику до відкриття для користувачів (ADR-013): заголовки безпеки (CSP `default-src 'self'`, `X-Frame-Options`, `nosniff`, `Referrer-Policy`, HSTS), `no-cache` для SPA-маршрутів, `immutable` + `try_files $uri =404` для `/assets/`.
4. ~~Адміністратора не створено~~ — 2026-10-12 створено першого адміністратора (`admin@example.com`) через bootstrap CLI як `nodecontrol`; пароль згенеровано на сервері (20 символів), передано через stdin і повідомлено користувачу один раз; у репозиторії/логах його немає. Audit: `admin.bootstrap` success. **Потрібна функція зміни пароля** (наступне завдання) — до неї пароль тимчасовий.

## Rollback-реліз: доставка повідомлень виведеного правила (2026-10-15, другий review Codex P2)

**Зауваження.** У compat-релізі `1a6b82c251539aa9348b1fee6b997a0f3a254434` оцінювання `server_memory` вимкнено, але `claim()` не мав захисту від доставки його outbox. Міграція 8 свідомо не чіпає `sending` із живим lease; якщо доставку перервано й API відкочено, lease спливає вже в compat-релізі — і той надіслав би `server_memory` у Slack. Codex відтворив: `claim` → `{rule: server_memory, resolution: retired, kind: firing}`.

**Захист** (комміт **`70ddd1f40b205306f0d61eb278cca9646c7e7d87`**, `fix(alerts): prevent retired rule delivery in rollback release`, гілка `release/monitoring-rollback-compat`; перенесено з ADR-023 store): явний `RETIRED_RULES = ['server_memory']`; `claim` спершу скасовує `queued` і `sending` з протермінованим lease retired-правил (`cancelled`, `last_error = rule_retired`, параметризований SQL); сам SQL вибірки (`CLAIM_SQL`) містить `NOT EXISTS … rule = ANY($4)` з `FOR UPDATE OF o SKIP LOCKED` — гонку між cleanup і claim закрито. Живий lease не перехоплюється й не позначається недоставленим; повернений `finish()` на retry елемент скасовується наступним `claim`. Не залежить від `evaluateOnce` (рушій може бути вимкнений). Інші правила й доставка Slack загалом не змінені.

| Перевірка (Node 22) | Результат |
|---|---|
| Новий regression (real DB) `retired-delivery` 6 | на незміненому `1a6b82c251539aa9348b1fee6b997a0f3a254434`: 6/6 падінь (claim видає `server_memory:firing`, reminder/resolved, протермінований `sending`; `CLAIM_SQL` відсутній) — відтворення; після виправлення 6/6: queued firing/reminder/resolved → `cancelled`/`rule_retired`, claim порожній; протермінований `sending` → cancelled; живий lease не змінено → retry → наступний claim скасовує; ідемпотентність; надіслана історія й інцидент без змін; `process_cpu` доставляється; recovery не створено; `CLAIM_SQL` без cleanup не бере retired-рядок |
| `rollback-compat` 13 | 13/13 |
| `npm run check:local` | exit 0: node:test 89/89, backend 436/436, smoke 10/10, agent 164/164 (+3 opt-in), frontend 198/198, typecheck, lint, збірки, `check:secrets` OK |
| Real-DB (`test:backend:db`) | 113/113 |
| E2E | 19/19 (+1 opt-in), включно з `rollback-compat.spec.ts` |
| Real-PM2 E2E | 1/1 |
| `git diff --check`, `check:secrets` | OK |
| Артефакт | штатний `build-release.js --remote-branch origin/release/monitoring-rollback-compat`: `node-control-api-70ddd1f….tar.gz` SHA-256 `fba970ac…be11e`, `shasum -c` OK; `RELEASE.json` revision `70ddd1f…`, 63 файли, `verifyManifest` 0 помилок, 9 міграцій; `backend/dist` (без source maps), `frontend/dist`, `backend/migrations` побайтово = тестована збірка. Зберігається в оператора поза репозиторієм (`rollback-artifacts/70ddd1f`) |

**Ціль відкату тепер `70ddd1f`.** Ревізія `1a6b82c251539aa9348b1fee6b997a0f3a254434` і її артефакти мають відомий дефект доставки retired-правила й не рекомендовані; розділ нижче — історичний запис її перевірок. Production rollback не виконувався, production не змінювався, реальні Slack-повідомлення не надсилались.

## Безпечний rollback після ADR-023: compatibility-реліз (2026-10-15, review Codex P2)

**Зауваження.** DEPLOYMENT описував відкат як «старий Agent → старий API `c016beb`». Але ADR-023 API зберігає мінімальні snapshot і для Agent 0.4.x, тож після повернення старого Agent повні дані не відновлюються, а офлайн/деактивовані ноди не надішлють нового heartbeat. Відтворено тестом на коді `c016beb` (БД зі станами, які лишає ADR-023): server detail 500 (serializer вимагає `uptimeSeconds`), Dashboard 503, оцінювання сповіщень `TypeError … reading 'totalBytes'` у кожному циклі, heartbeat Agent 0.5.0 → 400; крім того, старий UI не розбирає мінімальний snapshot і `retired`, а в релізі немає файлу вже застосованої міграції 8.

**Механізм.** Окремий compatibility-реліз у гілці `release/monitoring-rollback-compat` (від `c016beb`, без переписування історії), commit **`1a6b82c251539aa9348b1fee6b997a0f3a254434`** (`fix(deploy): make monitoring rollback safe for minimal snapshots`). Лише вузькі зміни старого коду: snapshot-контракт приймає обидві версії Agent (legacy-поля строго опційні), Dashboard/детальна сторінка/alerts читають відсутні host-метрики як `null`, `server_memory` не оцінюється, UI розбирає мінімальні snapshot і `retired` та ховає неактивні пороги пам'яті ОС, додано файл міграції 8 (байт-у-байт той самий). Поточний ADR-023 реліз і production не змінювались; deployment tooling не змінювався — збірка штатним `build-release.js --remote-branch origin/release/monitoring-rollback-compat` (перевірка clean + pushed revision збережена).

| Перевірка compat-релізу (Node 22) | Результат |
|---|---|
| Regression (real DB) `rollback-compat` 13 | на незміненому `c016beb`: 4 падіння (500/503/TypeError/400) — відтворення; на compat: 13/13 — online/offline/деактивований/never-connected, змішані legacy і мінімальні snapshot, server detail і Dashboard 200 без нових heartbeat, null замість вигаданих метрик, оцінювання без TypeError і без нових `server_memory`/recovery, історія з `retired`, heartbeat 0.4.x і 0.5.0 приймаються, невідомі поля/некоректний load/legacy-форма → 400, без credential → 401, анонімні читання → 401 |
| `npm run check:local` | exit 0: node:test 89/89, backend 436/436, smoke 10/10, agent 164/164 (+3 opt-in), frontend 198/198 (нові `rollback-compat` 3: мінімальний snapshot, null-метрики Dashboard, `retired` в історії), typecheck, lint, збірки, `check:secrets` OK |
| Real-DB (`test:backend:db`) | 107/107 |
| E2E | 19/19 (+1 opt-in), новий `rollback-compat.spec.ts`: Dashboard, сторінка сервера й історія сповіщень з мінімальними snapshot і `retired` — без помилок у браузері |
| Real-PM2 E2E | 1/1 |
| Артефакт | `node-control-api-1a6b82c….tar.gz`: `shasum -c` OK; `RELEASE.json` revision `1a6b82c…`, 63 файли, `verifyManifest` 0 помилок, 9 міграцій; `backend/dist` (без source maps), `frontend/dist`, `backend/migrations` побайтово = тестована збірка; повторна збірка — ті самі хеші всіх файлів manifest (API 63, Agent 33), tar.gz SHA-256 відрізняється (час файлів) |

Адаптовані старі тести compat-гілки: перевірки відкриття `server_memory` замінено перевіркою, що compat його не оцінює; «відсутні дані не закривають інцидент» і скидання серій — на CPU процесу; списки міграцій — з міграцією 8.

**Ціль відкату** (історично): API/frontend `1a6b82c` (Agent 0.4.x і 0.5.0) — **замінено на `70ddd1f`** (див. розділ вище: дефект доставки retired-правила); Agent не відкочувати. Процедура, перевірки й повернення — DEPLOYMENT, «Спрощення серверного моніторингу». Production rollback не виконувався; production не змінювався.

## Спрощення серверного моніторингу: лише поточний load average (2026-10-15, ADR-023)

Перший крок оновленого плану (далі: виправлення діалогів frontend → незалежний review Slack/alerts → документація й інсталятори → фінальна production-підготовка). Сервери моніторить Zabbix; Node Control лишає з системних показників лише поточний load average і службову доступність Agent. Історія серверних метрик виключена з roadmap; історія метрик застосунків не погоджена.

**Зроблено:**
- **Контракт heartbeat (сумісний).** API приймає мінімальний heartbeat Agent ≥ 0.5.0 (`agentVersion, hostname, platform, arch, loadAverage`) і старий 0.4.x: legacy `uptimeSeconds`, `cpuCount`, `memory` перевіряються за точною старою схемою, але не зберігаються й не повертаються; невідомі поля → 400; `loadAverage` — лише JSON-числа. Старі рядки `server_heartbeats` читаються через `normalizeSnapshot`.
- **Agent 0.5.0** не читає з ОС пам'ять, uptime і кількість ядер; PM2-збір без змін.
- **Dashboard і сторінка сервера:** без колонок пам'яті/uptime і кількості ядер; на сервері — один рядок load average (для офлайн-сервера старе значення не показується як поточне), ідентифікація агента — у «Системних подробицях».
- **`server_memory` виведено:** міграція `1791900000008` (forward) і runtime-захист — відкриті інциденти закриваються як `retired` (не відновлення, без recovery-повідомлень), повідомлення в черзі скасовуються (`rule_retired`), стан умов видаляється; доставка не бере повідомлень виведеного правила навіть при вимкненому рушії. Історія й audit збережені.
- **Налаштування:** пороги пам'яті ОС прибрано з API/UI (PATCH з ними → 400); колонки `memory_*` у БД лишаються неактивними; `ALERTS_MEMORY_*` ігноруються з попередженням. Пояснення підтверджень тепер про CPU процесу.

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 446/446, smoke 10/10, agent 165/165 (+3 opt-in), frontend 198/198, typecheck, lint, збірки, `check:secrets` OK |
| UI Playwright (синтетичний API) | 13/13 (1440/390, light/dark; правила — 13 полів без пам'яті ОС) |
| Real-DB (`test:backend:db`) | 98/98, нові `db/retire-memory` 3: міграція на даних до неї; повторне виведення в оцінюванні й ідемпотентність; `claim` не бере й скасовує повідомлення виведеного правила; legacy-рядок heartbeat читається; тест скидання серій при зміні правил переведено з пам'яті ОС на CPU процесу |
| E2E (тестова БД) | 18/18 (+1 opt-in); dashboard читає legacy-рядок 0.4.x без показу пам'яті |
| Real-PM2 E2E | 1/1 |
| Залишки | 0 схем `nc_test_*`, PM2 daemon і `~/.pm2` відсутні |

Тести, адаптовані до нового scope: перевірки пам'яті ОС у правилах, Dashboard і сторінці сервера замінено перевірками відсутності цих даних і виведення правила; тест «відсутні дані не закривають інцидент» і тест скидання серій перенесено на CPU процесу (зміст перевірки той самий). Під час першого прогону real-DB раз упав нестабільний тест гонки revoke/heartbeat (затримки тунелю), повтор і повний прогін — зелені.

**Деплой (2026-10-15).** Revision **`cf2f0f7e7c2e89965031fe877e678cc543cf0931`** (код — `db72d1c`, далі лише docs) для API/frontend і Agent; порядок за ADR-023.

| Крок | Результат |
|---|---|
| Baseline | API на `c016beb`, Agent 0.4.0 на `2fe4d95`; PM2: 5 процесів online, restarts 0, daemon один |
| Артефакти | `sha256sum -c` OK, manifest revision збігається; усі unit-файли (API, Agent, broker, exporter, timer) ідентичні встановленим — без `daemon-reload` |
| API/frontend | backup лише `node_control_db` (`pg_dump -Fc`, 600, `pg_restore --list` OK) → `migrate up` (`1791900000008`, pending 0) → activate (`previous` = `c016beb`) → restart лише API; live/ready 200 локально й HTTPS, анонімні API → 401, HTTPS віддає новий bundle, 0 помилок, `nginx -t` OK |
| Міграція на даних | активних `server_memory`-інцидентів не було → нічого не закрито й не скасовано; історичний закритий інцидент і його надіслані повідомлення не змінились; налаштування сповіщень (рушій і доставка ввімкнені, revision 4) не змінювались |
| Старий Agent | після рестарту API Agent 0.4.0 далі приймається: heartbeat 14 с, legacy-поля не збережено |
| Agent 0.5.0 | змінились лише `config.js` (версія) і `snapshot.js`; broker/exporter їх не імпортують → не перезапускались (broker той самий PID); activate (`previous` = `2fe4d95`) → restart лише Agent: heartbeat/inventory accepted, control/logs poll ok, 0 помилок; у БД snapshot = `agentVersion, arch, hostname, loadAverage, platform` (0.5.0) |
| PM2 до/після | PID, час старту й restarts усіх 5 застосунків і daemon — без змін; автозапуск `pm2-<owner>` не змінювався (enabled) |

**Rollback** (DEPLOYMENT, ADR-023): спершу Agent → `2fe4d95` + restart лише Agent (старий API не приймає мінімальний heartbeat), потім за потреби API → `c016beb` + restart. Схема не відкочується; backup БД не відновлюється поверх нових даних.

_Уточнення 2026-10-15 (review Codex P2):_ описана тут ціль `c016beb` несумісна з мінімальними snapshot у БД — див. наступний розділ; актуальна ціль відкату — compatibility-реліз `70ddd1f` (`1a6b82c` має дефект доставки retired-правила).

## Автозапуск PM2 на керованій ноді після reboot (2026-10-15)

**Симптом.** Після reboot керованої ноди PM2 daemon і застосунки не запустились; оператор запустив їх вручну.

**Причина (за доказами).** Автозапуск PM2 на ноді ніколи не був налаштований: немає `pm2-*.service` (системних і користувацьких, lingering вимкнено), `@reboot` у cron, init.d чи rc.local; у журналах попередніх boot запусків PM2 немає. `pm2.log`: після boot daemon стартував окремо через ~1,5 хв, застосунки — поодинці з інтервалами (ручний запуск). Збережений `dump.pm2` був на 9 днів старіший, імовірно теж після ручного запуску (припущення). Ручний запуск змінив початковий стан, тож інші можливі причини (наприклад, служба, що існувала й була видалена раніше) доказами повністю не виключені.

**Факти середовища:** власник PM2 — звичайний користувач (не root), PM2_HOME у його home; Node.js 22 системний (`/usr/bin/node`, без NVM), PM2 6 глобальний (`/usr/lib/node_modules/pm2/bin/pm2`); один daemon; інших власників PM2 чи менеджерів процесів немає.

**Зроблено** (процедура — [DEPLOYMENT](DEPLOYMENT.md), «Автозапуск PM2 після reboot»):
- baseline: 5 застосунків, усі online, без `stopped`/`errored`, рестартів 0 — погоджений набір;
- backup `dump.pm2` і `dump.pm2.bak` у root-only каталог (`700`/`600`); попередньої PM2-служби не було;
- `pm2 save` від власника в наявний daemon; новий dump: 5 записів, назви збігаються, усі online;
- `pm2-<owner>.service` — стандартний шаблон PM2 (Type=forking, User=власник, HOME/PM2_HOME, абсолютний PATH і `pm2 resurrect`/`kill`), `systemd-analyze verify` OK, `enabled`, **не запущена** (daemon лишається ручним до наступного reboot).

| Перевірка (операційна, не тести коду) | Результат |
|---|---|
| Служба | enabled, inactive; User, HOME, PM2_HOME, ExecStart/ExecStop, PIDFile відповідають власнику; executable доступні власнику, PM2_HOME доступний на запис |
| Список | dump = поточний набір online-застосунків (5) |
| Baseline до/після | PID, час старту й restarts усіх 5 застосунків і PID/час daemon — без змін; daemon один |
| Node Control | Agent, broker, exporter timer active/enabled; inventory 19 с, стан ok, 5 процесів; Agent: heartbeat/inventory accepted, 0 помилок |

`systemd-analyze verify` спершу не перевірив тимчасовий файл (systemd приймає лише імена `*.service`), і служба встановилася без перевірки; перевірку одразу виконано на встановленому файлі — без помилок.

**Не підтверджено:** фактичний автозапуск після reboot (reboot-тест не виконувався без окремого погодження). Наступний reboot — перший запуск через службу; після нього перевірити `systemctl status`, `journalctl -b`, список процесів і inventory. Зауваження: `dump.pm2` має права PM2 за замовчуванням (`664`), але home власника закритий для інших (`750`); не змінювалось.

**Rollback:** `systemctl disable pm2-<owner>` (застосунки не зупиняються), видалити або повернути службу + `daemon-reload`, за потреби повернути dump із root-only backup. Backup не видаляти. API, frontend, Agent не передеплоювались.

## Єдиний дизайн frontend — «спокійна інфраструктурна консоль» (2026-10-15)

Лише frontend: API-контракти, RBAC, CSRF, сесії, worker/outbox, Agent/broker, PM2, БД і міграції не змінювались. Правила оформлення — [DEVELOPMENT_RULES](DEVELOPMENT_RULES.md), «Frontend design».

**Спільне:**
- tokens у `styles.css` (поверхні, текст, межі, primary, success/warning/danger із м'якими фонами, відступи 4–32 px, два радіуси, `--font-sm`/`--font-xs`, висоти `--control-h` 40/44 px і `--control-sm` 32/40 px), світла й темна теми;
- `components/ui.tsx`: `PageHeader`, `Section`, `StatusIndicator` (крапка + текст; норма тиха, `warn`/`bad` — колір на м'якому фоні);
- `Dialog`: portal у `<body>`, `#root` — `inert`, фокус у порядку документа, Tab усередині, повернення фокуса, Escape не закриває під час запиту; `FormDialog` — форма створення з питанням перед втратою введених даних;
- каркас: групи «Моніторинг»/«Адміністрування» за правами (порожні групи приховано), профіль унизу (email, роль, «Обліковий запис», «Вийти»), topbar лише на мобільних (кнопка «Меню», Escape закриває й повертає фокус).

**Сторінки:**
- Огляд: спершу «Потребують уваги», далі підсумки, сервери, останні дії; пояснення — у «Як читати ці дані»; Load avg пояснено видимим текстом, а не `title`.
- Сервери: «Додати сервер» у заголовку → вікно; невідомий результат (немає відповіді) прямо названо й список перечитується; запит прив'язаний до сесії та скасовується при виході зі сторінки (раніше — без abort/binding).
- Сервер: компактна шапка (стан, останній сигнал), метрики heartbeat (офлайн — «останній відомий знімок»), сервіси — головний блок, системні подробиці — у disclosure, ключ агента — другорядна секція за правами.
- Застосунки/таблиці: назва — головний акцент, PM2 id і режим — другорядні, числа праворуч із tabular figures, «—» для невідомого; спільний час збору — над таблицею, лише коли однаковий для всіх рядків.
- Сповіщення: стан рушія розрізняє «вимкнено» (попередження), «невідомо» (помилка) і «працює» (тихий рядок); активні проблеми — головний блок, історія окремо, доставка (admin) — у disclosure.
- Користувачі: «Новий користувач» у заголовку → вікно; логіка гонок Task 011.2 (`latestOnCreated`, binding, abort) без змін.
- Налаштування: Slack — стан → основна дія (зберегти webhook / тестове повідомлення) → інші дії; webhook write-only; сітку правил Task 013.2 збережено. Аудит і обліковий запис — спільні заголовок, таблиця й форма.

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 438/438, smoke 10/10, agent 164/164 (+3 opt-in), frontend 195/195, typecheck, lint, збірки, `check:secrets` OK |
| Нові frontend | `layout.test.tsx` 10: навігація за правами (admin/operator/viewer), профіль, мобільне меню й Escape, фокус у вікні і повернення, Tab-цикл, питання перед втратою введеного, pending (Escape/«Скасувати» неактивні, один POST), невідомий результат → перечитування, пізня відповідь після виходу зі сторінки; `control.test` +1: меню рядка не закривається від polling |
| UI Playwright (синтетичний API) | 13/13, новий `design.spec.ts`: 5 сторінок × 1440/390 px × light/dark — без горизонтального скролу, рівно дві висоти контролів, перемикачі 40×24, жодної мутації; мобільне меню без прихованих focusable; `inert` фону у вікні; меню рядка переживає polling |
| E2E (тестова БД) | 18/18 (+1 opt-in); адаптовано до вікон створення й disclosure системних подробиць |
| Real-PM2 E2E | 1/1 |
| Залишки | 0 схем `nc_test_*` (дві від перерваних прогонів видалено), PM2 daemon і `~/.pm2` відсутні |

Перші прогони впали через сон Mac посеред тестів (тайм-аути, обрив тунелю, тестовий PM2 daemon, що лишився після обриву — зупинено); під `caffeinate` усе пройшло. Візуальна перевірка знайшла й виправила дві вади: фокус у вікні не потрапляв у поле (порядок `querySelectorAll` зі списком селекторів) і перемикач доставки Slack розтягувався загальним правилом полів.

**Деплой (2026-10-15).** Code revision **`c016bebe98b33d862ebefde0bfbdca6041cd5311`** (`refactor(ui): align monitoring and administration pages`, на основі `6e0efee`).

| Крок | Результат |
|---|---|
| Перед | API active, ready 200; активний реліз `3153abc` (ціль rollback) |
| Артефакт | `sha256sum -c` OK, manifest revision збігається; unit ідентичний установленому; міграцій немає (applied 8, pending 0) |
| Реліз | `current` → `c016beb`, `previous` → `3153abc`; restart лише `node-control-api` |
| Після | active під `nodecontrol`, listener лише loopback :3100; live/ready 200 локально й через HTTPS; анонімні `/api/auth/me`, `/api/servers`, `/api/settings/alerts` → 401; HTTPS віддає новий bundle (той самий хеш, що на диску); SPA-маршрути 200; 0 помилок у журналі; `nginx -t` OK |

Read-only smoke без входу: production-налаштування, користувачі, паролі, Slack-інтеграція й стан доставки, Agent/broker і PM2 не змінювались; Slack-тестів не надсилалось.

**Rollback:** `server-release.js rollback` → `3153abc`, restart `node-control-api` (міграцій і змін unit немає; дані й конфігурацію не відкочувати).

Обмеження: створення сервера/користувача під час гортання сторінок у браузері тепер недоступне (фон `inert`), але логіка пізніх відповідей і тести Task 011.2 збережені. Скриншоти «до» є лише для 1440 px.

## Task 013.2 (UI) — спрощений layout «Правил сповіщень» (2026-10-15)

Номер 013.2 вже використано для виправлення egress (розділ нижче); це окреме UI-завдання з тим самим номером. Стан на початок: `main` = `26cca5b`, дерево чисте. Лише frontend: API, payload, валідація, permissions, optimistic concurrency, webhook, worker і backend не змінювались.

**Зроблено** (`frontend/src/pages/SettingsPage.tsx`, `frontend/src/styles.css`):
- Одна картка до 1080 px; групи «Загальний стан», «Навантаження», «Процеси», «Цикл і повтори», «Додаткові параметри» (згорнуті) розділені лінією, без вкладених рамок.
- Кожен рядок має однакову сітку: назва й одне пояснення ліворуч; праворуч один контрол або пара однакових («Проблема / Відновлення», «Кількість / За період»). Одиночний контрол займає першу колонку пари, тож ширина всюди однакова.
- Поля мають висоту 44 px і одиницю як суфікс. Видимі підписи короткі; повні доступні імена збережено (`aria-label`, напр. «CPU процесу — поріг відновлення, %»).
- Межі й типові значення показуються кнопкою «Показати межі й типові» (`aria-pressed`, не hover), прив'язаною через `aria-describedby`. Помилка замінює підказку під своїм полем і не зсуває пару.
- Пояснення зберігають зміст: CPU PM2 може перевищувати 100 %; пам'ять ОС — не пам'ять застосунку.
- Рушій і нагадування — перемикачі (native checkbox, `role="switch"`). Інтервал нагадувань лишається редагованим і валідованим, коли нагадування вимкнені, — як раніше; це пояснено в тексті рядка, тож прихованих полів, що блокують збереження, немає.
- Унизу одна панель дій: повідомлення результату/конфлікту («Перечитати стан»), компактний індикатор «Є незбережені зміни.», «Скасувати зміни», «Зберегти». Панель **не sticky**: у full-page перевірці sticky-панель перекривала вміст, тому лишено звичайний потік (дозволено умовою «sticky лише без перекриття»).
- Мобільна версія (≤ 760 px): пояснення над контролами, пари поруч, без горизонтального скролу, кнопки 44 px.

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 438/438, smoke 10/10, agent 164/164 (+3 opt-in), frontend 184/184 (+1 тест layout: короткі підписи з повними іменами, межі за кнопкою, помилка замість підказки, «Скасувати зміни», перемикачі дають той самий payload), typecheck, lint, збірки, `check:secrets` OK |
| UI Playwright (синтетичний API) | 6/6, новий `settings-layout.spec.ts` (1440/390 × light/dark): 15 полів однакової висоти (40–46 px) і ширини, пари на одній лінії, форма ≤ 1100 px, без горизонтального скролу, помилка біля поля без зсуву пари, додаткові параметри відкриті |
| Real-DB (`test:backend:db`) | 94/94. Перший прогін — 92/94: `control` deadlines (15 с) і `servers` revoke race (6 с) впали через затримки SSH-тунелю; backend не змінювався, повтор цих файлів 22/22 і всього набору 94/94 |
| E2E (тестова БД) | 18/18 (+1 opt-in), зокрема `settings.spec.ts` з новою розміткою |
| Real-PM2 E2E | 1/1 |
| `git diff --check`; залишки | OK; 0 схем `nc_test_*`; PM2 daemon і `~/.pm2` відсутні |

Screenshots до/після — лише синтетичні дані (scratchpad, не в репозиторії). Реальних Slack-повідомлень не надсилалось.

**Деплой (2026-10-15).** Code revision **`3153abcf52996ddfc563a3dbf30c873ebbaa3d00`** (`refactor(settings): simplify alert rules layout and align controls`).

| Крок | Результат |
|---|---|
| Артефакт | `sha256sum -c` OK, manifest revision збігається; юніт ідентичний установленому (`cmp`), `daemon-reload` не потрібен |
| Міграції | немає (`migrate.js status`: усі applied, pending відсутні); backup БД не знадобився |
| Реліз | `current` → `3153abc`, `previous` → `9e7f71b` (ціль rollback); restart лише `node-control-api` |
| Після | active, `User=nodecontrol`, `IPAddressDeny` порожній, listener лише `127.0.0.1:3100`; live/ready 200 локально й HTTPS; анонімні `/api/settings/alerts` і `/api/auth/me` → 401; HTTPS віддає новий bundle з `current/frontend/dist`; 0 error у журналі після restart; `nginx -t` OK |
| Agent/broker | не змінювались (`2fe4d95`) |

Production-налаштування сповіщень, webhook, стан доставки й користувачі не змінювались: реліз лише frontend, без міграцій, жодних мутуючих запитів під час перевірок, Slack-тест не натискався. Пряме read-only звіряння таблиць `alert_settings`/`alert_slack_integration` не виконано — читання production БД заблоковане політикою дозволів сесії.

**Rollback:** `server-release.js rollback` → `9e7f71b`, restart `node-control-api` (міграцій і змін юніта немає).

## Task 013.2 — Slack-тест завершувався тайм-аутом: egress API-юніта (2026-10-15)

**Симптом.** Після налаштування webhook в UI тестове повідомлення не надходило в Slack. Audit показав обидва тести (22:09 і 22:10 UTC) як `integration.slack_test_result` з `unknown/timeout` — рівно 5 с, без відповіді.

**Діагностика** (лише метадані, без значення webhook):
- DNS `hooks.slack.com` резолвиться; TLS-з'єднання з сервера встановлюється за ~0,06 с (`curl -4` до кореня хоста, 302);
- `fetch` Node.js від користувача `nodecontrol` поза systemd — відповідь за 0,3 с;
- у юніті `node-control-api` (з Task 003) стояло `IPAddressDeny=any` + `IPAddressAllow=localhost`: systemd тихо відкидав вихідні пакети API-процесу до будь-якої не-loopback адреси.

Автотести цього не виявили: Slack у них мокається, а E2E-backend запускається не під systemd.

**Рішення користувача:** відкрити вихідні з'єднання. Egress-фільтр знято з `deploy/systemd/node-control-api.service`. Вхідний доступ не змінився: listener лише `127.0.0.1:3100`. Призначення обмежує код (лише `https://hooks.slack.com/services/…`, `redirect: 'error'`). ADR-022 і DEPLOYMENT оновлено.

**Деплой (~22:14 UTC).** Code revision **`9e7f71bdf9317a152e972fe85c09e1f773b85f11`** (`fix(alerts): allow outbound HTTPS from the API unit for Slack delivery`).

| Крок | Результат |
|---|---|
| Backup юніта | `/root/node-control-backups/node-control-api.service.bak-20261014T221443Z` |
| Юніт | `systemd-analyze verify` OK, `daemon-reload` |
| Реліз | `current` → `9e7f71b`, `previous` → `325cc91` (ціль rollback); міграцій немає; restart лише API, старий процес завершився штатно |
| Стан юніта | `IPAddressDeny`/`IPAddressAllow` порожні; `RestrictAddressFamilies` і `User=nodecontrol` без змін |
| Після | ready 200 локально й HTTPS; 0 error; `hooks.slack` у журналі немає |
| Стан сповіщень | доставку admin увімкнув, рушій вимкнений; outbox порожній; інцидентів немає; останній тест — ще старий `unknown/timeout`, admin має повторити тест |

**Підтверджено (22:16:20 UTC):** повторний тест admin — `success` (generation 1); користувач підтвердив, що повідомлення надійшло в Slack. Рушій поки вимкнено, доставку ввімкнено.

Під час деплою скрипт зупинився на `diff` юніта (`set -e` + `pipefail`, код 1 при відмінностях) ще до встановлення юніта. Сервер лишався на `325cc91`, далі кроки виконано окремо.

**Rollback:**
1. Відновити юніт із backup.
2. `daemon-reload`.
3. `server-release.js rollback` → `325cc91`.
4. Restart API.

Після цього Slack знову стане недоступним.

## Task 013.1 — admin UI для Slack-інтеграції й правил сповіщень (2026-10-15)

Стан на початок: `main` = `6bf0c6e`, робоче дерево чисте. Task 013 ще **не має** незалежного review Codex — ця задача його розширює й не вважає Task 013 підтвердженим. Рішення — ADR-022; міграція `1791900000007_alert-settings`.

**Реалізовано:**
- **Джерело конфігурації.**
  - Singleton `alert_settings` з `revision` і `rules_revision`; DB CHECK для всіх меж і для правила «поріг відновлення нижче порогу проблеми».
  - `ALERTS_*` прикладні змінні env — лише одноразові початкові значення; збережені налаштування не перезаписуються. `ALERTS_ENABLED`, `ALERTS_DELIVERY_ENABLED` і `ALERTS_SLACK_WEBHOOK_URL` ігноруються з попередженням без значення; webhook з env не імпортується.
  - В env лишились `ALERTS_SECRET_KEY` (+ `_VERSION`) і `ALERTS_PUBLIC_URL`.
- **Секрет.**
  - Webhook шифрується AES-256-GCM: випадковий 12-байтний nonce; AAD прив'язує запис до generation; у таблиці `alert_slack_integration` зберігаються ciphertext, tag і `key_version`.
  - Ключ — лише в `api.env`. Немає ключа, інша версія або дешифрування не вдається → fail-closed зі станом `error` (`key_missing` | `key_version_mismatch` | `decrypt_failed`), без fallback.
  - Webhook не повертається, не логується й не потрапляє в audit; frontend-парсер відкидає відповідь, схожу на секрет.
- **API** (`alerts:manage`, Origin + CSRF, строгі схеми, мутації 30/хв на актора):
  - `GET` і `PATCH /api/settings/alerts` з optimistic concurrency за `revision` (409);
  - `PUT` і `DELETE /api/settings/integrations/slack` з `generation` (409);
  - `POST /api/settings/integrations/slack/test` — 5/хв на актора, один тест у польоті, синхронний результат `success` | `failed` | `unknown`.
  - Audit — у тій самій транзакції, лише метадані.
- **Hot reload.**
  - Worker створюється, коли API запущено з конфігурацією alerts. Кожні 5 с він читає узгоджений знімок налаштувань та інтеграції; оцінювання — коли рушій увімкнено й минув інтервал.
  - Новий `AbortController` на кожен `start()`.
  - Зміна правил скидає серії `pending`/`recovering` (`alert_conditions.rules_revision`); відкриті інциденти, cooldown і baseline рестартів лишаються.
- **Черга.**
  - Записи outbox прив'язані до `generation`; worker захоплює лише поточну generation.
  - Заміна чи видалення webhook, а також вимкнення доставки скасовують `queued`/`sending` записи (`cancelled`: `integration_changed` | `delivery_disabled`) — без пересилання новому адресату й без «вибуху» після повторного ввімкнення.
  - Запит, що вже в польоті, може дійти старому адресату — це задокументовано.
  - Зменшення ліміту черги нічого не видаляє.
- **Тестове повідомлення.**
  - Лише для збереженої інтеграції; незбережене поле — «Спочатку збережіть webhook».
  - Працює при вимкненій доставці й рушії; не створює інцидент; позначене як тестове; без автоповтору.
  - Тайм-аут або abort → `unknown`. Результат зберігається лише для поточної generation.
- **UI.**
  - Розділ «Налаштування» (лише `alerts:manage`; прямі routes захищені) з вкладками «Інтеграції» та «Правила сповіщень». Чинний дизайн, одиниці й межі біля кожного поля, «Додаткові параметри» в згортанні.
  - Клієнтська валідація, dirty/saving/success/error/conflict; попередження про незбережені зміни (`beforeunload` + підтвердження при зміні вкладки); поле webhook очищається.
  - Мутації прив'язані до сесії й abort.
  - На «Сповіщеннях» для admin — кнопка «Налаштувати».

**Офіційна документація Slack (docs.slack.dev), звірено:** webhook прив'язаний до одного каналу, обраного при встановленні; для приватного каналу встановлювач має бути його учасником; payload не змінює канал; `channel_is_archived`, `no_service`, `no_active_hooks`; URL — секрет. Поля вибору каналу немає.

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 438/438, smoke 10/10, agent 164/164 (+3 opt-in), frontend 183/183, typecheck, lint, збірки, `check:secrets` OK |
| Нові backend | `settings-api` 14: доступи, Origin/CSRF, валідація й міжпольові правила, stale revision/generation, відкат при збої audit, шифрування й прив'язка до generation, SSRF/невалідні URL, відсутній ключ, тест success/400/410/429/network/timeout→unknown, другий клік → 409, rate limit, результат старої generation не позначає нову. `alerts-delivery` +3: hot reload й інтервал, claim лише поточної generation та fail-closed, enable → disable → enable |
| Real-DB (`test:backend:db`) | 94/94, нові `db/settings` 7: одноразова ініціалізація; конкурентні оновлення (рівно один); відкат налаштувань при збої audit; лише ciphertext і виявлення tamper/wrong key/version; скасування черги й claim за generation; скидання серій при зміні правил; результат тесту лише для поточної generation |
| Frontend | нові `settings` 12 |
| UI Playwright | 2/2 |
| E2E (`test:e2e`, тестова БД, випадковий ключ на прогін) | 18/18 (+1 opt-in), нові `settings.spec.ts` 2: admin зберігає синтетичний webhook (у сторінці й audit його немає, у БД лише ciphertext) і правила; operator → 403; 390 px. Кнопка тесту в E2E **не натискалась**: дочірній backend звернувся б до справжнього Slack; тест покритий mock-транспортом |
| Real-PM2 E2E | 1/1 |
| Залишки | 0 схем `nc_test_*`; PM2 daemon і `~/.pm2` відсутні |

Обмеження:
- Попередження про незбережені зміни — `beforeunload` і підтвердження між вкладками; перехід через бічне меню всередині SPA його не показує (BrowserRouter без data-router blocker).
- Один тест у польоті — на процес API (single instance).
- Доставка лишається at-least-once.

**Деплой (2026-10-14, ~21:43 UTC, лише центральний сервер).** Deployed code revision: **`325cc91d5ee7abb125e0cbc955e330e2ddd16cfc`** (`feat(settings): add admin-managed Slack integration and alert rules`). Цей запис — пізніший docs-commit, на сервер не деплоївся. Agent/broker не передеплоювались.

| Крок | Результат |
|---|---|
| Baseline | `control-server`; current `e8f61c5` (ціль rollback), previous `1c6c58d`; API active, ready 200; Nginx/PostgreSQL active, failed 0; `api.env` `nodecontrol:nodecontrol 600`, ключів `ALERTS_*` не було |
| Артефакт | 62 файли, SHA-256 `6430ca14…d56e48ee` OK, manifest `325cc91`; unit без змін |
| Backup | `api.env.bak-20261014T214333Z` (600); `node_control_db-20261014T214333Z-pre-325cc91….dump` (600, `pg_restore --list` OK) — лише `node_control_db` |
| Міграція | applied=7, pending=1 (`1791900000007_alert-settings`) → `up` → applied=8, pending=0 |
| Ключ шифрування | Згенеровано на сервері (32 випадкові байти, base64), **значення ніде не виводилось**; дописано в `api.env` (`ALERTS_SECRET_KEY`, `ALERTS_SECRET_KEY_VERSION=1`, `ALERTS_PUBLIC_URL=https://control.example.com`), права `600 nodecontrol`. Окрема копія ключа: `/root/node-control-keys/alerts-secret-key-20261014T214333Z.env` (каталог 700, файл 600). Оператору рекомендовано зберегти ключ і поза сервером (менеджер секретів): backup БД без ключа не відновлює інтеграцію |
| Активація | `current` → `325cc91`, `previous` → `e8f61c5`; restart лише `node-control-api`; журнал: `alertsSecretKey:true`, `alertsPublicUrl:true`; «Alert settings initialised from defaults» (рядок створено один раз); legacy-попереджень немає |
| Чистий shutdown | Обидва рестарти (`e8f61c5` → новий і контрольний рестарт нового коду з утримуваним long-poll Agent) — `Shutdown complete`, ~0,1 с, без `Failed` |
| Після деплою | API active (`nodecontrol`, лише `127.0.0.1:3100`); live/ready 200 локально й HTTPS; HTTPS `/settings/integrations` 200; бандл = `current/frontend/dist`, містить «Налаштування». Анонімні `GET/PATCH /api/settings/alerts`, `PUT /api/settings/integrations/slack`, `POST …/slack/test`, `/api/alerts/status` → 401; чужий Origin → 403 (1 warn — саме ця перевірка). Журнал: 0 error/fatal; ні ключа, ні `hooks.slack` у журналі; `nginx -t` OK |
| Стан сповіщень | `alert_settings`: revision 1, **рушій вимкнено, доставку вимкнено**, типові пороги; Slack: generation 0, **не налаштовано**; інцидентів/outbox/умов — 0. Тестових повідомлень не надсилалось |
| Agent / PM2 | heartbeat 0 с, control 9 с — звіти надходять; керуючих дій не було; користувачі без змін (2, 1 активний admin) |
| Rollback | не застосовувався. Спершу вимкнути доставку в UI (якщо ввімкнена), далі `server-release.js rollback` → `e8f61c5` + restart лише API. Старий реліз читає лише `ALERTS_*` з env (`ALERTS_ENABLED`/`DELIVERY`/`WEBHOOK` відсутні) — рушій і доставка там вимкнені, старий webhook не з'являється. Ключ і нові таблиці лишаються; secrets/outbox не видаляються |

Подальші кроки — admin у UI: «Налаштування» → «Інтеграції» → зберегти webhook приватного каналу → «Надіслати тестове повідомлення» → за успіху увімкнути доставку; «Правила сповіщень» → увімкнути рушій.

## Task 013 — Alerts Engine, Slack і виправлення graceful shutdown (2026-10-14)

Стан на початок: `main` = `fe25d5e`; у робочому дереві — незакомічений запис review Codex (угорі документа), збережено й закомічено разом із задачею. Рішення — ADR-021; міграція `1791900000006_alerts`.

**Graceful shutdown (відомий дефект із Task 011.1) — дві причини, обидві виправлено:**
1. `LogHub.close()` викликався в `onClose`, тобто вже після того, як Fastify дочекався активних запитів. Тепер він у `preClose`; `onClose` лишився ідемпотентним; закритий hub відповідає на нові long-poll одразу.
2. Знайдено під час regression-тесту: навіть звільнений long-poll лишає keep-alive сокет, який став idle вже після старту `close()`. Fastify такі сокети не закриває, і сервер тримався ще ~72 с (keep-alive timeout). Тепер після старту закриття кожна відповідь іде з `Connection: close`.

Regression: справжній HTTP, Agent long-poll і очікувач результату логів у польоті, `lifecycle.shutdown('SIGTERM')` з тайм-аутом 3 с. На старому коді — `false` (тайм-аут), на новому — `true` менш ніж за 2 с, обидва запити отримують 200. Окремо перевірено shutdown із завислою Slack-доставкою: abort, запис повертається в чергу (`aborted`), закриття чисте.

**Alerts:**
- Правила: `server_offline`, `inventory_stale`, `process_down`, `process_cpu`, `server_memory`, `process_restarts` і відновлення для кожного.
- Debounce й гістерезис; вибірка, яку вже оцінювали, не рахується вдруге; відсутність даних ніколи не означає відновлення; поки сервер offline, діє лише його alert; рестарти — лише дельта.
- Durable інциденти, cooldown проти flapping, необов'язкові нагадування.
- Outbox: lease, `SKIP LOCKED`, межа черги, backoff і `Retry-After`, at-least-once.
- Slack Incoming Webhook: лише `text`, екранування, allowlist host, без redirect, обмежене читання відповіді.
- Worker живе в API-процесі: старт в `onReady`, зупинка в `preClose`.
- API `GET /api/alerts`, `GET /api/alerts/status`; новий permission `alerts:manage` (admin).
- UI «Сповіщення»:
  - стан рушія й доставки — без «усе добре», коли вимкнено або невідомо;
  - активні інциденти й історія закритих зі сторінками;
  - стан доставки й панель конфігурації — лише для admin, значення webhook не показується.

**Перевірка документації Slack.** Перед реалізацією звірено з офіційною документацією docs.slack.dev: payload, успіх `200 ok`, коди помилок, ~1 повідомлення/с, 429 + `Retry-After`, екранування `& < >`, згадки.

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 421/421 (нові: `alerts-rules` 18, `alerts-delivery` 10, `alerts-api` 5, shutdown-regression 1), smoke 10/10, agent 164/164 (+3 opt-in), frontend 171/171 (нові `alerts` 6), typecheck, lint, збірки, `check:secrets` OK |
| Real-DB (`test:backend:db`) | 87/87, нові `db/alerts` 9: атомарні інцидент і outbox; повторна оцінка й «перезапущений» рушій нічого не додають; recovery; never_connected та неактивні сервери не дають alert; cooldown без сповіщення; доставка вимкнена → без outbox; переповнена черга → `dropped`; 6 паралельних оцінювань → без дублікатів; rollback через тригер; роздільні захоплення записів, повторне захоплення після простроченого lease, захист від запису застарілим власником; retention лише власних таблиць; сторінки списку; у таблицях немає webhook |
| UI Playwright | 2/2 |
| E2E (`test:e2e`, тестова БД, рушій увімкнено, доставку вимкнено) | 16/16 (+1 opt-in), новий `alerts.spec.ts`: справжній оцінювач створює інцидент для синтетичного сервера, що перестав звітувати; operator бачить його без деталей доставки; `admin: null`; outbox порожній; 390 px |
| Real-PM2 E2E | 1/1 |
| Залишки | 0 схем `nc_test_*`; PM2 daemon і `~/.pm2` відсутні |

Під час перевірок:
- Перший повний E2E упав у двох чинних тестах. Нова специфікація лишала синтетичний сервер, тепер прибирає його в `afterAll`. Також вичерпувався ліміт входів viewer (5/15 хв), тож вона входить як operator. Після виправлення — 16/16.
- Справжніх Slack-повідомлень не надсилалось: лише mock transport.

Обмеження:
- Доставка — at-least-once, можливі дублікати (короткий id інциденту в тексті).
- Стан рушія (час останньої оцінки) — у пам'яті процесу, після рестарту `null` до першого циклу.
- Ідентичність процесу для рестартів — `source:pm_id:name` + `first_seen_at`.
- Acknowledgement, silencing і редагування правил в UI не реалізовано.

**Деплой (2026-10-14, ~20:46 UTC, лише центральний сервер).** Deployed code revision: **`e8f61c56bd6028284865bdeb713c4b2715d05213`** (`feat(alerts): add persistent incidents and Slack notifications`). Цей запис — пізніший docs-commit, на сервер не деплоївся. Agent/broker не передеплоювались.

| Крок | Результат |
|---|---|
| Baseline | `control-server`; current `1c6c58d` (ціль rollback), previous `0b85151`; API active, ready 200; Nginx/PostgreSQL active, failed 0; `api.env` без змін (ключів `ALERTS_*` немає) |
| Артефакт | 57 файлів, SHA-256 `0641b18f…85492e` OK, manifest `e8f61c5`; unit без змін |
| Міграція | status: applied=6, pending=1 (`1791900000006_alerts`) → backup лише `node_control_db` (`node_control_db-20261014T204620Z-pre-e8f61c5….dump`, 600, `pg_restore --list` OK) → `up` → applied=7, pending=0; створено `alert_conditions`, `alert_incidents`, `alert_outbox` |
| Активація | `current` → `e8f61c5`, `previous` → `1c6c58d`; restart лише `node-control-api` |
| Graceful shutdown у production | Рестарт старого процесу (`1c6c58d`) знову дав `Shutdown failed or timed out` і `Failed with result 'exit-code'` (10 с) — це старий код. **Контрольний рестарт нового коду** через ~20 с роботи, з утримуваним long-poll Agent: 0,1 с, `Shutdown complete`, без `Failed` |
| Після деплою | API active (`nodecontrol`, лише `127.0.0.1:3100`); live/ready 200 локально й HTTPS; HTTPS `/`, `/alerts` 200; бандл = `current/frontend/dist`, містить «Сповіщення». Анонімні `/api/alerts`, `/api/alerts/status`, `/api/dashboard` → 401. Журнал нового процесу: 0 error/warn; `pm2ControlEnabled:true`, **`alertsEnabled:false`, `alertsDeliveryEnabled:false`**; у журналі немає `hooks.slack`; `nginx -t` OK |
| Стан alerts | Рушій і доставка вимкнені; `alert_incidents` = 0, `alert_outbox` = 0, `alert_conditions` = 0. Webhook не налаштовано, повідомлень не надсилалось |
| Agent / PM2 | Після двох рестартів API Agent відновився (heartbeat 4 с, control 0 с, inventory ~40 с); керуючих дій не було; production-користувачі без змін (2, 1 активний admin) |
| Rollback | не застосовувався. Спершу `ALERTS_DELIVERY_ENABLED=false`, якщо доставку вмикали, потім `server-release.js rollback` → `1c6c58d` + restart лише API; таблиці alerts лишаються, дані не видаляються |

Увімкнення — після погодження Slack-каналу й адресатів, за кроками розділу «Сповіщення» в [DEPLOYMENT](DEPLOYMENT.md): спершу лише `ALERTS_ENABLED=true` (інциденти в UI), потім доставка з webhook у `api.env`.

## Task 012 — Dashboard поточного стану системи (2026-10-14)

Стан на початок: `main` = `cd48ef8`; у робочому дереві — незакомічений запис review Codex (угорі документа), збережено й закомічено разом із задачею. Рішення — ADR-020. Міграцій немає.

**Backend.** `GET /api/dashboard` (`monitoring:read`, read-only, без audit):
- Один узгоджений знімок: транзакція `REPEATABLE READ READ ONLY`, усі вікна свіжості від одного `now()` = `generatedAt`.
- Точні агрегати всіх записів: сервери за статусами, неактивні окремо; inventory за станами; live-процеси за групами; `notLive`.
- Обмежені списки з точним `total`: `attentionServers` ≤ 20, `attentionProcesses` ≤ 20, `serverList` ≤ 50.
- `recentActions` ≤ 10 лише для `processes:control`: для viewer — `null`, і запит до команд не виконується. Без id чи email ініціатора (лише `requestedByMe`), результатів PM2, логів і audit details. `overdue` для pending після дедлайну, без мутацій.
- SQL параметризований; з'єднання 1:1 за PK `server_id`; лічильники процесів сервера — `LEFT JOIN LATERAL`; без N+1. Нових індексів немає (обґрунтування в ADR-020).
- Строга response-схема: nullable-об'єкти через `type: ['object', 'null']`, бо з `anyOf` зайве поле давало 500 замість відкидання. Помилка БД → 503 + `Retry-After` без тексту.

**Frontend.** «Огляд» (`DashboardPage`, замість статичного привітання):
- Шапка з часом останньої успішної відповіді й «Оновити».
- 5 підсумкових карток:
  - сервери онлайн з активних (неактивні — окремою приміткою);
  - «не звітують» = офлайн + без першого звіту;
  - PM2-процеси зараз (лише live);
  - проблемні сервіси;
  - неактуальні дані.
- «Потребують уваги»: сервери з причиною словами й сервіси з проблемним статусом, без дублювання; «Показано N з M».
- Таблиця серверів:
  - стан, останній сигнал, uptime;
  - load average 1/5/15 з поясненням «не відсоток CPU»;
  - пам'ять ОС зі смужкою знімка (не історія);
  - сервіси PM2 зі свіжістю.

  Метрики офлайн-сервера — «—»; `totalBytes = 0` → пам'ять невідома.
- «Останні керуючі дії» для operator/admin.
- Polling 15 с, лише коли вкладка видима. Хук polling тепер дає `refreshing` і локальний `receivedAt`. Після помилки показуються останні відомі дані з явною позначкою; дані, старші за online-вікно, приглушуються й позначаються як неактуальні.
- Колір не єдиний носій статусу (текстові бейджі). Скриншоти з синтетичними даними: `dashboard.spec.ts` за `NC_E2E_SCREENSHOT_DIR`; за замовчуванням вимкнено.

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 387/387 (нові `dashboard-api` 7), smoke 10/10, agent 164/164 (+3 opt-in), frontend 165/165 (нові `dashboard` 8), typecheck, lint, збірки, `check:secrets` OK |
| Real-DB (`test:backend:db`) | 78/78, зокрема нові `db/dashboard` 6: порожня система; статуси, стани inventory, live/notLive, неактивні виключено, без множення рахунків; межі свіжості 85/95 с і 175/185 с; 60+ серверів і 30 проблемних процесів — точні `total`, обмежені списки, детермінований порядок; дії лише за запитом, `requestedByMe`, `overdue`, GET нічого не змінює; READ ONLY транзакція |
| UI Playwright (1440/390) | 2/2 |
| E2E (`test:e2e`, тестова БД) | 15/15 (+1 opt-in), нові `dashboard.spec.ts` 2: operator бачить синтетичні сервери, метрики, «Потребують уваги», останні дії й переходи; viewer — без деталей дій в UI та API (`recentActions: null`), 390 px без горизонтального скролу |
| Real-PM2 E2E | 1/1 (керування й логи без регресій) |
| Залишки | 0 схем `nc_test_*`; PM2 daemon і `~/.pm2` відсутні |

Під час розробки один прогін E2E упав на `pg` «timeout expired» у global-setup: SSH-тунель до тестової БД завис. Після перепідключення тунелю — зелено. Це проблема середовища, не коду.

Обмеження:
- `recentActions` сортує `control_commands` без окремого індексу: таблиця мала; за зростання додати `(requested_at DESC, id DESC)`.
- Таблиця серверів показує ≤ 50 активних за назвою; повний список — «Сервери».
- Історії метрик немає (наступні задачі).

**Деплой (2026-10-14, ~19:25 UTC, лише центральний сервер).** Deployed code revision: **`1c6c58df90083438cf2000a60c63ebe1c38e7eaa`** (`feat(dashboard): add live system overview and attention lists`). Цей запис — пізніший docs-commit, на сервер не деплоївся. Agent/broker не передеплоювались.

| Крок | Результат |
|---|---|
| Baseline | `control-server`; current `0b85151` (ціль rollback), previous `ac4d967`; API active, ready 200; Nginx/PostgreSQL active, failed 0; `api.env` без змін |
| Артефакт і активація | 51 файл, SHA-256 `b5e750d5…b074bc` OK, manifest `1c6c58d`; unit без змін; міграції applied=6, pending=0 (нових немає). `current` → `1c6c58d`, `previous` → `0b85151`; restart лише `node-control-api` |
| Після деплою | API active (`nodecontrol`, лише `127.0.0.1:3100`); live/ready 200 локально й HTTPS; HTTPS `/` 200; бандл = `current/frontend/dist`, містить Dashboard. Анонімний `GET /api/dashboard` → 401, bearer → 401, `POST /api/dashboard` → 404 (маршруту немає); `/api/auth/me` → 401; `pm2ControlEnabled:true` без змін; `nginx -t` OK. Новий процес — 0 error/warn |
| Agent / PM2 | heartbeat 5 с, control status 10 с, inventory 29 с — звіти надходять; керуючих дій не було |
| Відоме | Старий процес (`0b85151`) знову не завершився за 10 с (`Shutdown failed or timed out`, systemd `Failed with result 'exit-code'`). Це той самий дефект long-poll Agent у graceful shutdown (див. Task 011.1), не код Task 012; новий процес стартував штатно. Окрема задача з `preClose` — рекомендована перед production-підготовкою |
| Production-дані | Користувачі, паролі, сервери й процеси не змінювались (2 користувачі, 1 активний admin). Автентифікований smoke Dashboard у production не виконувався (без production credentials); агрегати перевірено real-DB і E2E на тестовій БД |
| Rollback | не застосовувався. `server-release.js rollback` → `0b85151` + restart лише API; схема й дані без змін |

## Task 011.2 — оновлення актуальної сторінки після створення користувача (2026-10-14)

Стан на початок: `main` = `034794c`; у робочому дереві — незакомічений запис review Codex (Task 011.1, угорі документа), збережено й закомічено разом із виправленням. Backend, SQL і міграції не змінювались.

**P2 — успіх створення перезавантажував покинуту сторінку.**
- Причина: `CreateUserForm` після `await` викликав `onCreated`, захоплений у render, де стартував POST. Його `data` і `reload` належали старому курсору. Пагінація під час створення дозволена, форма лишається змонтованою, сесія та сама — тож auth binding і abort цього не ловили. Старий `reload` записував дані попереднього ключа в keyed resource: номер «Сторінка 2», а рядки зникали до наступного polling.
- Виправлення (мінімальне, без блокування пагінації): форма тримає **актуальний** callback у ref, що оновлюється після кожного render, і після успіху викликає саме його.
  - Рішення «новий користувач видно тут чи потрібне „Показати"» приймається за даними поточної сторінки.
  - `reload` — keyed reload поточного курсора.
  - Session binding, abort, відсутність автоповторів, bounded «Показати» (≤ 50 сторінок) і поведінку після PATCH збережено.
- Інші callbacks того самого класу перевірено:
  - `UsersPage.submit` (PATCH): пагінація й закриття діалогу заблоковані, поки він pending.
  - «Показати»: пагінація заблокована під час пошуку; курсори додаються функціональним оновленням.
  - `ServersPage`: ключ ресурсу фіксований.
  - `ProcessControl` і `CredentialControls`: перемонтовуються з ключем сервера.
  - `ServerDetailPage`: бере актуальний `reload` через effect.
  - Змін там не потрібно.

**Regression-тести (`users-paging.test.tsx`, «create while paging», 6, deferred POST):**

| Тест | Старий код (`ac4d967`) | Виправлений |
|---|---|---|
| Сторінка 1 → pending create → «Далі» → пізній успіх: рядки сторінки 2 на місці, перезавантажено лише її курсор, «Показати» веде на сторінку 3 | падає (GET без `after`) | ✓ |
| Сторінка 2 → pending create → «Назад» → пізній успіх: оновлено сторінку 1 | падає (GET зі старим курсором) | ✓ |
| Помилка створення після переходу: список той самий, жодного reload чи вигаданого рядка | ✓ (захисний) | ✓ |
| Logout і нова сесія під час POST: немає callback, повідомлення чи reload | ✓ (захисний) | ✓ |
| Перехід на останню сторінку з місцем → пізній успіх: показано там після reload цієї сторінки, без «Показати», один POST | падає (рішення за старими даними) | ✓ |
| «Показати» обходить обмежену кількість сторінок і зупиняється на останній | ✓ (захисний) | ✓ |

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 380/380, smoke 10/10, agent 164/164 (+3 opt-in), frontend 157/157, typecheck, lint, збірки, `check:secrets` OK |
| UI Playwright (1440/390) | 2/2 |
| E2E (`test:e2e`, тестова БД) | 13/13 (+1 opt-in), зокрема 3/3 `users.spec.ts` |
| Real-DB, real-PM2 E2E | не повторювались: backend, Agent і broker не змінювались |
| Залишки | 0 схем `nc_test_*`; PM2 daemon відсутній |

Межі: гонку «POST затримано, поки користувач гортає сторінки» відтворено детерміновано лише у frontend-тестах з deferred-відповіддю. У справжньому E2E затримку POST не моделювали.

**Деплой (2026-10-14, ~18:07 UTC, лише центральний сервер).** Deployed code revision: **`0b851511612096c05ba7825b15ab6c51f50975e7`** (`fix(users): refresh the current page after user creation`). Цей запис — пізніший docs-commit, на сервер не деплоївся. Agent/broker не передеплоювались.

| Крок | Результат |
|---|---|
| Baseline | `control-server`; current `ac4d967` (ціль rollback), previous `20896dd`; API active, ready 200; Nginx/PostgreSQL active, failed 0; `api.env` без змін |
| Артефакт і активація | 49 файлів, SHA-256 `ee0fa434…bc196a` OK, manifest `0b85151`; unit без змін; міграції applied=6, pending=0; `backend/dist` ідентичний попередньому релізу (лише frontend). `current` → `0b85151`, `previous` → `ac4d967`; restart лише `node-control-api` (старий процес завершився штатно за ~1 с) |
| Після деплою | API active (`nodecontrol`, лише `127.0.0.1:3100`); live/ready 200 локально й HTTPS; HTTPS `/`, `/users` 200; бандл = `current/frontend/dist`. Анонімні `GET/POST /api/users`, `PATCH /api/users/:id`, `POST /api/auth/change-password` → 401. Журнал із restart: 0 error/fatal, 0 warn; `pm2ControlEnabled:true` без змін; `nginx -t` OK (конфіг не змінювався). Heartbeat Agent — 20 с |
| Production-дані | Користувачі й паролі не змінювались (2 користувачі, 1 активний admin — як до деплою) |
| Rollback | не застосовувався. `server-release.js rollback` → `ac4d967` + restart лише API; БД, паролі й сесії не відкочуються |

Відкрите з Task 011.1: graceful shutdown API чекає на long-poll Agent (`LogHub.close()` в `onClose`). Пропозиція — окрема задача із закриттям у `preClose`.

## Task 011.1 — запізнілі відповіді між сесіями та пагінація користувачів (2026-10-14)

Стан на початок: `main` = `2ce89c7`; у робочому дереві — незакомічений запис review Codex (Task 011, угорі документа), збережено й закомічено разом із виправленням. Backend і схема не змінювались.

**P2-1 — запізнілий успіх зміни пароля скидав нову сесію.**
- Причина: `AccountPage` після `await` викликав `passwordChanged()` без перевірки скасування та актуальності сесії. `apiRequest` повертав успішний 204/JSON навіть тоді, коли відповідь надійшла вже після abort: реальний `fetch` зазвичай відхиляє Promise, але transport може завершитися пізніше.
- Виправлення:
  - `apiRequest` перевіряє abort і timeout після відповіді, після читання й валідації тіла та перед поверненням результату;
  - `AuthContext.bindSession()` фіксує auth epoch; logout, завершення сесії й новий вхід його змінюють;
  - `passwordChanged(binding)` для застарілої прив'язки нічого не робить;
  - `AccountPage`, `CreateUserForm`, `UsersPage.submit` і новий пошук сторінки перевіряють `aborted || !binding.current()` після **кожного** `await` перед будь-яким побічним ефектом (стан, callback, reload, `sessionExpired`).
- Abort лише перестає чекати; серверна мутація могла відбутися, і UI цього не заперечує. Штатна зміна пароля працює як раніше.

**P2-2 — недоступні користувачі після перших 100.**
- Причина: `usersApi.list` не передавав курсор, а UI лише повідомляв про перших 100.
- Виправлення:
  - `usersApi.list(after)` з валідованим UUID-курсором (не email).
  - Сторінки по 100: «Назад»/«Далі» з номером сторінки, стек курсорів; останню сторінку видно за вимкненим «Далі».
  - Ресурс keyed за курсором: дані попередньої сторінки не показуються як нова, запізніла відповідь покинутої сторінки відкидається, помилка сторінки має «Спробувати ще раз».
  - Мутації перезавантажують ту саму сторінку.
  - Створення: якщо новий користувач не на поточній сторінці, повідомлення каже «наприкінці списку» з кнопкою «Показати <email>» — вона проходить ≤ 50 сторінок від поточної (bounded, скасовується при виході) і відкриває сторінку з ним. Невдале створення рядка не додає.
  - Одна таблиця з меню «Дії»; власний рядок без дій; logout чи нова сесія починають зі сторінки 1 без діалогів. Backend-контракт не змінено.

**Regression-тести — спершу проти старого коду, потім виправленого:**

| Тест | Старий код (`20896dd`) | Виправлений |
|---|---|---|
| `client.test.ts` «cancellation on the success path» (3: 204 після abort, JSON після abort, успіх після timeout) | 3/3 падають (успіх повертається) | 3/3 |
| `users.test.tsx` «stale responses across sessions» (4: unmount → пізній успіх; logout → новий вхід → пізній успіх старої форми; пізня помилка 409; create/update після виходу зі сторінки) | 3/4 падають (сесію скинуто; reload після unmount). Пізня помилка вже була захищена — тест лишено як regression | 4/4 |
| `users-paging.test.tsx` (8: 230 користувачів, курсор, остання сторінка, «Назад»; запізніла відповідь покинутої сторінки; помилка наступної сторінки й retry; керування на сторінці 2 й reload тієї ж сторінки; створення при повній першій сторінці + «Показати»; невдале створення без вигаданого рядка; власний рядок і нова сесія зі сторінки 1; клавіатура) | 7/8 падають (немає пагінації). Тест невдалого створення проходить і на старому коді | 8/8 |
| E2E `users.spec.ts` «more than 100 users» (105 синтетичних користувачів у per-run схемі; 1440 і 390 px; сторінка 2, деактивація там, «Назад», створення + «Показати», клавіатура) | — (новий сценарій) | 1/1 |

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 380/380, smoke 10/10, agent 164/164 (+3 opt-in), frontend 151/151, typecheck, lint, збірки, `check:secrets` OK |
| UI Playwright (1440/390) | 2/2 |
| E2E (`test:e2e`, тестова БД) | 13/13 (+1 opt-in). Перший прогін нового сценарію впав через помилку самого тесту: `goto('/users')` переривав ще не завершений вхід. Додано очікування завершення входу; повторно — 13/13 |
| Real-DB, real-PM2 E2E | не повторювались: backend, транзакції, Agent і broker не змінювались (останні результати — Task 011: 72/72 і 1/1) |
| Залишки | 0 схем `nc_test_*`; PM2 daemon відсутній |

**Деплой (2026-10-14, ~17:49 UTC, лише центральний сервер).** Deployed code revision: **`ac4d967679a723db04185f04f2cdd4e1b6a1d259`** (`fix(users): guard stale mutations and paginate user administration`). Цей запис — пізніший docs-commit, на сервер не деплоївся. Agent/broker не передеплоювались.

| Крок | Результат |
|---|---|
| Baseline | `control-server`; current `20896dd` (ціль rollback), previous `2fe4d95`; API active, ready 200; Nginx/PostgreSQL active, failed 0; `api.env` без змін |
| Артефакт і активація | 49 файлів, SHA-256 `82cb05ec…57f29f` OK, manifest `ac4d967`; unit без змін; міграції applied=6, pending=0 (нових немає); `backend/dist` ідентичний попередньому релізу (змінено лише frontend). `current` → `ac4d967`, `previous` → `20896dd`; restart лише `node-control-api` |
| Після деплою | API active (`nodecontrol`, лише `127.0.0.1:3100`); live/ready 200 локально й HTTPS; HTTPS `/`, `/users`, `/account` 200; бандл = `current/frontend/dist`, містить пагінацію. Анонімні `GET /api/users` (з курсором), `POST /api/users`, `PATCH /api/users/:id`, `POST /api/auth/change-password`, `/api/auth/me` → 401; чужий Origin → 403 (1 warn — саме ця перевірка); `pm2ControlEnabled:true` без змін; `nginx -t` OK. Новий процес — 0 error |
| Agent | Після restart Agent короткочасно отримав `unavailable` і відновився (heartbeat accepted, control і logs poll ok); heartbeat 8 с при повторній перевірці |
| Знайдено | **Старий процес (`20896dd`) не завершився за 10 с** (`Shutdown failed or timed out`, exit 1, systemd `Failed with result 'exit-code'`); новий стартував штатно. Причина: на момент зупинки був відкритий long-poll Agent `/api/agent/logs/poll` (утримання до 25 с). `LogHub.close()` викликається в `onClose`, а Fastify викликає `onClose` лише після завершення активних запитів, тож shutdown чекає на long-poll. Дефект існує з Task 010; із 9 рестартів у журналі з 2026-10-13 проявився лише цей. Виправлення (звільняти long-poll/waiters у `preClose`) — окремою задачею; на роботу нового релізу не впливає |
| Production-дані | Деплой і перевірки не змінювали користувачів. Між деплоями Task 011 і 011.1 через UI створено одного користувача (operator, 17:20 UTC, audit `user.created`) — дія користувачів системи, не цієї задачі. Зараз 2 користувачі, 1 активний admin |
| Rollback | не застосовувався. `server-release.js rollback` → `20896dd` + restart лише API; БД, hashes і відкликані сесії не відкочуються |

## Task 011 — користувачі, ролі та зміна власного пароля (2026-10-14)

Стан на початок: `main` = `f0b320c`; у робочому дереві — незакомічений запис повторного review Codex (Task 010.1), збережено й закомічено разом із задачею. Рішення — ADR-019.

**Реалізовано:**
- **API.**
  - `GET/POST /api/users`, `PATCH /api/users/:id` (`users:manage`, Origin + CSRF).
  - `POST /api/auth/change-password` (будь-яка сесія, Origin + CSRF).
  - Строгі схеми; UUID у params; whitelist ролі й полів PATCH; порожній PATCH → 400. `isActive` — лише справжній JSON boolean: Ajv-коерсію `"false"` відсікає `preValidation`.
  - Keyset-пагінація `(created_at, id)`. Чинна політика email/пароля. Відповідь — лише `{id,email,role,isActive,createdAt,updatedAt}`.
- **Гонки.** Нова колонка `users.credential_version`; зміна пароля, ролі чи активності в одній транзакції збільшує версію, відкликає всі сесії користувача й пише audit.
  - Зміна пароля: scrypt поза транзакцією через спільний limiter, потім compare-and-set на прочитаній версії. Із двох одночасних змін проходить одна, друга отримує 409.
  - Вхід: створення сесії під `FOR SHARE` перевіряє активність і версію. Запізнілий вхід після зміни пароля, ролі чи деактивації → 401 `stale_credentials`.
  - Адмінські мутації — під `LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE`, з повторною перевіркою актора (сесія + активний admin) під блокуванням. Взаємне пониження двох admin: один отримує 401, лишається один активний admin. Власну роль чи активність змінити не можна (403). Останнього активного admin зняти не можна (409). No-op нічого не пише.
- **Audit.**
  - Успіх — у тій самій транзакції: `user.created`, `user.role_changed`, `user.deactivated`/`user.activated`, `auth.password_change` (success).
  - Відмови — best-effort: `user.create_rejected`, `user.update_rejected`, `auth.password_change` (failure), `auth.login` failure `stale_credentials`.
  - Лише id, ролі, лічильник `sessionsRevoked` і server-defined reason; без email, паролів і hash.
- **Ліміти.** Зміна пароля — 5 спроб / 15 хв на користувача; адмінські мутації — 30/хв на актора; hashing — спільний bounded limiter (переповнення → 503 + `Retry-After: 1`).
- **UI.**
  - «Обліковий запис» для всіх ролей: email, роль, форма з трьох полів, autocomplete, кнопка показу (`aria-pressed`), inline-валідація, попередження про завершення сесій. Після успіху — login з повідомленням «Пароль змінено…».
  - «Користувачі» лише з `users:manage` (прямий route — «Недостатньо прав»): одна таблиця в стилі сервісів, створення, меню «Дії» → зміна ролі або деактивація/активація з підтвердженням. Власний рядок позначено «Ви», без дій, з поясненням.
  - Мутації не повторюються; pending блокує повтор і закриття діалогу; запізнілі відповіді після unmount ігноруються.
  - Спільний `ActionMenu` винесено з `ProcessControl`. Журнал аудиту показує нові події.
- **Міграція** `1791900000005_user-credential-version` — additive (колонка з default 1 + індекс). Сумісна з попереднім релізом.

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 380/380 (нові `users-api` 22), smoke 10/10, agent 164/164 (+3 opt-in), frontend 136/136 (нові `users` 21), typecheck, lint, збірки, `check:secrets` OK |
| Real-DB (`test:backend:db`) | 72/72, зокрема нові `db/users` 12: міграція й default, атомарність і rollback через тригер, що ламає audit; гонка дублікатів; взаємне пониження й деактивація двох admin; цикл трьох admin; дві одночасні зміни пароля (CAS); вхід проти закомітченої та **незакомітченої** зміни (утримання row lock); вхід, що закомітився раніше, відкликається; деактивація проти запізнілого входу; HTTP-гонка змін пароля |
| UI Playwright (1440/390) | 2/2 |
| E2E (`test:e2e`) | 12/12 (+1 opt-in), нові 2: admin створює користувача → вхід у двох сесіях → зміна пароля → обидві сесії завершено → старий пароль відхилено, новий працює → зміна ролі та деактивація завершують сесії → audit без паролів і email; mobile 390 px, клавіатура, Escape, фокус |
| Real-PM2 E2E | 1/1 (керування й логи без регресій) |
| Залишки | PM2 daemon і `~/.pm2` відсутні; 4 схеми `nc_test_*` від перерваного прогону видалено (лише тестова БД, за шаблоном), лишилось 0 |

Аномалія: в одному з проміжних прогонів real-DB три тести `db/control` впали з тайм-аутами 15 с, а хуки `db/auth` і `db/users` не відпрацювали — звідси 4 залишкові схеми. Зависших транзакцій у тестовій БД не було. У двох наступних повних прогонах — 72/72; причину (ймовірно, мережа SSH-тунелю) не встановлено.

Обмеження: UI показує перші 100 користувачів (API підтримує keyset-курсор, «показати ще» не реалізовано). Admin-reset пароля, MFA, зміна email і фізичне видалення — поза scope.

**Деплой (2026-10-14, ~16:07 UTC, лише центральний сервер).** Deployed code revision: **`20896ddcb0c70f22cb101ba539cac048c333513a`** (`feat(users): add user administration and self-service password change`). Цей запис — пізніший docs-commit, на сервер не деплоївся. Код Agent/broker не змінювався — ноду не передеплоєно (Agent/broker лишаються на `2fe4d95`).

| Крок | Результат |
|---|---|
| Baseline | `control-server`; current `2fe4d95` (ціль rollback), previous `401667e`; API active, ready 200; Nginx/PostgreSQL active, failed 0; `api.env` без змін (mtime 2026-10-13 13:41:44) |
| Артефакт | 49 файлів, SHA-256 `de925478…22a0f85` OK, manifest `20896dd`; unit без змін |
| Міграція | status: applied=5, pending=1 (`1791900000005_user-credential-version`) → backup лише `node_control_db` (`/root/node-control-backups/node_control_db-20261014T160708Z-pre-20896dd….dump`, 600, `pg_restore --list` OK) → `up` → applied=6, pending=0; 1 наявний користувач отримав `credential_version = 1` |
| Активація | `current` → `20896dd`, `previous` → `2fe4d95`; restart лише `node-control-api` |
| Після деплою | API active (`nodecontrol`, лише `127.0.0.1:3100`); live/ready 200 локально й HTTPS; HTTPS `/`, `/users`, `/account` 200; бандл = `current/frontend/dist`, містить нові сторінки. Анонімні `GET/POST /api/users`, `PATCH /api/users/:id`, `POST /api/auth/change-password` (з Origin), `/api/auth/me`, `…/log-targets` → 401; `POST /api/users` без Origin або з чужим Origin → 403. Журнал із restart: 0 error/fatal, 2 warn — це саме ті дві навмисні відмови за Origin; `pm2ControlEnabled:true` без змін; `nginx -t` OK (конфіг не змінювався) |
| Agent / PM2 | Agent, broker і exporter timer active; під час restart API Agent короткочасно отримав `unavailable` і відновився (heartbeat, control і logs poll ok, 0 warn/error). Свіжість у БД: heartbeat 7 с, control 5 с, inventory 24 с. 5 PM2-процесів online, restarts 0; керуючі дії не виконувались |
| Без змін | Production-користувачі й паролі не створювались і не змінювались (1 користувач, 1 активний admin, 0 подій `user.*`/`auth.password_change`); allowlist, credentials Agent, HBA/firewall і сторонні служби не змінювались |
| Rollback | не застосовувався. `server-release.js rollback` → `2fe4d95` + restart лише API; колонка `credential_version` лишається (старий реліз її не читає); змінені паролі не повертаються, відкликані сесії не відновлюються |

Ручна перевірка оператора (під власною сесією): «Обліковий запис» — email/роль; «Користувачі» — таблиця з одним рядком «Ви». Мутації в production не виконувати без потреби.

## Task 010.1 — ресурсні ліміти перегляду логів (2026-10-14)

Стан на початок: `main` = `de7d395`; у робочому дереві — незакомічений запис review Codex (Task 010) і узгоджений roadmap; збережено й закомічено разом із виправленням. Read-only перевірка ноди: allowlist 5 targets, 5 з `logs: true`, змінено 2026-10-14 12:48:29 UTC — це ввімкнення на запит користувача, задокументоване в `de7d395` (початковий звіт деплою `af89119` описував стан до нього). Allowlist і дозволи в цій задачі не змінювались.

**P2-1 — broker звільняв слот до завершення читання.** Причина: `handleLogs` робив `Promise.race(readLogs, timeout)` і зменшував лічильник у `finally`. Timeout відповідав клієнту, але файлові/PM2-виклики `readLogs` тривали (вони не скасовуються), тож після кожного timeout могло стартувати ще одне читання понад ліміт. Виправлення (`agent/src/control/broker.ts`):
- слот звільняється у `finally` самого `readLogs` — рівно один раз, при resolve або reject;
- timeout лише відповідає клієнту `timeout` (≤ 5 с, без змін);
- осиротілий Promise має `.catch`: пізній reject не стає unhandled і не дає другої відповіді;
- поки обидва слоти зайняті — `broker_busy`, черги немає; керування процесами (окремий ланцюжок) не зачеплене;
- зависання видно як metadata: `log read overdue` (requestId, inFlight, overdue) і `log read settled late` (durationMs); `createBroker` повертає `logStats()` {inFlight, overdue}.

**P2-2 — необмежені очікувачі результату в API.** Причина: `LogHub.get` додавав waiter і таймер на кожен GET без ліміту, а маршрут не прибирав waiter при відключенні клієнта. Виправлення (`backend/src/servers/logs.ts`, `logs-routes.ts`):
- `LOG_LIMITS.maxWaitersPerRequest = 2` (UI тримає ≤ 1 GET на відкритий переглядач без перекриття; 2 — запас на reconnect), `maxWaitersPerActor = 3` (друга вкладка), `maxWaiters = 100` (глобально; таймери/сокети з запасом над очікуваною кількістю операторів);
- ліміти перевіряються після перевірки власника (чужий/невідомий запит → 404 без деталей) і до створення waiter/таймера: 429 + `Retry-After: 1` (запит/актор), 503 + `Retry-After: 2` (глобально);
- кожен waiter завершується ідемпотентно (result, дедлайн, власний timeout, disconnect, shutdown) і звільняє таймер і лічильники рівно один раз;
- disconnect — `reply.raw` 'close' (не `request.raw`); спільний запит не скасовується, інші очікувачі не зачеплені;
- `stats()` — лише кількості (waiters, waitingActors, waitersInRequests).

**Regression-тести — спершу проти старого коду, потім виправленого:**

| Тест | Старий код (`401667e`) | Виправлений |
|---|---|---|
| Agent `broker log-read concurrency`: 2 завислі читання → timeout → 10 повторів; 5 циклів timeout; пізні resolve/reject; нове читання допускається; ліміт цілий; 0 unhandled; таймери не ростуть; журнал без тексту | падає: третє читання запустилося (`timeout` замість `broker_busy`) | 1/1 |
| Backend `result waiters (bounded)`, 6 тестів: 1000 GET одного запиту; per-actor/global, чужий/невідомий; disconnect/timeout/дедлайн/повторний cleanup; 50 циклів без накопичення; HTTP 429 + Retry-After, viewer 403, anonymous 401, чужий 404; справжній HTTP abort звільняє waiter до 8 с, наступний GET працює | 6/6 падають (зокрема зайвий GET → 200 замість 429; немає відмови `limit_request`) | 6/6 |

| Перевірка (Node 22) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 358/358, smoke 10/10, agent 164/164 (+3 opt-in), frontend 115/115, typecheck, lint, збірки, `check:secrets` OK |
| UI (`playwright -c e2e/ui.config.ts`) | 2/2 (1440/390 px) |
| Real-DB (`test:backend:db`) | 60/60 |
| E2E (`test:e2e`) | 10/10 (+1 opt-in) |
| Real-PM2 E2E (`test:e2e:pm2`, синтетичні логи, одноразовий `PM2_HOME`, тестова БД) | 1/1 |
| Залишки | 0 схем `nc_test_*`; PM2 daemon і `~/.pm2` відсутні |

Обмеження: операції `logTargets` і `list` (керування) не мають окремого ліміту на завислий PM2 `list()`; Agent викликає їх послідовно, по одній на цикл. Це поза scope задачі. Фронтенд не змінювався: 429 і 503 уже показуються без автоповтору.

**Деплой (2026-10-14).** Deployed code revision: **`2fe4d953f69bcf901bfaa73cc3d715a28264d446`** (`fix(logs): enforce read concurrency and result waiter limits`) — API/UI, Agent і broker. Цей запис — пізніший docs-commit, на сервери не деплоївся.

| Крок | Результат |
|---|---|
| Центральний (`control-server`) | Baseline current `401667e` (ціль rollback), previous `3ff4653`; API active, ready 200; Nginx/PostgreSQL active, failed 0. Артефакт API 46 файлів, SHA-256 `35e0ce51…261e9` OK, manifest `2fe4d95`; міграції pending=0; unit і `api.env` без змін. `current` → `2fe4d95`, `previous` → `401667e`; restart лише `node-control-api`. Agent-реліз центрального сервера активовано, unit вимкнений — не запускався |
| Після деплою (центральний) | API active (`nodecontrol`, лише `127.0.0.1:3100`); `/health/live`, `/health/ready` 200 локально й HTTPS; HTTPS `/` 200, бандл = `current/frontend/dist`; анонімні `…/log-targets`, `GET /api/log-requests/:id`, `POST …/log-requests` (з Origin), `/api/auth/me` → 401; `POST /api/agent/logs/poll` без токена → 401; журнал з restart: 0 error/fatal, `pm2ControlEnabled:true` без змін; `nginx -t` OK (конфіг не змінювався) |
| Нода `app-server` | Baseline Agent current `401667e` (ціль rollback), previous `b4ada6d`; allowlist 5 targets, 5 з `logs: true`. Артефакт Agent SHA-256 `01d7e5c2…b32c9` OK; `prepare --no-install`, 4 unit-файли без змін; `current` → `2fe4d95`, `previous` → `401667e`; restart broker, потім Agent |
| Після деплою (нода) | broker active (`logDirs:1`); Agent 0.4.0 active; heartbeat/inventory accepted; control poll ok (broker ok, targets 5); logs poll ok (broker ok, targets 5); 0 warn/error у журналах Agent і broker; exporter timer active |
| Без змін | SHA-256 allowlist, broker env і `agent.env` збігаються з baseline; God Daemon 3807, PID і час старту 5 PM2-процесів, статуси online і restarts 0 — без змін; `pm2` не запускався; listeners ноди без змін. Production-текст логів не читався |
| Rollback | не застосовувався. API: `server-release.js rollback --base /opt/node-control` → `401667e` + restart API. Agent/broker: `rollback --base /opt/node-control-agent` → `401667e` + restart broker і Agent (allowlist з `logs` сумісний із `401667e`; журнал дедуплікації broker не видаляти, БД не відкочувати) |

## Task 010 — обмежений авторизований перегляд логів сервісів (2026-10-14)

Стан на початок: `main` = `7eece06`; у робочому дереві — незакомічений запис незалежного review Codex (нижче, «Незалежний review Codex — об'єднана таблиця сервісів»). Його збережено й закомічено разом із задачею. Застарілі твердження ARCHITECTURE, на які вказав review, актуалізовано.

**Реалізовано (ADR-018):**
- **Канал.** UI → `POST /api/servers/:id/log-requests` (`logs:read` + Origin + CSRF) → запит у пам'яті API → вихідний long-poll Agent `POST /api/agent/logs/poll` (≤ 25 с) → broker (нові операції `logTargets`/`logs`) → `POST /api/agent/logs/result` → `GET /api/log-requests/:id` (лише ініціатор, чекає ≤ 8 с). Окремо від команд керування; не залежить від `PM2_CONTROL_ENABLED`; чинні контракти не змінено.
- **Права.** Новий permission `logs:read` (admin, operator; viewer — ні). Локально — `"logs": true` у записі allowlist (старий формат валідний; `"actions": []` можливий лише з `logs: true`).
- **Broker.**
  - Шляхи лише з `pm_out_log_path`/`pm_err_log_path` у `NC_BROKER_LOG_DIRS` (типово `<PM2_HOME>/logs`); відхиляються `..`, `/proc`, `/sys`, `/dev`, symlink у будь-якому компоненті (realpath), FIFO, не-файли.
  - `O_NOFOLLOW|O_NONBLOCK` і перевірка inode відкритого дескриптора; хвіст ≤ 256 KiB; ≤ 100 рядків; ≤ 8 KiB разом; кадр ≤ 32 KiB з урахуванням escaping.
  - Санітизація ANSI/керівних символів, обрізання довгих рядків, маскування відомих форматів секретів; ≤ 2 читання одночасно, ≤ 5 с.
- **API.** Bounded memory: ≤ 200 запитів, ≤ 2 очікуючих і ≤ 30/хв на актора, дедлайн 15 с, TTL результату 60 с, після restart усе втрачається. Audit `logs.view_opened` (не частіше ніж раз на 10 хв), `logs.view_denied`; текст ніде не зберігається й не логується. Ліміт machine-запитів на токен 20 → 90/хв.
- **Agent 0.4.0.** Окремий цикл logs (незалежний від heartbeat/inventory/control); старий broker → `unsupported`; старий API (404) → довга пауза; мінімум 1 с між порожніми poll.
- **UI.**
  - «Переглянути логи» у меню «Дії» рядка: лише з `logs:read` і для явно дозволеної цілі з тим самим ім'ям і PM2 id.
  - Діалог із вкладками stdout/stderr, ручним оновленням, автооновленням кожні 5 с (лише видима вкладка, без перекриття, зупиняється при помилці), часом отримання й поясненням обрізання.
  - Закриття, зміна сервера чи цілі та logout скасовують запити й очищають текст.
- **Попутно.** Журнал аудиту показує `targetKey`/`action` у details.

**Знайдено й виправлено під час перевірок:**
- **Busy loop у long-poll.** У Fastify `request.raw` 'close' спрацьовує одразу після читання тіла, тож long-poll завершувався миттєво. Agent опитував без пауз, вичерпував спільний ліміт на токен, і цикл керування переставав звітувати (real-PM2 E2E: «Broker давно не звітував»). Тепер відключення слухається на `reply.raw`. Додано регресійний тест через справжній HTTP: зі старим кодом падає. Агент тримає ≥ 1 с між порожніми poll.
- **Підказка про логи** не показувалась операторові (гілка керування).
- **`check:secrets`** спрацював на синтетичних фікстурах тесту маскування — вони тепер збираються під час виконання, сканер не послаблено.

| Перевірка (Node v22.23.3) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 352/352, smoke 10/10, agent 163/163 (+3 opt-in), frontend 115/115, typecheck, lint, збірки, `check:secrets` OK. Один попередній прогін дав 3 падіння frontend із аномальною тривалістю (141 с на тест) під навантаженням; у 4 наступних прогонах (окремо й у складі `check:local`) не відтворилося |
| Agent/broker (`agent/test/logs.test.ts`, 41) | старий/новий allowlist; 12 випадків guard шляхів; symlink файлу і каталогу, FIFO, каталог, відсутній, без прав; хвіст великого файлу; ANSI/OSC/керівні, довгі рядки, surrogate, некоректний UTF-8, CRLF, неповні рядки; 11 форматів маскування + PRIVATE KEY; бюджети й кадр з escaping; `readLogs` без шляхів/env/секретів; відмови (немає дозволу, не в allowlist, fingerprint, ambiguous, cluster, daemon, allowlist, дедлайн); реальний сокет; старий broker → unsupported; 404 → 900 с; захист від busy loop |
| API (`backend/test/logs-api.test.ts`, 10) | viewer 403 (+authz.denied), anonymous 401, operator/admin; Origin/CSRF; bearer на browser-маршруті; строгий body; not connected/unsupported/не дозволено → 409 (+view_denied); повний цикл; чужий користувач → 404; чужий сервер → 404; дубль → 409; oversize → 413; дедлайн → expired, пізній результат → 409; TTL і cleanup; ліміти 503/429; троттлінг audit; long-poll утримується через справжній HTTP; текст відсутній у логах і audit |
| Frontend (`frontend/test/logs.test.tsx`, 12) | меню і діалог; текст як текст (XSS); CSRF; вкладки; ручне й автооновлення раз на 5 с; вимкнення; viewer без колонки; 5 станів без пункту з поясненням; 409 без повтору; закриття під час запиту — запізніла відповідь не з'являється; A→B закриває; кінець сесії; жодних записів у storage |
| Браузер (`playwright -c e2e/ui.config.ts`) | 2/2 (1440/390 px): меню → логи → текст, вкладки, без горизонтального скролу, Escape, фокус на тригері, жодних команд |
| Real-DB (`test:backend:db`) | 60/60 (схема не змінювалась). Перший прогін упав через обрив SSH-тунелю й лишив 9 схем `nc_test_*` — видалено (лише тестова БД, за шаблоном), прогін повторено з keepalive |
| E2E (`test:e2e`) | 10/10 (+1 opt-in) |
| Real-PM2 E2E (`test:e2e:pm2`, тестова БД, одноразовий `PM2_HOME`) | 1/1: керування як раніше + оператор відкриває логи дозволеного процесу (stdout з замаскованим паролем, stderr), інший процес «Логи не дозволені», viewer: API → 403, audit — лише `logs.view_opened` без тексту, 0 збігів тексту/секрету в audit |
| Залишки | 0 схем `nc_test_*`; PM2 daemon і `~/.pm2` відсутні |

Не покрито автотестом: детермінована підміна inode між `lstat` і `open` (гонка; код її відсікає порівнянням inode/dev відкритого дескриптора).

**Деплой (2026-10-14, ~12:2x–12:4x UTC).** Deployed code revision: **`401667e653ed80f395a17a2ffa1c12657b9c9079`** (`feat(logs): add bounded authorized service log viewing`) — API/UI, Agent і broker (один артефакт). Цей запис — пізніший docs-commit, на сервери не деплоївся. Production-читання логів **вимкнене**: жодного `logs: true` в allowlist (окремого погодження сервісів у сесії не було).

| Крок | Результат |
|---|---|
| Центральний (`control-server`) | Baseline current `3ff4653`, previous `b4ada6d`. Артефакт API 46 файлів, SHA-256 `9a656028…7d692` OK; міграції pending=0; unit без змін. `current` → `401667e`, `previous` → `3ff4653`; restart лише `node-control-api`; `pm2ControlEnabled:true` (без змін). Agent-реліз центрального сервера активовано, unit вимкнений — не запускався |
| Після деплою (центральний) | `/health/live`, `/health/ready` 200 (локально й HTTPS); HTTPS `/` 200; публічний бандл = `current/frontend/dist`, містить «Переглянути логи»; анонімні `GET …/log-targets`, `GET /api/log-requests/:id`, `POST …/log-requests` (з Origin) → 401, без Origin → 403; `POST /api/agent/logs/poll` без токена → 401; журнал API: 0 error/fatal |
| Нода `app-server` | Baseline Agent `b4ada6d`; backup `agent.env` (600), broker env і allowlist (`*.bak-20261014T123303Z`); allowlist без `logs`. Артефакт Agent SHA-256 `7a95410a…be9b6` OK; `prepare --no-install`, 4 unit-файли без змін; `current` → `401667e`, `previous` → `b4ada6d`; restart broker, потім Agent |
| Після деплою (нода) | broker active, `broker started` з `logDirs:1`; Agent active, `version 0.4.0`; heartbeat/inventory accepted; control poll ok, broker ok, targets 5; logs poll ok, broker ok, **targets 0**; 0 warn/error у журналах Agent і broker; exporter timer active |
| PM2 без змін | God Daemon 3807; PID і час старту 5 процесів (6 жовтня) збігаються з baseline; статуси online, restarts 0 — без змін; `pm2` не запускався; listeners ноди без змін |
| Rollback | не застосовувався. API: `server-release.js rollback --base /opt/node-control` → `3ff4653` + restart API. Agent/broker: якщо в allowlist уже з'явилось `logs` — спершу повернути allowlist із backup, потім `rollback --base /opt/node-control-agent` → `b4ada6d` + restart broker і Agent |

**Увімкнення читання логів (2026-10-14, ~12:48 UTC).** Користувач погодив логи для проєктів `app-server` («включи логи для проектів»). Backup `ubuntu.allowlist.json.bak-20261014T124829Z`; усім 5 записам (catalog-api, billing-api, orders-api-v2, orders-api, public-api) додано `"logs": true`, `actions` без змін; файл `root:root 644`. Broker перечитав allowlist без restart: logs poll ok, broker ok, targets 5; 0 warn/error у журналах Agent і broker. Production-текст логів не читався. Rollback: повернути allowlist із backup (без restart).

Увімкнення читання (оператор, після погодження конкретних сервісів) — розділ «Перегляд логів» у [DEPLOYMENT](DEPLOYMENT.md): backup allowlist → `"logs": true` для погоджених `targetKey` → `install -m 644 -o root -g root`; restart не потрібен. Ручна перевірка UI під сесією — за оператором; production-текст логів у звіти не копіювати.

## Frontend: одна таблиця сервісів із діями (2026-10-13)

Зміни підготував Codex за запитом користувача; я переглянув їх, виправив недоліки й перевірив. API, Agent, broker, міграції й production-конфігурація не змінювались.

**Що змінилось:**
- На сторінці сервера inventory і керування об'єднані в одну таблицю «Сервіси сервера» з колонкою «Дії» (лише для `processes:control`). Окремого списку керування немає.
- Зведення «Усього / Працюють / Потребують уваги» за останнім збором; оновлені кольори й бейджі; mobile-верстка.
- Меню «Дії» з'являється лише для рядка, якому відповідає рівно одна ціль broker з тим самим **ім'ям і PM2 id**. Ціль ніколи не виводиться з inventory.
- Меню вимкнене, якщо inventory не `current`, сервер не онлайн, broker недоступний чи застарілий, daemon або allowlist не `ok`, триває запит або є незавершена команда. Показуються лише `target.actions`.
- Меню — звичайний потік (не absolute), тож не обрізається на mobile. Escape і клік поза меню закривають його з поверненням фокуса.
- Збережено підтвердження з сервером/процесом/ціллю, CSRF, ключ idempotency на діалог, жодних автоповторів і відстеження команди до підтвердженого статусу.

**Виправлено після перевірки:**
- **Lint:** `@typescript-eslint/no-unnecessary-type-assertion` у `control.test.tsx` (2 місця) — generic `getByRole<HTMLButtonElement>`, правило не вимикалось.
- **Фокус після підтвердження:** меню рядка стає `disabled`, поки команда не фінальна, і `Dialog` повертав фокус на вимкнений тригер (фокус губився). Тепер фокус переходить на статус команди (`role=status`, `tabIndex=-1`); додано тест.
- **Хибна причина в рядку:** без звіту broker (недоступний/застарілий/керування вимкнене) рядок показував «Не дозволено керування». Тепер — «Керування зараз недоступне». Знайдено real-PM2 E2E.
- **Скриншот UI-тесту** писався в `/tmp`; тепер у вихідну теку Playwright.
- **Локатори E2E:** ім'я процесу тепер є і в таблиці, і в історії команд, тож перевірка viewer іде через `rowheader`.

| Перевірка (Node v22.23.3) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 342/342, smoke 10/10, agent 122/122 (+3 opt-in пропущено), frontend 103/103, typecheck, lint, збірки |
| `npx playwright test -c e2e/ui.config.ts` (фінальна збірка, синтетичні API-відповіді, без БД/PM2) | 2/2: 1440 і 390 px, меню → «Перезапустити» → підтвердження з правильним процесом → «Скасувати» → команда не надсилається, фокус на тригері, без горизонтального скролу і помилок сторінки |
| `npm run test:e2e:pm2` (ізольована тестова БД через SSH-тунель, одноразовий `PM2_HOME`) | 1/1: inventory з одноразового PM2 (exporter); процес поза allowlist видно в таблиці без меню; оператор через меню зупиняє й запускає дозволений процес (стан PM2 підтверджено); viewer без меню, API → 403; broker зупинено → «Broker недоступний», меню немає, у рядку «Керування зараз недоступне» |
| `npm run test:e2e` | 10/10 (+1 opt-in пропущено) |
| `git diff --check`, `npm run check:secrets` | OK |
| Залишки | 0 схем `nc_test_*`; сторонніх PM2 daemon і `~/.pm2` немає |

Межі: production-процеси в тестах не використовувались; UI на production перевіряється без виконання дій.

**Деплой (центральний сервер, ~14:2x UTC).** Deployed code revision: **`3ff465367b99991a148d4475d773736d2ce5aca1`** (`feat(frontend): unify service inventory and process actions`); previous — `b4ada6d` (ціль rollback). Цей запис — пізніший docs-commit, на сервер не деплоївся.

| Крок | Результат |
|---|---|
| Baseline | `control-server`; current `b4ada6d`, previous `ffb32b0`; API active, ready 200; Nginx/PostgreSQL/Docker active, failed 0 |
| Артефакт | 44 файли, SHA-256 `c8b8a14e…82e7ae1`, `sha256sum -c` OK, manifest revision `3ff4653`; `backend/dist` ідентичний попередньому релізу; міграції pending=0 (нових немає); unit-файл без змін |
| Активація | `current` → `3ff4653`, `previous` → `b4ada6d`; restart лише `node-control-api` (процес `nodecontrol`, listener лише `127.0.0.1:3100`) |
| Після деплою | live/ready 200; HTTPS `/`, `/servers/<id>`, `/applications` → 200; JS/CSS assets 200, публічний бандл = `current/frontend/dist` і містить нову таблицю й меню; анонімні `/api/auth/me`, `…/control`, `POST …/control-commands` → 401; журнал: `pm2ControlEnabled:true` (без змін), 0 error/fatal, 0 секретів, 0 відповідей 4xx агенту; `nginx -t` OK (конфіг не змінювався) |
| Без змін керування/PM2 | `api.env` не змінювався (mtime 13:41:44, з моменту ввімкнення); allowlist `root:root 644`, 5 записів, не змінювався; broker/Agent/exporter active (Agent `b4ada6d` — не передеплоювався); 0 команд у БД, 0 виконаних broker; God Daemon 3807 і 5 PM2-процесів із часом старту 6 жовтня — без змін |
| Rollback | не застосовувався (за потреби: `server-release.js rollback` → `b4ada6d` + restart лише API) |

Ручна перевірка оператора (потрібна сесія): «Сервери» → `app-server` → «Сервіси сервера» — 5 рядків, колонка «Дії», меню відкривається; дію не виконувати, якщо вона не потрібна.

## Task 009 — production enable керування на app-server (2026-10-13, ~13:39–13:43 UTC)

Користувач попросив виконати потрібні дії на сервері й обрав allowlist «Усі 5, start/stop/restart». Код не змінювався (API/UI і Agent — `b4ada6d`, Agent уже 0.3.0).

| Крок | Результат |
|---|---|
| Baseline | Agent `b4ada6d` active; God Daemon 3807, 5 PM2-процесів (PID і час старту 6 жовтня); listener-и записані. Fingerprint через `pm2-broker.js fingerprint` від `ubuntu` (лише існуючий daemon, без шляхів/env): усі 5 — `fork_mode`, `instances 1`, імена унікальні |
| Broker | група `nc-pm2-control`; `/etc/node-control-pm2-broker/ubuntu.env` і allowlist `root:root 644`; unit із релізу, `systemd-analyze verify` OK; `node-control-pm2-broker@ubuntu` enabled/active, процес `ubuntu` / група `nc-pm2-control`; `/run/node-control-pm2-broker` `750`, сокет `660 ubuntu:nc-pm2-control`, журнал `/var/lib/node-control-pm2-broker` `700`. Спершу з порожнім allowlist |
| Agent | `nodecontrol-agent` додано лише до `nc-pm2-control` (доступу до `rpc.sock` немає — перевірено); backup `agent.env.bak-20261013T133958Z`; додано лише `NC_AGENT_CONTROL_SOCKET` (600 `nodecontrol-agent`, токен не змінювався); restart лише Agent → `control: enabled`, `control poll ok, broker ok`; heartbeat/inventory `accepted` |
| Allowlist | backup попередньої (порожньої) версії; 5 цілей (`targetKey` = ім'я PM2): `catalog-api`, `billing-api`, `orders-api-v2`, `orders-api`, `public-api`, дії `start/stop/restart`, fingerprint з baseline |
| API | backup `api.env.bak-20261013T134144Z` (600 `nodecontrol`); додано `PM2_CONTROL_ENABLED=true`; restart лише `node-control-api`; лог старту `pm2ControlEnabled:true`, `trustedProxies:1`, `authOrigins:1`; 0 error/fatal, 0 відповідей 4xx агенту |
| Результат | у БД: broker `ok`, daemon `ok`, allowlist `ok`, 5 цілей `match_status ok` (pm_id 0–4); команд — 0 (жодна дія не виконувалась); PM2-процеси й час їх старту без змін; нових listener-ів немає; exporter timer active |

Ручна перевірка оператора: «Сервери» → `app-server` → «Керування PM2» — 5 цілей «готовий до керування»; перша дія (наприклад, перезапуск некритичного процесу) з підтвердженням → «Виконано й підтверджено»; audit `process.command_*`.

Rollback / аварійне вимкнення: `PM2_CONTROL_ENABLED` прибрати або `false` в `api.env` (backup є) + restart API; або спорожнити allowlist (backup є) — діє без перезапуску; або `systemctl disable --now node-control-pm2-broker@ubuntu`; або прибрати `NC_AGENT_CONTROL_SOCKET` (backup `agent.env.bak-20261013T133958Z`) + restart Agent. PM2-процеси при цьому не зупиняються; журнал broker не видаляти.

## Task 009 — керування явно дозволеними PM2-процесами (2026-10-13)

**Active code revision:** центральний API/UI і реліз Agent — `b4ada6d07bcdc834959f889de37620688c756a15` (`feat(pm2): add allowlisted process control with audited commands`; previous API `ffb32b0`, Agent `7cdc50e`); `app-server` Agent — `b4ada6d` (0.3.0, previous `7cdc50e`). Предки: `7cdc50e`, `0ba0824`, `005fa62`, `bfe784e`. Цей звіт — пізніший docs-commit. **Production control вимкнений.**

Стан на початок: `main` = `6ef1343`, дерево чисте. Центральний сервер: API/UI `ffb32b0`, реліз Agent `7cdc50e`. `app-server`: Agent 0.2.0 (`7cdc50e`), exporter `@ubuntu`, inventory `ok`.

**Реалізовано (ADR-017).** Операції `start`/`stop`/`restart` лише для процесів із root-owned allowlist на ноді; створення/видалення/reload/deploy, логи, shell, «all», cluster — ні.
- **Broker** (`agent/dist/pm2-broker.js`, `node-control-pm2-broker@<owner>`):
  - працює від власника PM2, лише unix-сокет `0660 <owner>:nc-pm2-control`, без мережі;
  - викликає тільки `startProcessId`/`stopProcessId`/`restartProcessId({id})` (тип `Pm2Method` дозволяє ще `getMonitorData` — нічого більше);
  - ідентичність: ім'я + fork/1 instance + fingerprint definition (pm_id не є ідентичністю);
  - перевірка перед дією і пост-перевірка; дії строго послідовні;
  - durable журнал дедуплікації (`started` до PM2-виклику, `completed` після; повторна доставка → збережений результат; збій під час дії → `unknown/interrupted`).
- **Agent 0.3.0:** окремий цикл опитування (10 с, лише якщо задано `NC_AGENT_CONTROL_SOCKET`), передача команди broker, повтор лише підтвердження результату; heartbeat/inventory незалежні.
- **API** (міграція `1791900000004_process-control`, additive):
  - `control_commands` (стани `queued → dispatched → succeeded|failed|rejected|expired|unknown`, idempotency `(actor, key)`, одна активна команда на ціль);
  - `server_control_status`/`server_control_targets`;
  - browser: `GET …/control`, `POST …/control-commands` (`processes:control` + Origin + CSRF), `GET` команд;
  - machine: `POST /api/agent/control/poll|result`;
  - claim: `FOR UPDATE SKIP LOCKED`, lease 45 с, ≤ 3 доставки тієї самої команди, повторна перевірка ролі/активності актора й цілі, неблокувальний advisory-lock на сервер;
  - дедлайн 120 с; без результату до дедлайн + 120 с → `unknown/no_result` (пізній підтверджений результат замінює його);
  - кожен перехід + audit `process.command_*` — одна транзакція;
  - `PM2_CONTROL_ENABLED` (типово `false`).
- **UI:** секція «Керування PM2» на сторінці сервера:
  - кнопки лише для `processes:control` і лише для свіжих, збіжних цілей на онлайн-сервері;
  - підтвердження із сервером/процесом/ціллю; ключ idempotency на діалог; жодних автоповторів;
  - статус до фінального (успіх — лише після підтвердження);
  - чесні тексти для `failed`/`rejected`/`expired`/`unknown`; історія команд; прив'язка до сервера і сесії.
- Не гарантується exactly-once через мережу: якщо журнал broker втрачено до дедлайну, повторна доставка може виконати дію ще раз (описано в ADR-017).

| Перевірка (Node v22.23.3) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 89/89, backend 342/342, smoke 10/10, agent 122/122 (+3 opt-in), frontend 97/97, typecheck, lint, збірки |
| Agent/broker (`agent/test/control.test.ts`, 23) | tampered allowlist (власник, права, symlink, дублікати, wildcard, розмір); ідентичність (pm_id reuse, дублікати імен, cluster, змінений fingerprint); виконавець (усі відмови до PM2-виклику, дедлайн, без daemon — без auto-start, pm2_error, timeout → unknown, identity_changed, verification_failed); дедуплікація і crash; журнал; сокет 0660, сміття відкидається, послідовне виконання, `broker_busy`; Agent: «не надіслано» vs «надіслано без відповіді», повтор лише підтвердження, heartbeat не блокується |
| Real-DB (`test:backend:db`, тестова БД) | 60/60 (+11 control): constraints; умови створення; idempotency і конкурентні запити; audit-збій → команди немає; claim/lease/один виконавець; прив'язка до сервера і revoked credential; повторна перевірка актора/цілі; expired / redelivery ×3 / unknown / пізнє підтвердження; конкурентні poll |
| API (`backend/test/control-api.test.ts`, 20) | viewer 403 (+authz.denied), operator/admin 201; сесія/Origin/CSRF/Bearer; вимкнено → 409 без звернення до store; 10 спроб передати pm_id/шлях/env/shell/delete/reload/all/wildcard → 400; machine/browser separation; strict poll/result |
| Frontend (`frontend/test/control.test.tsx`, 11) | viewer без кнопок; 5 причин вимкнених кнопок; підтвердження і тіло запиту; успіх лише після підтвердженого статусу; `unknown`; 409 без автоповтору; повтор із тим самим ключем; A→B під час запиту |
| Справжній PM2 (`npm run test:agent:pm2`, pm2@7.0.4, тимчасовий `PM2_HOME`) | 3/3: exporter (як раніше) + broker: stop/start/restart дозволеного процесу з перевіркою стану, повторна доставка без другого restart, `start` online → `invalid_state`, недозволений процес незмінний, після `pm2 kill` → `failed/daemon_unavailable` без нового daemon |
| E2E (`npm run test:e2e`) | 10/10 (+1 opt-in пропущено); `servers.spec`/`inventory.spec` — точний збіг «Онлайн» (новий текст «Сервер не онлайн» інакше давав хибний збіг) |
| E2E зі справжнім PM2 (`npm run test:e2e:pm2`, окремий прогін) | 1/1: оператор у браузері зупиняє й запускає дозволений процес через API → Agent → broker → одноразовий PM2; стан PM2 підтверджено, інший процес online; audit 2×(requested, dispatched, succeeded); viewer без кнопок, API → 403; broker зупинено → «Broker недоступний», кнопки вимкнені |
| Залишки | 0 схем `nc_test_*`; сторонніх PM2 daemon і `~/.pm2` немає; тимчасові каталоги видалено |

| Деплой | Результат |
|---|---|
| Артефакти `b4ada6d` | API/UI: 44 файли, SHA-256 `aebac85b…5f20111`, prod deps `fastify`, `node-pg-migrate`, `pg`; Agent (вкл. broker і unit-шаблон): `eae3e6d5…6329ba4b`; `sha256sum -c` OK на обох серверах |
| Baseline центральний | API `ffb32b0`, реліз Agent `7cdc50e` (unit disabled); служби active, failed 0; `api.env` без `PM2_CONTROL_ENABLED` (перевірено за назвами ключів) |
| Backup | `/root/node-control-backups/node_control_db-20261013T130647Z-pre-b4ada6d….dump` (`600 root`), `pg_restore --list` читається |
| Міграція | як `nodecontrol`: pending 1 → applied=5, pending=0; нові таблиці `control_commands`, `server_control_status`, `server_control_targets` |
| API/UI | unit-файл без змін; `current` → `b4ada6d`; restart лише `node-control-api`; `nodecontrol`, listener лише `127.0.0.1:3100`; лог старту `pm2ControlEnabled:false`, `trustedProxies:1`, `authOrigins:1`; `api.env` не змінювався |
| Реліз Agent (центральний) | `current` → `b4ada6d`, unit disabled/inactive (без змін) |
| `app-server` | baseline: Agent `7cdc50e` active, exporter timer active, God Daemon 3807, 5 PM2-процесів; backup `agent.env.bak-20261013T130714Z` (600 `nodecontrol-agent`); `prepare --no-install` + `activate` → `b4ada6d`; unit-файли Agent/exporter без змін; restart лише Agent → 0.3.0, `"control":{"enabled":false}`, heartbeat і inventory `accepted`. `agent.env` без змін (ключі `NC_AGENT_API_URL`, `NC_AGENT_TOKEN`, `NC_AGENT_INVENTORY_FILE`); broker, група `nc-pm2-control` і `/run/node-control-pm2-broker` — відсутні |
| Після деплою (центральний) | live/ready 200; HTTPS `/`, `/servers/<id>`, `/applications` → 200; анонімно `GET …/control`, `GET …/control-commands` → 401, `POST …/control-commands` з Origin → 401, без Origin → 403; `POST /api/agent/control/poll` без токена / з невідомим токеном → 401, `…/result` без токена → 401; journal: 0 error/fatal, 0 секретів, 0 відповідей 4xx агентам; `nginx -t` OK; Nginx/PostgreSQL/Docker active, failed 0; migrations pending=0 |
| Доказ fail closed | API `pm2ControlEnabled:false`; у БД 0 команд, 0 станів/цілей керування, 0 подій `process.*`; Agent не опитує керування (0 `control poll` у журналі); broker не встановлений |
| Без рестартів / портів | God Daemon 3807 і всі 5 дочірніх PID із часом старту — ідентичні baseline; список listener-ів ідентичний; exporter продовжує (3 запуски за 2 хв); у БД: Agent 0.3.0, heartbeat 1 с, inventory `ok`, 5 процесів, збір 43 с тому |

Rollback (не застосовувався): API — `server-release.js rollback` (→ `ffb32b0`) + restart; нові таблиці лишаються (additive), команд немає. Agent на `app-server` — `server-release.js rollback --base /opt/node-control-agent` (→ `7cdc50e`) + restart Agent; `agent.env` не змінювався (backup є). Exporter/PM2 не зачіпаються.

**Для production enable потрібні від оператора:** перелік процесів (ім'я в PM2), `targetKey` і дозволені дії для кожного; підтвердження, що це fork-процеси з унікальними іменами; рішення увімкнути `PM2_CONTROL_ENABLED=true`. Далі — процедура в DEPLOYMENT («Керування PM2»).

## Task 008.2 — перевірка підключення PM2 inventory та виправлення рекомендованої ревізії (2026-10-13)

Підключення `app-server` уже виконано в межах Task 008.1 (11:33–11:38 UTC, деталі нижче). У Task 008.2 повторно, read-only, підтверджено стан і виправлено документацію: у Task 008 рекомендувався `ffb32b0` з дефектним unit. Історичні записи про задеплоєний `ffb32b0` (центральний API/UI) лишаються фактами.

- **Ревізія для встановлення:** реліз Agent `7cdc50eb0acf5070fe829670e4bcd2830375b5b7`; `git merge-base --is-ancestor 7cdc50e 7cdc50e` — так. Артефакт: sha256 `32d8b3b4…cff3367a`, `sha256sum -c` OK; копія в `/root/node-control-deploy/7cdc50e…/` на центральному сервері.
- **Центральний сервер:** `current` реліз Agent `ffb32b0` → `7cdc50e` (prepare `--no-install` + activate). Unit Agent там disabled/inactive, без restart, unit-файл без змін. Мета — щоб `current` більше не містив дефектного шаблону. API/UI лишився на `ffb32b0` (код не змінювався, без restart).

| Перевірка (read-only, ~11:5x UTC) | Результат |
|---|---|
| Agent | release `7cdc50e` (previous `81e1933`), 0.2.0, enabled/active, процес `nodecontrol-agent`, групи `nodecontrol-agent nc-pm2-inventory` |
| Node.js | `/usr/bin/node` v22.15.0 (не змінювалась) |
| Unit exporter | `ConditionUser` — 0 рядків, `User=%i`; з моменту встановлення 0 записів «unmet condition» |
| Виконання від PM2 owner | рядки «inventory exported» у журналі мають `_UID=1000` (`ubuntu`); `_UID=0` — лише службові повідомлення systemd |
| Timer | `node-control-pm2-exporter@ubuntu.timer` enabled/active; 18 запусків за 10 хв, 0 warn/error |
| Snapshot | `state ok`, 5 процесів, вік 6 с; лише allowlist-ключі; каталог `ubuntu:nc-pm2-inventory 2750`, файл `640`; конфіг exporter `root 644` |
| Доступ Agent | читає файл; запису у файл і каталог немає; доступу до `/home/ubuntu/.pm2/rpc.sock` немає |
| `agent.env` | `nodecontrol-agent 600`; ключі `NC_AGENT_API_URL`, `NC_AGENT_TOKEN`, `NC_AGENT_INVENTORY_FILE`; у журналі Agent за 10 хв: 0 warn/error, 0 збігів `ncag_` |
| Центральна БД | heartbeat 18 с тому (0.2.0); inventory `ok`, 5 процесів, збір 52 с тому → «Актуально» |
| Без рестартів | God Daemon PID 3807 (6 жовтня) і 5 дочірніх PID із часом старту 6 жовтня — як у baseline |
| Порти | listener-и ідентичні baseline; у Agent/exporter їх немає |

**Ручна перевірка оператора (одна):** увійти на https://control.example.com → «Застосунки»: 5 процесів сервера `app-server` з позначкою «Актуально», заповнені аптайм, рестарти, CPU і RAM. Сторінка сервера → «Застосунки PM2» → «Актуально: зібрано …». Адмінські credentials у цій роботі не використовувались.

Rollback і невиконане: див. Task 008.1. Відкритих блокерів для inventory немає.

## Task 008.1 — виправлення unit exporter після review Codex (2026-10-13)

Стан на початок: `main` = `8e28579`, дерево чисте. Центральний сервер — API/UI і реліз Agent `ffb32b0`, unit-шаблони exporter ніде не встановлені. `app-server` — Agent 0.1.0, inventory немає.

**P1.** `ConditionUser=!root` у `node-control-pm2-exporter@.service` перевіряє користувача system manager (root), а не `User=%i`. Через це кожен instance пропускався. **Виправлення:** умову прибрано, `User=%i` залишено. Заборона root — лише в коді: `loadExporterConfig` перевіряє фактичний UID до будь-якого доступу до `PM2_HOME`, `@root` завершується з exit 2. Hardening unit без змін. Додано статичний regression-тест `tests/unit/systemd-units.test.js`: на старому unit він падає, на новому проходить.

**Runtime-перевірка systemd на центральному сервері** (ізольована тимчасова конфігурація: тестовий системний користувач `nc-pm2-systest`, порожній `PM2_HOME` без daemon, `/var/lib/node-control-pm2`; після перевірки все видалено, `/etc/systemd/system` повернуто до стану без exporter units):

| Сценарій | Результат |
|---|---|
| Старий unit (`ffb32b0`) | `systemctl start` → «skipped, unmet condition check ConditionUser=!root», snapshot не записано — дефект відтворено |
| Новий unit, `@nc-pm2-systest` | `systemd-analyze verify` OK; «Finished …»; snapshot `nc-pm2-systest:nc-pm2-systest 640`, `unavailable/daemon_not_running`, 0 процесів; `PM2_HOME` лишився порожнім (daemon не створено) |
| `@root` | exporter відмовив сам: `Result=exit-code`, `ExecMainStatus=2`; snapshot не змінився |
| Timer `@nc-pm2-systest` | active; 4 запуски «inventory exported» за 80 с; `capturedAt` оновився (11:02:25 → 11:03:31 UTC); `PM2_HOME` порожній |

| Перевірка (Node v22.23.3) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 88/88 (+3 unit-тести systemd), backend 322/322, smoke 10/10, agent 99/99 (+2 opt-in), frontend 86/86, typecheck, lint, збірки |
| `npm run test:agent:pm2` (справжній pm2@7.0.4, тимчасовий `PM2_HOME`) | 2/2. Перші запуски через `npx -p node@22 -- npm run` падали з exit 127: вкладений `npx` успадковував `npm_config_package=node@22`. Тест тепер очищує `npm_*` env; тимчасові каталоги створюються лише в opt-in режимі |
| Real-DB (тестова БД) | 49/49 |
| E2E | 10/10; 0 схем `nc_test_*` після прогону |
| `git diff --check`, `check:secrets` | OK |

**Підключення PM2 inventory на `app-server` (2026-10-13, ~11:33–11:38 UTC).** Доступ і параметри надав оператор: SSH `ubuntu@203.0.113.20`, sudo є. PM2 owner і `PM2_HOME` визначено read-only з аргументів процесу God Daemon, `pm2`-команди не запускались.

| Крок | Результат |
|---|---|
| Read-only аудит | Ubuntu 24.04, systemd 255, `/usr/bin/node` v22.15.0 (не змінювалась). PM2 6.0.5 God Daemon PID 3807 від `ubuntu`, `PM2_HOME=/home/ubuntu/.pm2` (`ubuntu:ubuntu 775`, `rpc.sock` 775). Agent: release `81e1933` (зібраний оператором із `/home/ubuntu/node-control-source`), enabled/active, `nodecontrol-agent` лише у власній групі, `agent.env` з ключами `NC_AGENT_API_URL`, `NC_AGENT_TOKEN`. Baseline: 5 PM2-процесів (PID і час старту — 6 жовтня; аргументи не друкувались), listener-и записані |
| Agent → `7cdc50e` | артефакт sha256 `32d8b3b4…cff3367a`, `sha256sum -c` OK; backup `agent.env.bak-20261013T113342Z` (600 `nodecontrol-agent`); `prepare --no-install` + `activate`, реліз `root:root 755`; unit-файл без змін; restart лише Agent → 0.2.0, heartbeat `accepted` |
| Exporter | група `nc-pm2-inventory` (лише `nodecontrol-agent`); `/var/lib/node-control-pm2` `ubuntu:nc-pm2-inventory 2750`; `/etc/node-control-pm2-exporter/ubuntu.env` `root 644` (без секретів); unit-шаблони з релізу (без `ConditionUser`), `systemd-analyze verify` OK. Пробний запуск: «Finished», `state ok`, 5 процесів, 35 мс. `connect()` до `rpc.sock` працює під `ProtectHome=read-only`, hardening не послаблювався. Файл `ubuntu:nc-pm2-inventory 640`, 885 байт, лише allowlist-ключі |
| Активація | `node-control-pm2-exporter@ubuntu.timer` enabled/active; в `agent.env` додано лише `NC_AGENT_INVENTORY_FILE` (600 `nodecontrol-agent` збережено, токен не змінювався); restart Agent → `inventory: enabled`, перший звіт `accepted, state ok, processCount 5` |
| Acceptance (через ~2 хв) | exporter: 6 запусків за 3 хв, 0 помилок, snapshot `ok` віком 26 с; Agent: inventory і heartbeat `accepted`, 0 warn/error, 0 `insecure`/`permission`; центральна БД: Agent 0.2.0, heartbeat 13 с, inventory `ok`, 5 процесів (усі `online`, CPU/RAM відомі), збір 44 с тому → «Актуально» |
| Без рестартів / портів | God Daemon PID 3807 і всі 5 дочірніх PID із часом старту 6 жовтня — без змін; список listener-ів ідентичний baseline; у Agent/exporter listener-ів немає |

Перевірку в UI («Застосунки», сторінка сервера) виконує оператор під своєю сесією; адмінські credentials у цій сесії не використовувались.

Rollback (не застосовувався): `sudo systemctl disable --now node-control-pm2-exporter@ubuntu.timer`; `agent.env` ← `agent.env.bak-20261013T113342Z`; `server-release.js rollback --base /opt/node-control-agent` (→ `81e1933`); `systemctl restart node-control-agent` — heartbeat продовжиться. PM2 і проєкти не зачіпаються; дані в БД лишаються.

**Інцидент на локальній машині розробника (не сервер).** Під час діагностики exit 127 я виконав `npx pm2@7.0.4 --version` без `PM2_HOME`. Це запустило PM2 daemon у `~/.pm2` на Mac розробника — саме та поведінка auto-start, від якої захищає exporter. Каталог створено в момент діагностики, він не містив процесів (`module_conf.json = {}`, порожні `pids`/`logs`). Daemon зупинено через `pm2 kill`, `~/.pm2` видалено; сторонніх PM2 daemon немає. Висновок для процедур: **не запускати жодних `pm2`-команд поза тимчасовим `PM2_HOME`**, навіть `--version`.

## Task 008 — read-only PM2 inventory і застосунки (2026-10-13)

**Active code revision на центральному сервері: API/UI і реліз Agent — `ffb32b0ef7269c3c37ecefa20d181fc333632d08`** (`feat(pm2): add read-only process inventory and applications UI`); previous — `0ba0824`. `0ba0824`, `005fa62`, `bfe784e` — предки. Цей звіт — пізніший docs-commit, на сервер не деплоївся. **Exporter ніде не встановлений і процеси PM2 ще не збираються.** На `app-server` працює Agent 0.1.0 без inventory.

Стан на початок: `main` = `81e1933`, дерево чисте. Виправлення Task 007.1 у коді й тестах підтверджено: прив'язка стану до id, `CredentialControls` з key, `readBoundedBytes`/`parseAcceptedBody`. На сервері API/UI і Agent — `0ba0824`. Підключено окремий сервер `app-server` (hostname `app-server`, Agent 0.1.0, heartbeat надходить). SSH-доступу до нього в цій сесії немає. Локальний Agent центрального сервера — disabled.

**Реалізовано (ADR-016):**
- **PM2 exporter** (`agent/src/pm2/`, `agent/dist/pm2-exporter.js`): власний клієнт протоколу PM2 лише для `getMonitorData` до **існуючого** daemon, без пакета pm2 і без auto-start; allowlist-санітизація (секрети `pm2_env` не виходять за межі пам'яті exporter); атомарний snapshot-файл; systemd-шаблони `node-control-pm2-exporter@<owner>.service|.timer` (не root, лише AF_UNIX, без мережі).
- **Agent 0.2.0:** окремий незалежний цикл inventory (`NC_AGENT_INVENTORY_FILE`), безпечне читання файлу, звіт `ok|stale|unavailable`, строгий контракт відповіді, пауза після 404 старого API.
- **API:** міграція `1791900000003_pm2-inventory` (additive: `server_inventories`, `server_applications`); `POST /api/agent/inventory` (machine auth, identity з credential, ≤ 500 процесів / 512 KiB, конкурентність 4+8); `GET /api/applications` (keyset, фільтри server/status) і `GET /api/servers/:id/applications` (`monitoring:read`). Reconciliation: заміна набору, `unavailable`/`stale` зберігають останні дані з позначкою, старіший snapshot ігнорується, той самий — без оновлення свіжості.
- **Strict schemas на всіх `/api`:** Ajv `removeAdditional: false`. Зайві поля тепер дають 400, а не мовчки обрізаються. Наслідок: heartbeat із підробленим `serverId` → 400 (тест оновлено). Чинні клієнти не зачеплені.
- **UI:**
  - «Застосунки»: реальні процеси, фільтри й курсор в URL (identity-safe), явна свіжість (актуально / застарілі / exporter недоступний / сервер офлайн), «—» для невідомих метрик;
  - секція «Застосунки PM2» на сторінці сервера зі станом інтеграції;
  - кнопок керування немає; імена рендеряться лише як текст.
- **Не реалізовано:** start/stop/restart/delete, логи, redeploy, Jenkins, кілька PM2 owners на сервер.

| Перевірка (Node v22.23.3) | Результат |
|---|---|
| `npm run check:local` | exit 0: node:test 85/85, typecheck, lint, backend 322/322, smoke 10/10, agent 99/99 (+2 opt-in пропущено), збірка agent, frontend 86/86, збірка UI |
| Agent/exporter (`agent/test/inventory.test.ts`, 28) | санітизація з синтетичними секретами в усіх полях `pm2_env`; `null` замість штучного 0; дублікати/ліміти; протокол на фейковому daemon (по 1 байту, error/чужий id/завеликий frame/сміття/тиша → protocol_error/timeout); відсутній daemon → `daemon_not_running` без змін у `PM2_HOME`; статична перевірка: без `pm2`/`child_process`, лише `getMonitorData`; атомарний запис 0640, відмова при symlink/group-writable/чужому каталозі; читання — відмова при власному файлі Agent, symlink, writable, oversize, malformed; stale без процесів; 404 → 900 с; heartbeat не блокується зависанням inventory |
| Справжній PM2 (`npm run test:agent:pm2`, pm2@7.0.4, тимчасовий `PM2_HOME`) | 2/2: без daemon → `daemon_not_running`, `PM2_HOME` лишився порожнім (daemon не стартував); з daemon → процес `online`, у файлі немає секрету з argv/env; після `pm2 kill` → `daemon_not_running`, `rpc.sock`/`pm2.pid` не з'явились |
| API (`backend/test/inventory-api.test.ts`, 31) | identity лише з credential (зайвий `serverId` → 400); 401/403 machine/browser separation; revoked → 401; 16 невалідних payload → 400 без запису; 413; 503 (ліміт/збій) без секретів у логах; права viewer/operator/admin; пагінація/фільтри/валідація курсора; маршрутів керування немає (404) |
| Real-DB (`test:backend:db`, тестова БД, per-run schema) | 49/49 (+11 inventory): constraints, заміна набору, повторне використання `pm_id`, порожній ≠ unavailable, stale, зміна source без orphans, старіший snapshot ігнорується, свіжість за серверним годинником, конкурентні звіти (найновіший перемагає), revoked/inactive → unauthorized, keyset через 3 сторінки |
| Frontend (`applications.test.tsx`, 13) | дані/stale/offline/unavailable/порожньо/помилка/403/401; XSS-ім'я лише текстом; немає кнопок керування; фільтр не показує рядки попереднього фільтра; A→B на сторінці сервера (повільно/503) без даних A; відповідь для чужого сервера відхиляється |
| E2E (Playwright, тестова БД) | 10/10: новий сценарій — справжні backend+UI+скомпільований Agent із синтетичним snapshot → «Актуально», фільтр, viewer, `unavailable` зберігає 3 процеси з позначкою |

| Деплой (центральний сервер) | Результат |
|---|---|
| Baseline | API/UI `0ba0824` (prev `97d1c06`), реліз Agent `0ba0824`, локальний Agent disabled/inactive, `agent.env` відсутній; служби active, failed 0; heartbeat `app-server` (0.1.0) — 20 с тому |
| Артефакти `ffb32b0` | API/UI: 40 файлів, SHA-256 `8ad8e388…98dfac`, prod deps `fastify`, `node-pg-migrate`, `pg`; Agent: 20 файлів (вкл. exporter і unit-шаблони), `f2816219…205c5f`; `sha256sum -c` OK |
| Backup | `/root/node-control-backups/node_control_db-20261013T104828Z-pre-ffb32b0….dump` (`600 root`), `pg_restore --list` читається |
| Міграція | як `nodecontrol`: pending 1 → applied=4, pending=0; нові таблиці порожні; servers=1, активний credential 1, audit 5 — без змін |
| API/UI | unit-файл без змін; `current` → `ffb32b0`; restart лише `node-control-api`; `nodecontrol`, listener лише `127.0.0.1:3100`; `api.env` не змінювався (`trustedProxies:1`, `authOrigins:1`, `cookieSecure:true`) |
| Реліз Agent | `/opt/node-control-agent/current` → `ffb32b0`; unit-файл без змін; локальний unit лишився disabled/inactive. Шаблони exporter проходять `systemd-analyze verify` (у тимчасовому каталозі, на `/etc/systemd/system` не встановлювались) |
| Після деплою | live/ready 200; HTTPS `/`, `/applications`, `/servers/<id>` → 200, bundle = `current`; анонімні `/api/auth/me`, `/api/applications`, `/api/servers/:id/applications` → 401; `POST /api/agent/inventory` без токена/з невідомим токеном → 401, з Origin → 403; **старий Agent 0.1.0 продовжує heartbeat** (останній — 27 с, 0 відповідей 4xx після strict schemas); journal: 0 error/fatal, 0 збігів секретів; `nginx -t` OK; Nginx/PostgreSQL/Docker active, failed 0; migrations pending=0 |

**Віддалена активація (`app-server`) — не виконана.** Немає SSH-доступу й не відомі PM2 owner та `PM2_HOME`. Потрібно: оновити Agent до `ffb32b0` (реліз + restart, `agent.env` і токен не змінюються) і встановити exporter за DEPLOYMENT («PM2 inventory exporter»). До цього UI показує для сервера «Агент ще не передавав inventory PM2».

> **Виправлення (Task 008.2):** рекомендація вище застаріла — `ffb32b0` містить дефектний unit exporter (`ConditionUser=!root`, instance пропускався). Встановлювати лише запушений реліз, що містить `7cdc50e` (`git merge-base --is-ancestor 7cdc50e <release-sha>`). Фактично `app-server` активовано з релізом `7cdc50e` — див. Task 008.1/008.2.

Rollback (не застосовувався): API — `server-release.js rollback` (→ `0ba0824`) + restart `node-control-api`; таблиці inventory лишаються (additive), відновлення БД не потрібне. Реліз Agent — `server-release.js rollback --base /opt/node-control-agent` (→ `0ba0824`), unit лишається disabled. Exporter ніде не активовано, тож і вимикати нічого.


## Task 007.1 — виправлення після review Codex (2026-10-13)

**Active code revision на сервері: API/UI і Agent — `0ba08240d7c5b5a51472553fba422d20fa45fcdb`** (`fix: isolate server credential UI state and validate heartbeat responses`). Previous: API/UI `97d1c06`, Agent `e2ac0c9`. `bfe784e` і `005fa62` — предки. Цей звіт — пізніший docs-commit, на сервер не деплоївся.

Стан до початку: `main` = `5605221`, дерево чисте. На сервері API/UI `97d1c06`, Agent `e2ac0c9`. Оператор уже створив сервер і видав ключ (1 сервер, 1 активний credential), але `agent.env` ще не записано: Agent disabled/inactive, heartbeat-ів 0. Цей стан зберігається.

**P1 — дії з ключем могли піти на попередній сервер.** `usePolledResource` тримав дані останнього успішного завантаження незалежно від id. Після переходу `/servers/A` → `/servers/B` без reload і 503 для B сторінка B показувала сервер A з його `CredentialControls`, і «Видати ключ» надсилав `POST /api/servers/A/agent-credentials`.

Виправлення (ADR-015, «Ідентичність ресурсу в UI»):
- `usePolledResource(load, resourceKey)` зберігає стан разом із ключем. Для іншого ключа в тому самому render повертається `loading`. Помилка нового ресурсу не підставляє дані попереднього; last known data зберігаються лише при refresh того самого ключа.
- `ServerDetailPage` показує дані лише якщо `data.id === id` із URL.
- `CredentialControls` монтується з `key = id + сесія`, тому підтвердження, помилка й виданий токен не переживають зміну сервера, logout чи нову сесію.
- Мутації мають `AbortSignal` і скасовуються при unmount. Результат після скасування ігнорується: токен не показується, reload не запускається. Відповідь із чужим `serverId` — помилка, токен не показується.
- Скасування не вважається відкатом: сервер міг уже виконати дію; автоматичних повторів немає.

**P2 — Agent повертав `accepted` при помилці читання body.** `response.text().catch(() => '')` при HTTP 200 давав `{kind:'accepted', intervalSeconds:null}` навіть після обриву потоку. Timeout не охоплював читання body; відповідь не перевірялась.

Виправлення (ADR-015, «Контракт відповіді heartbeat»):
- Один дедлайн і сигнал скасування охоплюють fetch і читання body. Body обмежено 4096 байтами за фактичним потоком; завеликий `Content-Length` відхиляється без читання; декодування — строгий UTF-8.
- `accepted` лише для `200` + `{status:'accepted', receivedAt: ISO-8601 UTC (round-trip toISOString), intervalSeconds: ціле 5–300}`.
- Новий outcome `invalid_response` (порожній, завеликий, не-JSON, `null` або порушений контракт) дає звичайний експоненційний backoff, лічильник збоїв не скидається. Обрив потоку → `network`, дедлайн → `timeout`, скасування → `aborted`.
- Для не-200 body не читається, класифікація лише за статусом.
- Контракт backend не змінювався (30 с, ISO): backend-тест тепер явно фіксує ключі, формат `receivedAt` і діапазон інтервалу. Схема БД, endpoints і міграції не змінювались.

| Перевірка (Node v22.23.3) | Результат |
|---|---|
| Regression P1 (`frontend/test/server-identity.test.tsx`, MemoryRouter + `useNavigate`, той самий route з новим параметром) | 12/12 з виправленням. На старому коді падають 6: B повільний; B 503; pending issue A → B; підтвердження A; token dialog A; чужий `serverId` |
| Regression P2 (`agent/test/agent.test.ts`, «heartbeat response body») | 36/36 з виправленням (асинхронні `ReadableStream`, реальний HTTP-сервер з обривом і зависанням body). На старому коді падає 18, зокрема відтворення Codex (stream error → accepted), body timeout, cancel і oversized |
| `npm run check:local` | exit 0: node:test 85/85, typecheck, lint, backend 291/291, smoke 10/10, agent 71/71, збірка agent, frontend 74/74, збірка UI |
| `test:backend:db` (ізольована тестова БД через тунель) | 38/38. Перший запуск: ECONNREFUSED, бо впав SSH-тунель; після перепідключення успішно |
| `test:e2e` (тестова БД) | 9/9; 0 схем `nc_test_*` після прогону |
| `check:secrets`, `git diff --check` | OK |

| Деплой | Результат |
|---|---|
| Артефакти `0ba0824` | API/UI: 36 файлів, SHA-256 `68fa4f9a…62d877bc`; Agent: 11 файлів, `e1d57263…6a43389`; `sha256sum -c` OK; prod deps як раніше (89 пакетів; scope-каталоги dev-залежностей порожні, як і в `97d1c06`) |
| Стан до | API `97d1c06` (prev `005fa62`); Agent `e2ac0c9` (prev `97d1c06`), unit disabled/inactive, `agent.env` відсутній |
| Міграції | не потрібні: applied=3, pending=0; backup БД не робився (схема й дані не змінюються) |
| API/UI | unit-файл без змін; `current` → `0ba0824`; restart лише `node-control-api`; процес `nodecontrol`; listener лише `127.0.0.1:3100`; `api.env` не змінювався (лог старту `trustedProxies:1`, `authOrigins:1`, `cookieSecure:true`) |
| Agent | unit-файл без змін; `current` → `0ba0824`; був inactive → не запускався; стан після: disabled/inactive, `agent.env` відсутній, без конфігу exit 2, listener-ів 0 |
| Після деплою | live/ready 200; HTTPS `/`, `/servers`, `/servers/<id>` → 200; bundle UI збігається з `current/frontend/dist`; анонімні `/api/auth/me`, `/api/servers` і heartbeat без токена → 401; journal API: 0 error/fatal, 0 збігів секретів; `nginx -t` OK; Nginx/PostgreSQL/Docker active, failed units 0; у БД без змін (1 сервер, 1 активний credential, 0 heartbeat) |
| Egress-smoke Agent | одноразово як `nodecontrol-agent` з фіктивним токеном через env → `unauthorized`; записів у БД 0. Штатний `accepted` не перевірявся: оператор ще не записав `agent.env` |

Rollback (не застосовувався): API — `server-release.js rollback` (→ `97d1c06`) + restart `node-control-api`; Agent — `server-release.js rollback --base /opt/node-control-agent` (→ `e2ac0c9`), unit лишається disabled. Схема, конфіг і credentials не змінювались, тому відновлювати їх не потрібно.

Окремого E2E-сценарію для переходу A → B не додано: його покриває real-router тест frontend. Наявний E2E servers.spec (видача/відкликання ключа, Agent online/unauthorized) успішний.

## Task 007 — реєстр серверів, Agent heartbeat, UI серверів (2026-10-12)

**Active code revision на сервері:** API/UI — `97d1c0624cb3c4e382df1f90822cdde15086a97a` (`feat(agent): add server registry and authenticated heartbeat`), previous — `005fa62`; Agent — `e2ac0c91879f6e672cdfed4fd6e30102c9809557` (`fix(agent): treat missing env file as configuration error`), previous — `97d1c06`. `e2ac0c9` змінює лише `agent/` (backend/frontend ідентичні `97d1c06`), тому API не передеплоювався. `bfe784e` і `005fa62` — предки. Цей звіт — пізніший docs-commit, на сервер не деплоївся.

**Реалізовано (ADR-015).** Міграція `1791900000002_server-registry` (additive): `servers`, `agent_credentials` (SHA-256 digest токена, partial unique index — один активний credential на сервер, `revoked_at >= created_at`), `server_heartbeats` (останній snapshot ≤ 2048 байт). Admin-only (`servers:manage`) створення сервера, видача/ротація (атомарно, транзакційний audit `agent.credential_issued{rotated}`), відкликання (`agent.credential_revoked`); перегляд — усі ролі. Machine auth `POST /api/agent/heartbeat`: `Bearer ncag_…` (32 байти), відмова з Origin/Sec-Fetch-* (403) або session cookie (401); browser-маршрути відхиляють `Authorization`. Ліміти: 120/хв на IP, 20/хв на токен, конкурентність 8 (+16 у черзі, далі 503), body ≤ 4096 байт, строгий snapshot (`additionalProperties:false`). Agent (TypeScript strict, лише built-ins): тільки вихідний HTTPS з перевіркою TLS, `redirect:'error'`, без HTTP fallback, послідовний цикл, backoff із jitter, Retry-After, graceful shutdown; exit 2 на помилку конфігурації (без restart-циклу). UI: список/деталі з polling 15 с (лише видима вкладка), статус онлайн (вікно 90 с), діалоги створення/видачі/ротації/відкликання, одноразовий показ ключа.

**Виправлення під час деплою.** На сервері без `agent.env` Agent завершувався з кодом 1 (ENOENT від `statSync`), і systemd перезапускав би його до StartLimit. Тепер це `AgentConfigError` → exit 2 (`RestartPreventExitStatus=2`). Додано regression-тест; commit `e2ac0c9`.

| Перевірка | Результат |
|---|---|
| Node v22.23.3 (`97d1c06`) | backend 291/291, frontend 62/62, agent 34/34, compiled smoke 10/10, node:test 85/85; `check:local` exit 0 |
| Real-DB (тестова БД, per-run schema) | 38/38: обмеження схеми, один активний credential, конкурентна ротація, монотонний `received_at`, transactional audit; 0 схем `nc_test_*` після прогону |
| E2E (Playwright, тестова БД) | 9/9: admin створює сервер і видає ключ → скомпільований Agent «Онлайн»; viewer → 403; відкликання → Agent `unauthorized`, `received_at <= revoked_at`; audit-події |
| `e2ac0c9` | agent 35/35, node:test 85/85, typecheck, lint, `check:secrets` OK |
| Артефакти | API `97d1c06`: 36 файлів, SHA-256 `d423cbe6…acf0b99`; Agent `97d1c06`: 11 файлів, `0c7c82e9…c4bfda`; Agent `e2ac0c9`: 11 файлів, `bbaae1d9…b573c17`; `sha256sum -c` OK |
| Backup | `/root/node-control-backups/node_control_db-20261012T200658Z-pre-97d1c06….dump` (`600 root`), `pg_restore --list` — 8 таблиць |
| Міграція | як `nodecontrol` з підготовленого релізу: pending 1 → applied=3, pending=0; таблиці й індекс `agent_credentials_one_active_idx` на місці; servers/credentials/heartbeats — 0 рядків |
| Активація API | `current` → `97d1c06`; restart лише `node-control-api`; процес `nodecontrol`; listener лише `127.0.0.1:3100`; лог старту `trustedProxies:1`, `authOrigins:1`, `cookieSecure:true` |
| Після деплою | live/ready 200; `https://control.example.com/` і `/servers/<id>` → 200 (SPA); анонімні `/api/auth/me`, `/api/servers` → 401; heartbeat без токена → 401; journal: 0 записів error/fatal, 0 збігів `ncag_`/password; `nginx -t` OK; PostgreSQL/Nginx active |
| Agent (перша тестова нода — цей сервер) | користувач `nodecontrol-agent` (uid 994, `/usr/sbin/nologin`, home `/nonexistent`, без sudo); `/opt/node-control-agent` current=`e2ac0c9`; `/etc/node-control-agent` `750 root:nodecontrol-agent`, `agent.env` **відсутній**; unit встановлено, `systemd-analyze verify` OK, **disabled/inactive**; без конфігу → exit 2; listener-ів немає |
| Egress-smoke Agent | одноразовий запуск як `nodecontrol-agent` з фіктивним (не виданим) токеном через env: HTTPS до публічного сайту з перевіркою TLS → `unauthorized`, наступна спроба через 900 с; процес зупинено timeout-ом; записів у БД 0 |

Production credential **не створювався** (ні через SQL, ні через UI); security/load тести проти production не запускались; firewall/HBA/сторонні служби/публічний Nginx-конфіг не змінювались; Agent-порт не відкривався.

**Підключення першої ноди (оператор):** UI → «Сервери» → «Додати сервер» → «Видати ключ» → на сервері записати `agent.env` через `read -rs` (процедура в DEPLOYMENT, розділ «Agent») → `systemctl enable --now node-control-agent` → у журналі `"outcome":"accepted"`, в UI статус «Онлайн».

**Rollback (не застосовувався):** API — `server-release.js rollback` (→ `005fa62`) + restart `node-control-api`; heartbeat зникне (404), нові таблиці лишаються (additive), відновлення БД з backup не потрібне. Agent — `systemctl disable --now node-control-agent` і/або `server-release.js rollback --base /opt/node-control-agent` (→ `97d1c06`).

## Task 006.1 — login rate limit за Nginx (2026-10-12)

**Active code revision на сервері: `005fa629570273931db33a1ccef1b3ca527f02c9`** (`fix(auth): isolate login rate limits behind trusted nginx proxy`); previous — `85f047c`. Цей звіт — пізніший docs-commit, на сервер не деплоївся.

**Проблема (review Codex, P1).** `addressLimiter` брав `request.socket.remoteAddress`; за Nginx це завжди `127.0.0.1`, тож усі клієнти ділили ліміт 30 спроб / 15 хв — будь-хто міг заблокувати вхід іншим. До виправлення Nginx також пропускав клієнтський `X-Forwarded-For` без змін.

**Виправлення (ADR-014).** `API_TRUSTED_PROXIES` (точні loopback-IP; default порожньо → Fastify `trustProxy: false`); production `127.0.0.1`. Ліміт за адресою — `request.ip` (заголовки в auth-коді не читаються); не-IP від proxy → спільний ключ `unresolved`. Nginx `/api/`: `X-Forwarded-For $remote_addr` (замінює клієнтський) і `X-Forwarded-Host $host`; `Host`, `X-Real-IP`, `X-Forwarded-Proto` без змін. Per-account і hashing limiter, Origin/CSRF не змінювались.

| Перевірка | Результат |
|---|---|
| Regression/security (`backend/test/auth-proxy.test.ts`, Node 22) | 25/25: default ігнорує forwarded-заголовки; недовірений peer не змінює IP; довірений proxy → IP з `X-Forwarded-For`; `X-Real-IP` ніколи не джерело; підроблений ланцюжок не обирає адресу; missing/malformed → визначена поведінка (`unresolved`); незалежні ліміти різних IP; підробка не обходить ліміт (через proxy й напряму); per-account між IP; Origin/CSRF; конфіг (відхилення hostname/CIDR/не-loopback/`*`, ліміт довжини, без echo значень) |
| Доказ регресії | зі старим `socket.remoteAddress` тест незалежних лімітів падає; код відновлено |
| `npm run check:local` | exit 0: node:test 82/82, typecheck, lint, backend 259/259, smoke 10/10, frontend 50/50, збірка UI |
| Node v22.23.3 | backend 259/259, frontend 50/50, node:test 82/82 |
| Real-DB / E2E (тестова БД, без proxy, default config) | 27/27 / 8/8; 0 схем `nc_test_*` після прогону |
| Production-подібний ланцюжок (сервер, ізольовано) | тимчасовий nginx `127.0.0.1:39180` з тими ж заголовками → backend підготовленого релізу `127.0.0.1:39100` (`trustProxy 127.0.0.1`, store-заглушка, без БД), ліміт 2: клієнт 127.0.0.2 з підробленими XFF/X-Real-IP → 401, 401, 429; клієнт 127.0.0.3 → 401, 401 (незалежно); прямий недовірений 127.0.0.4 з підробленим XFF → 401, 401, 429; тимчасові процеси зупинено, каталог видалено |
| Git / артефакт | `005fa62` запушено; 32 файли, SHA-256 `52ada27f…c3cf18a9`, `sha256sum -c` OK; prod deps `fastify`, `node-pg-migrate`, `pg` |
| Nginx | backup `/root/node-control-backups/nginx-trusted-proxy-20261012T192840Z/`; `nginx -t` → +2 рядки в `location /api/` (і перевід рядка в кінці файлу від awk) → `nginx -t` → reload; нових записів у `error.log` немає |
| `api.env` | backup `api.env.bak-20261012T192906Z`; додано лише `API_TRUSTED_PROXIES=127.0.0.1`; `600 nodecontrol`; інші ключі без змін; лог старту: `trustedProxies:1`, `authOrigins:1`, `cookieSecure:true` |
| Активація | міграції pending=0; `current` → `005fa62`; restart лише `node-control-api`; процес `nodecontrol`; listener лише `127.0.0.1:3100` |
| Після деплою | live/ready 200; `https://control.example.com/` 200, `/servers`, `/audit` → index.html; `/api/auth/me` (з підробленими XFF/X-Real-IP) → 401 `no-store`; `/api/nope` → 404 JSON; journal без warn/error, паролів 0; PostgreSQL/Nginx/Docker active, failed 0, менеджер секретів 200; 3100/3101 ззовні недоступні |

Production login/навантажувальні тести не виконувались; пароль адміністратора не змінювався (його сесія збереглась). Rollback (не застосовувався): `server-release.js rollback` (→ `85f047c`) + видалити `API_TRUSTED_PROXIES` / відновити `api.env.bak-20261012T192906Z` + restart API; Nginx — повернути файл із backup, `nginx -t`, reload (заміна XFF безпечна й для старого релізу, тож Nginx можна лишити).

## Task 006 (оновлення) — публічний HTTPS-сайт (2026-10-12)

**Active code revision на сервері: `85f047ccd86bc7b7fb90a3e614a3fec6cefe8a6a`** (`chore(deploy): serve UI via public HTTPS site, drop loopback nginx site`); previous — `fd16acb`. Runtime-код (backend/frontend) ідентичний `fd16acb`; `bfe784e` — предок (`git merge-base --is-ancestor`). Цей звіт — пізніший docs-commit, на сервер не деплоївся.

| Крок | Результат |
|---|---|
| Аудит сайту (read-only) | `conf.d/control.example.com.conf` без змін з 18:40 UTC: `root /opt/node-control/current/frontend/dist`; `/api/` → `proxy_pass http://127.0.0.1:3100` (URI зберігається); 80 → 301 на HTTPS; `nginx -t` OK |
| TLS | Let's Encrypt `CN=control.example.com`, до 2027-01-10; ланцюжок перевіряється (`ssl_verify_result=0`); оновлення — `snap.certbot.renew.timer` |
| Репозиторій | loopback-шаблони Nginx видалено з репозиторію й артефакту; ADR-013; тести 82/82 (Node 22), `check:local` exit 0 |
| Артефакт | 32 файли, SHA-256 `16e1d741…c41e17bea`; production deps `fastify`, `node-pg-migrate`, `pg` |
| Конфіг API | backup `api.env.bak-20261012T190308Z`; змінено лише `AUTH_ALLOWED_ORIGINS=https://control.example.com` (атомарно, `600 nodecontrol`); `AUTH_COOKIE_SECURE=true`; інші ключі без змін; лог старту: `authOrigins:1, cookieSecure:true` |
| Міграції | applied=2, pending=0 (схема не змінювалась) |
| Активація | `current` → `85f047c`; restart лише `node-control-api`; процес `nodecontrol`; listener `127.0.0.1:3100` |
| Nginx | loopback-сайт 3101 прибрано: backup `/root/node-control-backups/nginx-remove-loopback-20261012T190332Z` (+ довідкова копія публічного конфігу), `nginx -t` → видалення лише власних 3 файлів → `nginx -t` → reload; 3101 більше не слухає. Публічний конфіг не змінювався |
| HTTPS smoke (ззовні) | `/` 200 `no-store`; `/assets/index-*.js` 200; `/servers`, `/applications`, `/audit`, `/login` → `index.html`; `/api/auth/me` 401 `no-store` + `x-request-id`; `/api/does-not-exist` → JSON 404; login із чужим Origin → 403 (без запису в БД) |
| Браузер | headless Chromium на `https://control.example.com/audit` → `/login`, `me` 401, 0 помилок консолі, 0 порушень CSP |
| Journal | поточний процес: лише штатні повідомлення + 1 власний 403-запит; паролів 0 |
| Сторонні служби | PostgreSQL/Nginx/Docker active, failed 0, менеджер секретів up/200; 3100/3101 ззовні недоступні; users/sessions/audit_log — 0 рядків |

Login із правильним Origin у production не виконувався (пише audit); адміністратора не створено — вхід можливий після bootstrap оператором. Rollback: `server-release.js rollback` (→ `fd16acb`) + restart API; `api.env` — з `api.env.bak-20261012T190308Z`; Nginx — повернути файли з backup-каталогу, `nginx -t`, reload.

## Task 006 — React/Vite frontend і спільний деплой (2026-10-12)

**Active code revision на сервері: `fd16acb9259c0bdc9f0a855fe3553cee92f4ffe6`** (`feat(frontend): add authenticated React app and static deployment`); previous — `be432c0`. `git merge-base --is-ancestor bfe784e fd16acb` — так: фікс Codex Task 005.1 (`bfe784e`, retry dummy hash) задеплоєно разом із цим релізом. Цей звіт — пізніший docs-commit, на сервер не деплоївся.

Реалізовано (ADR-012): React 19 + React Router 8 + Vite 8 UI українською — вхід, огляд, Сервери/Застосунки (чесні порожні стани), Журнал аудиту (keyset-пагінація, лише `audit:read`), користувач/роль/вихід; стани loading/empty/error/forbidden/unavailable; адаптивний layout, доступність (labels, `aria-invalid`/`aria-describedby`, фокус, skip-link). Сесія лише в пам'яті, епохи проти гонок, API-клієнт із timeout/cancel/runtime-валідацією. Артефакт тепер містить `frontend/dist` і `deploy/nginx`; ізольований loopback-сайт `127.0.0.1:3101`.

| Перевірка (поточна сесія) | Результат |
|---|---|
| `npm run check:local` (системний Node 24.14) | exit 0: secrets OK, node:test 82/82, typecheck (backend/frontend/e2e), lint, backend 234/234, smoke 10/10, frontend 50/50, збірка UI |
| Node v22.23.3 | backend 234/234, frontend 50/50, smoke 10/10, node:test 82/82 |
| `test:backend:db` (тестова БД, тунель 15432) | 27/27 |
| Playwright E2E (тестова БД, per-run схема) | 8/8: login → reload → me → audit → logout; viewer/operator — без навігації й 403 на прямий `/audit`; невірний пароль; expired і revoked сесії; прямі SPA URL; `/api/*` 404 JSON. Після прогону 0 схем `nc_test_*`; `test-results/` видалено |
| Bundle | `assertBundleClean`: без `.map`, серверних імен конфігурації й секретних шаблонів; `VITE_*` не використовується |
| Nginx-шаблон | синтаксис перевірено на сервері в ізольованому prefix до встановлення |
| Git | `fd16acb` запушено (`bfe784e..fd16acb`) |
| Артефакт | 34 файли, SHA-256 `db1e4657…8576e4ee`; `sha256sum -c` OK; production `npm ls --omit=dev`: `fastify`, `node-pg-migrate`, `pg` (порожні scope-каталоги dev-пакетів від npm, 0 файлів) |
| Міграції | `status` з нового релізу як `nodecontrol`: applied=2, pending=0 — схема не змінювалась; `api.env` не змінювався |
| Активація | `current` → `fd16acb`, previous `be432c0`; restart лише `node-control-api`; процес `nodecontrol` |
| Nginx | `nginx -t` baseline OK; нові файли (backup-каталог `/root/node-control-backups/nginx-20261012T185439Z`, змінюваних файлів не було): snippet заголовків, `sites-available/node-control-loopback.conf` + symlink; `nginx -t` OK → reload |
| API | live/ready 200; `/api/auth/me` 401 `no-store` + `x-request-id` |
| Loopback-сайт `127.0.0.1:3101` | `/` 200 `no-cache` + CSP/`X-Frame-Options`/`nosniff`/`Referrer-Policy`; `/assets/*.js` `max-age=31536000, immutable`; відсутній asset 404; `/servers` → index.html; `/api/auth/me` 401; `/api/does-not-exist` → JSON 404; login з loopback-origin → 403 (fail closed) |
| Браузер через SSH forwarding | headless Chromium: `/audit` → `/login`, `me` 401, 0 помилок консолі, 0 порушень CSP |
| Мережа | listeners `127.0.0.1:3100`, `127.0.0.1:3101`; ззовні 3100/3101 недоступні; публічний `https://control.example.com/` → 200 (UI, див. release blockers) |
| Journal / логи | warn лише очікувані (порожній allowlist; власний 403-запит); паролів 0; власний error log Nginx порожній |
| Сторонні служби | PostgreSQL/Nginx/Docker active, failed 0, менеджер секретів up/200; `users` — 0 рядків |

Rollback підготовлено, не застосовувався: `server-release.js rollback` (→ `be432c0`, узгоджена пара UI/API через одну `current`; у `be432c0` немає `frontend/dist`, тож loopback-сайт віддаватиме 404 на статику) + `systemctl restart node-control-api`; для Nginx — видалити symlink `sites-enabled/node-control-loopback.conf` (і за потреби snippet/site), `nginx -t`, `systemctl reload nginx`. БД/дані не змінювались.

## Task 005 — authentication, RBAC, audit (2026-10-12)

**Active code revision на сервері: `be432c0828b30aa8e8bb3916913e18b2580c2a6c`** (`feat(auth): add sessions, RBAC and audit foundation`); previous — `5ec6ece`. Цей звіт — пізніший docs-commit, на сервер не деплоївся.

Реалізовано (ADR-011): scrypt-хешування з bounded-параметрами і limiter; серверні сесії (digest у БД, абсолютний TTL, fixation-захист, logout); cookie `__Host-nc_session` (HttpOnly, SameSite=Strict, Secure); CSRF — точний Origin allowlist для всіх state-changing `/api` (включно з login) + session-bound `x-csrf-token`; ролі admin/operator/viewer, deny-by-default `config.access`; `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/audit`; rate limiting до hashing; транзакційний audit; bootstrap CLI; міграція `1791900000001_auth-foundation`. Frontend, Agent, CRUD користувачів, password reset — не реалізовано.

| Перевірка (поточна сесія) | Результат |
|---|---|
| `npm run check:local` (Node v24 системний) | exit 0: secrets OK, node:test 80/80, typecheck, lint, Vitest 233/233, smoke 10/10 |
| Node v22.23.3 | Vitest 233/233; smoke 10/10 (anonymous me 401, compiled bootstrap CLI fail-closed, dist імпортує лише `fastify`/`pg`/`node-pg-migrate`); node:test 80/80 |
| `test:backend:db` (тестова БД через тунель 15432) | 27/27: міграції, constraints/indexes, login→me→audit→logout, fixation, expiry, актуальна роль/деактивація, failed-login без email, реальний rollback сесії й bootstrap при збої audit, 5 конкурентних bootstrap → 1 адмін, CLI end-to-end; після прогону 0 схем `nc_test_*` |
| Read-only `test:integration` проти production | 12/12 (тимчасовий тунель, закрито) |
| Git | `be432c0` запушено до деплою |
| Артефакт | 29 файлів, SHA-256 `64bc712b…fecda1be`; без тестів/fixtures/`.env*`/`.map`; `npm ci --omit=dev`: `fastify`, `node-pg-migrate`, `pg`, без devDependencies |
| Backup | `pg_dump -Fc node_control_db` → `/root/node-control-backups/node_control_db-20261012T175555Z-pre-be432c0….dump` (`600 root`), `pg_restore --list` читає (users, pgmigrations, функція, тригер) |
| Конфіг | `api.env.bak-20261012T175555Z` (`600 nodecontrol`); додано лише `AUTH_COOKIE_SECURE=true`, `AUTH_SESSION_TTL_MINUTES=480`, `AUTH_ALLOWED_ORIGINS=` (порожньо); `DB_*` не змінено; `600 nodecontrol:nodecontrol` |
| Міграція (як `nodecontrol`, з релізу) | pending `1791900000001_auth-foundation` → applied; status applied=2 pending=0 |
| Схема read-only | `audit_log`, `sessions`, `users.role` з усіма constraints та індексами; users/sessions/audit_log — 0 рядків |
| Активація | current `be432c0`, previous `5ec6ece`; restart лише `node-control-api`; enabled/active; процес `nodecontrol`; listener лише `127.0.0.1:3100`; ззовні недоступний |
| HTTP | live 200; ready 200 `no-store`; `GET /api/auth/me` без сесії → 401 `no-store` + `x-request-id`; login без Origin → 403; `/api/audit` анонімно → 401 |
| Journal | warn лише очікувані (порожній allowlist; власний 403-запит); паролів 0 |
| Сторонні служби | PostgreSQL/Nginx/Docker active, failed 0, менеджер секретів up/200 |

Auth DML-smoke у production не виконувався (повний login/logout — лише в тестовій БД). Rollback підготовлено, не застосовувався: `server-release.js rollback` (→ `5ec6ece`) + за потреби відновити `api.env.bak-…` + restart API; additive-схема й дані лишаються.

## Відомі проблеми та ризики

1. Локальне підключення до PostgreSQL можливе лише через SSH-тунель: у Task 002/002.1 тунель на `127.0.0.1:15432` працював і `SELECT 1` проходив. Це не означає, що `127.0.0.1:5432` локально або тунель доступні зараз — тунель відкривається вручну й закривається після перевірки. Успішний `SELECT 1` не підтверджує HBA, firewall, TLS чи стан сторонніх служб, тому Task 001 лишається частково підтвердженим.
2. HBA-правило з `db:setup` дозволяє будь-яку IPv4-адресу для ролі Node Control; захист залежить від мережевих правил хоста. Не відкривати 5432.
3. Клієнт `pg` не задає TLS; ранні loopback HBA-правила допускають `host`, тому SCRAM-тести не підтверджують шифрування. Сертифікат у старому звіті self-signed.
4. README раніше стверджував повне покриття всіх скриптів та перевірку активного HBA. Unit-тести перевіряють бібліотеки, але не всі orchestration/error paths `setup-postgres.js`; `pg_hba_file_rules` описує файл на диску, не доводить ефективну політику поточних з'єднань.
5. `--env-owner` впливає лише на запис нового `.env`; при валідному існуючому `.env` без ротації власник не зміниться. Потрібен окремий контрольований крок перед запуском сервісу.
6. Ротація пароля та setup не є єдиною транзакцією: `.env` записується раніше SQL, помилка може залишити невідповідний пароль. HBA rollback не охоплює всі винятки після запису файлу. Потрібне окреме завдання з failure-path тестами.
7. Сканер секретів пропускає файли понад 1 MiB, використовує обмежені шаблони та поточний DB_PASS. Перевірка не гарантує виявлення всіх типів секретів або старих паролів.
8. `db:setup --rotate-password` перезаписує `.env` лише DB-ключами (`formatEnv`) — `API_*`, `LOG_LEVEL`, `NODE_ENV` у тому ж файлі буде втрачено (є defaults, але кастомні значення зникнуть).
9. Локально Node.js 24; Node 22 перевірено через `npx node@22`, `npm run check:local` без нього запускає Vitest на системному Node.
10. API працює як systemd-сервіс лише на loopback; Nginx, домен і HTTPS ще не налаштовані. Health endpoints публічні за задумом, інших маршрутів немає.
11. Логи помилок містять лише `category`/`code` без тексту (ADR-007) — діагностика конкретної помилки потребує відтворення; розширення — окремим рішенням з явно безпечними полями.
12. Fatal handlers (`uncaughtException`/`unhandledRejection`) завершують процес одразу без graceful shutdown; перезапуск забезпечує systemd (`Restart=on-failure`, ≤5 разів за 5 хв).
13. `/health/ready` виконує `SELECT 1` на кожен запит без rate limit/кешу; перед публікацією через Nginx потрібне рішення.
14. Історичний `/etc/pm2-dashboard` досі містить збірку Task 002 і legacy `.env`; сервіс їх не використовує. Прибирання — окремим рішенням.
15. **NC-SEC-001 / P2 — відкладено за рішенням користувача.** Review Codex для `f4417d3`: `backend/src/errors.ts`, `validationIssues()` відображає Ajv `instancePath` у відповіді. Для схеми з динамічними ключами (`additionalProperties: { type: 'integer' }`) секретний ключ із запиту потрапляє у `validation[].path`. Відтворено тестовим маршрутом із синтетичним маркером; чинні health endpoints не мають такого сценарію. Виправлення: перевірені статичні шляхи, узагальнення/приховування динамічних ключів, regression-тести. Закрити до додавання endpoint зі схемою, що допускає динамічні ключі, або публікації такого endpoint. Відкладення не означає виправлення. Стан на Task 005: **відкрито**; задеплоєний API не має endpoint із динамічними ключами (усі схеми з явними properties).
16. Reboot-тест автозапуску не виконувався (спільний сервер); `enable` перевірено.
17. Старі релізи не прибираються автоматично; `/root/node-control-deploy/<sha>` зберігає артефакт для повторного prepare/діагностики.
18. Перед кожним деплоєм `build-release.js` вимагає чистий каталог і commit в `origin/main`; деплой не-`main` гілок не передбачено.
19. **Мережевий доступ до PostgreSQL** — рекомендовано обмежити джерела на рівні firewall окремим рішенням (деталі — у приватних операційних нотатках).
20. Тестова БД на тому ж кластері, що й production: ізоляція — на рівні ролей/ACL, не ресурсів (CPU/IO/connections спільні). У `public` тестової БД лишились об'єкти репетиції CLI.
21. Authentication реалізована в backend (Task 005), але в production немає адміністратора й allowed origins — вхід неможливий до Task 006 + Nginx/HTTPS і bootstrap оператором.
22. Rate limiting — у пам'яті одного процесу, скидається при рестарті; за майбутнім reverse proxy ліміт за адресою стане глобальним (trustProxy вимкнено) — переглянути з конфігурацією proxy.
23. Масове очищення старих сесій — ручний SQL (DEPLOYMENT); автоматично лише для користувача при його login.
24. Failed-login / authz.denied audit — best effort: при збої запису подія втрачається (логується), доступ не надається.

Повторний review Codex для `f4417d3`: 46 старих unit, 81 backend і 7 compiled smoke тестів успішні (backend/smoke на Node.js v22.23.3 поза sandbox); typecheck/lint/build/secrets/diff check успішні. Попередні витоки 500 logs і довільного 400 response усунені, startup cleanup обмежено в часі. Real-DB і сервер у цьому review не перевірялись.

## Task 005.1 — виправлення dummy hash після review Codex

Review відтворив P2: відхилений Promise першої ініціалізації `dummyHash` кешувався до рестарту. Після перевантаження hashing limiter невідомі акаунти продовжували отримувати 503 навіть після звільнення ресурсу; це порушувало однакову поведінку перевірки credentials.

Виправлення: успішна ініціалізація лишається спільною, але помилка очищає кеш і повторно передається поточним викликам; наступний запит може повторити ініціалізацію. Regression-тест із новим екземпляром модуля перевіряє два одночасні відхилені виклики при заповненому limiter, звільнення ресурсу та дві наступні успішні dummy-перевірки (результат `false`). Схема БД та API-контракт не змінені. Серверний revision цього виправлення ще не підтверджено.

Перевірки Codex для Task 005.1: `check:local` на Node.js v22.23.3 — успішно (80 node:test, 234 backend, 10 compiled smoke; typecheck, lint, build, secrets). Real-DB suite та сервер у цьому виправленні не перевірялись; SQL не змінювався.

## Активне та заплановане

In Progress: Task 013 (alerts, Slack, graceful shutdown), Task 013.1 (admin UI налаштувань і Slack-інтеграції, ADR-022) і Task 013.2 (egress-фікс, layout правил) — очікують незалежного review Codex; Task 013 ще не підтверджено. Completed: Task 012 (review Codex пройдено).

Next Task: узгоджений користувачем порядок: історія метрик → фінальна production-підготовка. Jenkins redeploy перенесений користувачем у далекий backlog після іншої автоматизації; у поточний план запуску не входить. Перед production-запуском — release blockers (5432, NC-SEC-001, hardening публічного сайту).

Planned: узгодити вузьку мережеву політику/TLS і усунути setup-ризики окремим завданням; окремий користувач сервісу й systemd; Fastify API та версійні міграції; агент; React/Vite + Nginx/TLS; авторизація й аудит для кожної адміністративної операції; Jenkins, менеджер секретів, Slack. Після стабілізації MVP — окрема оцінка контейнеризації API/Agents. Це план, а не реалізовані компоненти.


## Незалежний review Codex — об’єднана таблиця сервісів (2026-10-14)

Переглянуто зміни `3ff4653` і звіт `7eece06`; початкове робоче дерево чисте. У переглянутих змінах frontend блокувальних дефектів не знайдено. Це не повний незалежний аудит backend/broker Task 009.

Поточні перевірки на Node.js 22: `check:local` exit 0 (89 node:test, 342 backend, 10 smoke, 122 agent + 3 opt-in пропущені, 103 frontend; typecheck, lint, secrets, усі збірки); браузерні UI-тести зі синтетичними API-даними — 2/2, 1440/390 px. Real-DB і real-PM2 E2E у цьому review не повторювалися; результати Claude вище є історичними.

Read-only SSH: hostname `control-server`, current і RELEASE.json revision `3ff465367b99991a148d4475d773736d2ce5aca1`; API/Nginx active, ready 200, HTTPS `/` 200. У відповіді публічного `/` відсутні CSP, X-Frame-Options, X-Content-Type-Options і Referrer-Policy; hardening лишається відкритим release blocker. Поточну зовнішню доступність 5432 не перевірено, попереднє спостереження не закрито. Production PM2-команди, зміни конфігурації та деплой не виконувалися.

Залишок реалізації за кодом: перегляд/потік логів із обмеженням обсягу й доступу; Jenkins redeploy зі статусом, RBAC та аудитом; alerts/Slack із cooldown, deduplication і recovery; реальний Dashboard, історія метрик і retention; зміна власного пароля й admin-керування користувачами. Перед фінальним production-запуском — відкладені 5432/NC-SEC-001, публічні захисні заголовки та фінальна інтеграційна перевірка. Видалення PM2-процесів і підтримка кількох PM2 owners не включаються автоматично у найближчу задачу.

Документаційний борг: ARCHITECTURE досі містить твердження про необрані транспорт, ролі та міграційний інструмент, хоча вони реалізовані; нижні Next Task/Planned і частина відомих проблем цього документа мають історичні формулювання. Актуальний backlog визначати за кодом і цим review. Запис підготовлено локально; commit/push залишено Claude відповідно до останнього розподілу роботи користувача.


## Незалежний review Codex — Task 010 (2026-10-14)

Переглянуто `401667e` і docs-звіт `af89119`; початкове дерево чисте. Review не підтверджує завершення задачі: знайдено два P2 у ресурсних обмеженнях.

1. **P2 — broker звільняє слот до завершення читання.** `agent/src/control/broker.ts`, handleLogs: Promise.race повертає timeout, але readLogs продовжується; finally зменшує logReads. Відтворено із завислим mock list(): після timeout двох операцій третя починається, хоча всі три ще незавершені (maxConcurrentReads=2). Утримувати слот до фактичного завершення або підтвердженого скасування underlying operation; додати regression-тест повторних timeout і перевірку cleanup.
2. **P2 — кількість очікувачів результату не обмежена.** `backend/src/servers/logs.ts`, LogHub.get: кожен GET додає waiter і timer до одного Entry без per-request/per-actor/global ліміту; маршрут GET не очищає waiter одразу після disconnect. Відтворено 1000 одночасних get() одного запиту одного actor: 1000 waiters прийнято. maxRequests=200 і maxPendingPerActor=2 це не обмежують. Додати ліміти очікувань та cleanup при disconnect, regression для повторних GET, timeout і завершення результату.

Тимчасові локальні reproduction-тести 2/2 підтвердили поведінку й видалені; функціональний код не змінено. На Node.js 22 `check:local` exit 0: 89 node:test, 352 backend, 10 smoke, 163 agent +3 opt-in пропущені, 115 frontend; lint/typecheck/secrets і збірки успішні. UI Playwright із synthetic API: 2/2 desktop/mobile. Real-DB і real-PM2 E2E незалежно не повторювалися.

Read-only SSH підтвердив current `401667e653ed80f395a17a2ffa1c12657b9c9079` на центральному та керованому серверах; API/Nginx active, ready 200; Agent/broker/exporter timer active. **Allowlist ноди зараз: 5 targets, 5 з logs=true.** Початковий звіт деплою повідомляв 0, тому його стан не є поточним; хто й коли ввімкнув читання, цей review не встановлював. Production-текст не читався; конфігурації, служби і PM2-процеси reviewer не змінював. Рекомендація: обмежити використання production-читання до виправлення ресурсних лімітів. Запис review підготовлено локально, без commit/push/deploy.


## Незалежний review Codex — Task 010.1 (2026-10-14)

Переглянуто `2fe4d95` і docs-звіт `f0b320c`; початкове робоче дерево чисте. Обидва попередні P2 закриті в межах перевіреної реалізації: broker звільняє слот лише після завершення underlying read; API обмежує очікувачів (2 на запит, 3 на actor, 100 загалом) і прибирає їх при HTTP disconnect. Нових блокувальних дефектів у переглянутому diff не знайдено.

Незалежний `check:local` на Node.js 22: exit 0, 89 node:test, 358 backend (включно з waiter regression і реальним HTTP abort), 10 smoke, 164 agent (включно з повторними timeout та late resolve/reject) +3 opt-in пропущені, 115 frontend; typecheck/lint/secrets/збірки успішні. UI Playwright із синтетичними API-даними: 2/2 desktop/mobile. Real-DB, загальні E2E і real-PM2 E2E незалежно не повторювалися; результати Claude вище лишаються історичними. Перевірку нових regression на старому коді Codex цього разу не повторював.

Read-only SSH підтвердив current `2fe4d953f69bcf901bfaa73cc3d715a28264d446` на обох серверах; API/Nginx active, ready 200; Agent/broker/exporter timer active. Production-логи не читалися, конфігурації/служби/PM2-процеси reviewer не змінював. Функціональний код не змінено; запис review підготовлено локально без commit/push/deploy. Наступна задача — користувачі й паролі за погодженим roadmap.
