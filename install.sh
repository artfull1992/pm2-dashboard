#!/usr/bin/env bash
# Node Control — installer entry point (Central Server / Agent). Main route, from a git checkout:
#   git clone <URL> node-control && cd node-control && ./install.sh
# Kept minimal on purpose; it only does what must happen before TypeScript can run:
#   1. options, terminal, root (re-runs itself through sudo — the build later runs as the invoking user, never as root);
#   2. Ubuntu/systemd/architecture; the component (asked before anything is downloaded or built);
#   3. a compatible Node.js 22 (installer/bootstrap/node-runtime.env): the Node Control runtime in
#      /opt/node-control-runtime, a compatible /usr/bin/node, or — after confirmation — the pinned official build,
#      downloaded over HTTPS and checked against the SHA-256 committed in that file. The system Node.js is never changed;
#   4. trust checks of what root executes (release or checkout parts, and every directory above them);
#   5. hands over: installer/bootstrap/main.js (prepares a release of the committed revision, then the guided
#      installer of that release) or, with --release, the guided installer of an already prepared release.
# Arguments are passed as argv (never through eval or a shell string). A symlink to this file resolves to the checkout.
# Functions come first: the tests source this file (it returns before the main part) and call them directly.
set -euo pipefail

self=$(readlink -f -- "${BASH_SOURCE[0]}")
checkout=$(dirname -- "$self")
spec="$checkout/installer/bootstrap/node-runtime.env"
RUNTIME_DIR=/opt/node-control-runtime
RUNTIME_NODE=$RUNTIME_DIR/bin/node
SYSTEM_NODE=/usr/bin/node

usage() {
  cat <<EOF
Node Control — встановлення Central Server або Agent.

Основний маршрут (з checkout репозиторію, у терміналі):
  ./install.sh                         звичайний користувач: сам перезапуститься через sudo; збирання — від вас
  sudo ./install.sh                    те саме; від root без sudo — збирання від окремого користувача nodecontrol-build
  ./install.sh --component agent       одразу обрати компонент (server або agent)
Майстер перевіряє середовище, за потреби (після підтвердження) завантажує Node.js ${NODE_VERSION:-22} з nodejs.org
у $RUNTIME_DIR (системний Node.js не змінюється), збирає реліз закоміченої ревізії не від root,
показує план і лише після «так» встановлює. Окремі npm/build-команди не потрібні.

Advanced/offline:
  sudo ./install.sh --release <каталог>       з уже підготовленого релізу (build-release.js)
  sudo ./install.sh --node-archive <файл>     runtime з локального офіційного архіву node-v<версія>-linux-<arch>.tar.gz
                                              (перевіряється той самий SHA-256), без завантаження
  ./install.sh --help                         ця довідка (без root, нічого не змінює)
Докладно: docs/INSTALLATION.md.
EOF
}

die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# Pinned runtime: KEY=VALUE lines, each value validated; the file is data, never sourced.
read_spec() {
  NODE_MIN="" NODE_VERSION="" SHA256_LINUX_X64="" SHA256_LINUX_ARM64=""
  [ -f "$1" ] || return 1
  local key value
  while IFS='=' read -r key value; do
    case "$key" in
      NODE_MIN) [[ $value =~ ^22\.[0-9]+\.[0-9]+$ ]] && NODE_MIN=$value ;;
      NODE_VERSION) [[ $value =~ ^22\.[0-9]+\.[0-9]+$ ]] && NODE_VERSION=$value ;;
      SHA256_LINUX_X64) [[ $value =~ ^[0-9a-f]{64}$ ]] && SHA256_LINUX_X64=$value ;;
      SHA256_LINUX_ARM64) [[ $value =~ ^[0-9a-f]{64}$ ]] && SHA256_LINUX_ARM64=$value ;;
    esac
  done < "$1"
  [ -n "$NODE_MIN" ] && [ -n "$NODE_VERSION" ] && [ -n "$SHA256_LINUX_X64" ] && [ -n "$SHA256_LINUX_ARM64" ]
}

version_ok() { # $1 = x.y.z → Node.js 22 (never another major), not older than NODE_MIN
  local a b c ma mb mc
  IFS=. read -r a b c <<< "$1"
  IFS=. read -r ma mb mc <<< "$NODE_MIN"
  [[ $a =~ ^[0-9]+$ && $b =~ ^[0-9]+$ && $c =~ ^[0-9]+$ ]] || return 1
  [ "$a" -eq "$ma" ] || return 1
  [ "$b" -gt "$mb" ] || { [ "$b" -eq "$mb" ] && [ "$c" -ge "$mc" ]; }
}
node_version() { "$1" -p 'process.versions.node' 2>/dev/null || true; }

# Trusted owners: root, the user running this script and, under sudo, the user who invoked sudo (who could run
# anything as root anyway). Group write is harmless only through the PRIVATE group of a trusted user (Ubuntu's
# umask 002 for user-private groups): a group without listed members that is the primary group of exactly one account.
trust_init() {
  trusted=(0 "$(id -u)")
  [ -n "${SUDO_UID:-}" ] && [ "$SUDO_UID" != 0 ] && trusted+=("$SUDO_UID")
  foreign=()
  group_write=(-perm -020)
  local uid gid members owners
  for uid in "${trusted[@]}"; do
    foreign+=(! -user "$uid")
    gid=$(id -g "$uid" 2>/dev/null) || continue
    [ "$gid" != 0 ] || continue
    members=$(getent group "$gid" 2>/dev/null | cut -d: -f4) || members=unknown
    owners=$(getent passwd 2>/dev/null | awk -F: -v g="$gid" '$4 == g' | wc -l | tr -d ' ') || owners=0
    [ -z "$members" ] && [ "$owners" = 1 ] && group_write+=(! -group "$gid")
  done
  return 0
}

assert_ancestors() { # $1 = path: every directory above it belongs to a trusted user; others' write only root sticky
  local dir=$1
  while [ "$dir" != "/" ]; do
    dir=$(dirname -- "$dir")
    if [ -n "$(find "$dir" -maxdepth 0 \( "${foreign[@]}" \) -print)" ]; then
      die "Каталог $dir належить іншому користувачу — він міг би підмінити те, що виконується від root; перенесіть файли в каталог root або свій."
    fi
    if [ -n "$(find "$dir" -maxdepth 0 \( \( "${group_write[@]}" \) -o -perm -002 \) \( ! -perm -1000 -o ! -user 0 \) -print)" ]; then
      die "Каталог $dir доступний на запис іншим користувачам — перенесіть файли в захищений каталог."
    fi
  done
}

assert_protected() { # $1 = tree root executes from: no symlinks, no write for others, trusted owners only; + ancestors
  local problem
  problem=$(find "$1" \( -type l -o \( "${group_write[@]}" \) -o -perm -002 -o \( "${foreign[@]}" \) \) -print -quit)
  if [ -n "$problem" ]; then
    printf '✗ Не захищено від змін іншими користувачами: %s\n' "$problem" >&2
    echo "  Без symlink, без запису для інших і для спільних груп, власник — root або користувач, що запустив sudo (chown -R / chmod -R go-w)." >&2
    exit 1
  fi
  assert_ancestors "$1"
}

ask_yes() { # $1 = question; 0 only for an explicit «так»/«yes»; EOF/Ctrl+D = cancel
  local answer
  read -r -p "$1" answer || { printf '\n'; return 1; }
  case "${answer,,}" in так|yes) return 0 ;; *) return 1 ;; esac
}

# Downloads (or takes --node-archive) the pinned official build, verifies its SHA-256, extracts it into a temporary
# root-only directory and renames it into versions/ — complete or absent. Then the link RUNTIME_NODE.
install_runtime() {
  local name="node-v$NODE_VERSION-linux-$arch" tmp
  local target="$RUNTIME_DIR/versions/$name"
  install -d -m 755 -o root -g root "$RUNTIME_DIR" "$RUNTIME_DIR/versions" "$RUNTIME_DIR/bin"
  if [ ! -d "$target" ]; then
    tmp=$(mktemp -d "$RUNTIME_DIR/.download.XXXXXXXX")
    trap 'rm -rf -- "$tmp"; printf "\nСкасовано: runtime не встановлено.\n" >&2; exit 130' INT
    if [ -n "$node_archive" ]; then
      cp -- "$node_archive" "$tmp/$name.tar.gz" || { rm -rf -- "$tmp"; die "не вдалося прочитати $node_archive"; }
    else
      command -v curl >/dev/null 2>&1 || { rm -rf -- "$tmp"; die "не знайдено curl (apt install curl) — або --node-archive <файл>"; }
      echo "  … завантаження https://nodejs.org/dist/v$NODE_VERSION/$name.tar.gz"
      if ! curl --proto '=https' --tlsv1.2 --fail --location --show-error --progress-bar --retry 2 --connect-timeout 20 --max-time 900 \
        -o "$tmp/$name.tar.gz" "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.gz"; then
        rm -rf -- "$tmp"; die "завантаження не вдалося (мережа, DNS, HTTPS-проксі?) — нічого не встановлено. Без мережі: --node-archive <файл>"
      fi
    fi
    if ! printf '%s  %s\n' "$node_sha" "$tmp/$name.tar.gz" | sha256sum --check --status; then
      rm -rf -- "$tmp"; die "SHA-256 архіву Node.js не збігається з зафіксованим у installer/bootstrap/node-runtime.env — архів відкинуто, нічого не встановлено"
    fi
    tar -xzf "$tmp/$name.tar.gz" -C "$tmp" --no-same-owner || { rm -rf -- "$tmp"; die "не вдалося розпакувати архів Node.js"; }
    [ "$(node_version "$tmp/$name/bin/node")" = "$NODE_VERSION" ] || { rm -rf -- "$tmp"; die "розпакований Node.js не запускається на цьому сервері"; }
    chown -R root:root "$tmp/$name"
    chmod -R go-w "$tmp/$name"
    mv -T -- "$tmp/$name" "$target"   # complete or absent: a partial download never becomes the runtime
    rm -rf -- "$tmp"
    trap 'printf "\nСкасовано.\n" >&2; exit 130' INT
  fi
  ln -s "../versions/$name/bin/node" "$RUNTIME_DIR/bin/.node.tmp.$$"
  mv -T -- "$RUNTIME_DIR/bin/.node.tmp.$$" "$RUNTIME_NODE"
  echo "  ✓ Node.js $NODE_VERSION: $target ($RUNTIME_NODE)"
  runtime_installed=1
}

# Trust of an executable BEFORE it is ever run as root — the same rule as installer/src/runtime.ts (executableTrust):
# every symlink hop owned by root; every directory of every hop (canonical, up to /) owned by root and not writable by
# group/other (only a root-owned sticky directory like /tmp may be); the final target a root-owned regular executable
# file without group/other write. Only stat/readlink — nothing is executed. Sets `trusted_path` or `why`.
root_dir_chain() {
  local d=$1
  while :; do
    [ -n "$(find "$d" -maxdepth 0 -type d -user 0 \( \( ! -perm -020 ! -perm -002 \) -o -perm -1000 \) -print 2>/dev/null)" ] \
      || { why="каталог $d не належить root або доступний на запис групі/іншим"; return 1; }
    [ "$d" = / ] && return 0
    d=$(dirname -- "$d")
  done
}
executable_trusted() {
  local p=$1 dir t hop
  trusted_path="" why=""
  for hop in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do
    dir=$(cd -P -- "$(dirname -- "$p")" 2>/dev/null && pwd -P) || { why="каталог $(dirname -- "$p") не існує"; return 1; }
    root_dir_chain "$dir" || return 1
    p="${dir%/}/$(basename -- "$p")"
    if [ -L "$p" ]; then
      [ -n "$(find "$p" -maxdepth 0 -user 0 -print)" ] || { why="посилання $p не належить root"; return 1; }
      t=$(readlink -- "$p")
      case $t in /*) p=$t ;; *) p="${dir%/}/$t" ;; esac
      continue
    fi
    [ -e "$p" ] || { why="$p не існує (посилання нікуди не веде)"; return 1; }
    [ -n "$(find "$p" -maxdepth 0 -type f -user 0 ! -perm -020 ! -perm -002 -perm -100 -print)" ] \
      || { why="$p — не виконуваний файл root або доступний на запис групі/іншим"; return 1; }
    trusted_path=$p
    return 0
  done
  why="$1: забагато посилань"; return 1
}

# npm next to a trusted Node.js ($1 = canonical node, $2 = its version): trusted itself (before it runs) and running on
# exactly that Node.js. Sets `why` otherwise.
npm_usable() {
  local npm reported
  npm="$(dirname -- "$1")/npm"
  [ -e "$npm" ] || [ -L "$npm" ] || { why="немає npm поруч із $1"; return 1; }
  executable_trusted "$npm" || { why="npm поруч із $1 не довірений: $why"; return 1; }
  reported=$(env -i PATH="$(dirname -- "$1"):/usr/bin:/bin" HOME=/root "$npm" version --json 2>/dev/null \
    | sed -n 's/^ *"node": *"\([0-9.]*\)".*/\1/p') || true
  [ -n "$reported" ] || { why="npm поруч із $1 не працює"; return 1; }
  [ "$reported" = "$2" ] || { why="npm поруч із $1 працює на Node.js $reported, а не $2"; return 1; }
}

# Which Node.js runs everything from here on. $1 = 1 when npm is needed (a build, or the API's production
# dependencies). Sets `node` (or `node=""` = the separate runtime must be installed) and `why`. Nothing is executed
# before executable_trusted accepted it; an existing runtime is never switched or replaced here.
select_runtime() {
  local need_npm=${1:-1} v bad real
  node="" why=""
  if [ -e "$RUNTIME_NODE" ] || [ -L "$RUNTIME_NODE" ]; then
    executable_trusted "$RUNTIME_NODE" || die "$RUNTIME_NODE не виконується: $why. Runtime має належати root і бути доступним на запис лише root (разом із каталогами); інсталятор його не запускає й не змінює."
    real=$trusted_path
    case $real in
      "$RUNTIME_DIR"/*)
        bad=$(find "$RUNTIME_DIR" \( ! -user 0 -o \( ! -type l \( -perm -020 -o -perm -002 \) \) \) -print -quit)
        [ -z "$bad" ] || die "$RUNTIME_DIR має належати root без запису для інших (виявлено: $bad) — runtime не використовується" ;;
    esac
    v=$(node_version "$RUNTIME_NODE")
    version_ok "$v" || die "$RUNTIME_NODE — Node.js ${v:-не запускається}, потрібен 22 не старший за $NODE_MIN. Наявний runtime не замінюється автоматично (docs/INSTALLATION.md, «Runtime Node.js»)."
    if [ "$need_npm" = 1 ] && ! npm_usable "$real" "$v"; then
      die "$why: наявний runtime $RUNTIME_NODE неповний для цього сценарію. Інсталятор його не замінює й не перемикає автоматично — оновлення runtime за docs/DEPLOYMENT.md («Runtime Node.js»)."
    fi
    node=$RUNTIME_NODE
    echo "Node.js $v: $RUNTIME_NODE"
    return 0
  fi
  if [ -n "${node_archive:-}" ]; then why="Runtime Node Control ще не встановлено; передано --node-archive."; return 0; fi
  if [ ! -e "$SYSTEM_NODE" ] && [ ! -L "$SYSTEM_NODE" ]; then why="Сумісного Node.js немає: $RUNTIME_NODE відсутній, $SYSTEM_NODE не встановлено."; return 0; fi
  if ! executable_trusted "$SYSTEM_NODE"; then why="Системний $SYSTEM_NODE не використовується (не запускався): $why."; return 0; fi
  real=$trusted_path
  v=$(node_version "$SYSTEM_NODE")
  if ! version_ok "$v"; then
    why="Системний Node.js ${v:-(не запускається)} ($SYSTEM_NODE) не підходить: потрібен 22 не старший за $NODE_MIN (вимога залежностей з package-lock.json)."; return 0
  fi
  if [ "$need_npm" = 1 ] && ! npm_usable "$real" "$v"; then
    why="Системний Node.js $v сумісний, але $why (npm потрібен для збирання й залежностей API; системні Node.js і npm не змінюються)."; return 0
  fi
  node=$SYSTEM_NODE
  echo "Node.js $v у $SYSTEM_NODE сумісний — окремий runtime не завантажується (служби використовуватимуть посилання $RUNTIME_NODE → $SYSTEM_NODE; створює його інсталятор після «так»)."
}

# Sourced (tests): functions only.
[ "${BASH_SOURCE[0]}" = "$0" ] || return 0

umask 022
args=("$@")
release="" component="" node_archive="" runtime_installed=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) read_spec "$spec" || true; usage; exit 0 ;;
    --release) [ $# -ge 2 ] || { echo "✗ --release потребує каталогу" >&2; exit 2; }; release=$2; shift 2 ;;
    --release=*) release=${1#--release=}; shift ;;
    --component) [ $# -ge 2 ] || { echo "✗ --component: server або agent" >&2; exit 2; }; component=$2; shift 2 ;;
    --component=*) component=${1#--component=}; shift ;;
    --node-archive) [ $# -ge 2 ] || { echo "✗ --node-archive потребує файлу" >&2; exit 2; }; node_archive=$2; shift 2 ;;
    --node-archive=*) node_archive=${1#--node-archive=}; shift ;;
    *) printf '✗ невідомий параметр: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$component" in ""|server|agent) ;; *) echo "✗ --component: server або agent" >&2; exit 2 ;; esac
read_spec "$spec" || die "$spec відсутній або пошкоджений — checkout неповний"

if [ ! -t 0 ] || [ ! -t 1 ]; then
  cat >&2 <<EOF
✗ install.sh — інтерактивний майстер і працює лише в терміналі (нічого не змінено).
  Автоматизація: неінтерактивні інсталятори підготовленого релізу — <реліз>/server-bundle/install/server.js | agent.js plan|apply
  (docs/INSTALLATION.md, розділи 2–3).
EOF
  exit 2
fi

trap 'printf "\nСкасовано.\n" >&2; exit 130' INT

# --- root: system steps need it; the build itself never runs as root ---------------------------------------------
if [ "$(id -u)" != 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "потрібні права root, а sudo не знайдено: запустіть ./install.sh від root"
  echo "Потрібні права root (системні каталоги, служби). Перезапуск через sudo; збирання релізу виконуватиметься від вашого користувача $(id -un), не від root."
  # Proxy variables survive sudo's env_reset by NAME only (--preserve-env=<names>): values — possibly with credentials —
  # stay in the environment, never in argv. Nothing else of the user's environment is kept.
  keep=""
  for v in HTTPS_PROXY https_proxy HTTP_PROXY http_proxy NO_PROXY no_proxy; do [ -n "${!v:-}" ] && keep="${keep:+$keep,}$v"; done
  if [ -n "$keep" ]; then exec sudo --preserve-env="$keep" -- "$self" ${args[@]+"${args[@]}"}; fi
  exec sudo -- "$self" ${args[@]+"${args[@]}"}
fi

# --- platform ------------------------------------------------------------------------------------------------------
[ "$(uname -s)" = Linux ] || die "підтримується лише Linux (Ubuntu із systemd)"
os_id=$(sed -n 's/^ID="\{0,1\}\([a-z]*\)"\{0,1\}$/\1/p' /etc/os-release 2>/dev/null || true)
[ "$os_id" = ubuntu ] || die "підтримується лише Ubuntu (виявлено: ${os_id:-невідомо})"
[ -d /run/systemd/system ] || die "systemd не є init-системою (немає /run/systemd/system)"
case "$(uname -m)" in
  x86_64) arch=x64; node_sha=$SHA256_LINUX_X64 ;;
  aarch64|arm64) arch=arm64; node_sha=$SHA256_LINUX_ARM64 ;;
  *) die "архітектура $(uname -m) не підтримується (лише x86_64 і arm64)" ;;
esac
for tool in tar sha256sum find runuser getent; do command -v "$tool" >/dev/null 2>&1 || die "не знайдено системної утиліти $tool"; done

if [ -z "$release" ] && [ -z "$component" ]; then
  echo "Node Control — встановлення. Що встановлюємо на цьому сервері?"
  echo "  1) Central Server — API + веб-інтерфейс (потрібні PostgreSQL і Nginx на цьому сервері)"
  echo "  2) Agent — сервер із PM2-застосунками (лише вихідний HTTPS до Central Server)"
  echo "  0) Скасувати"
  while :; do
    read -r -p "Ваш вибір: " choice || { printf '\nСкасовано. Нічого не змінено.\n'; exit 130; }
    case "$choice" in
      1) component=server; break ;;
      2) component=agent; break ;;
      0) echo "Скасовано. Нічого не змінено."; exit 130 ;;
      *) echo "  введіть 1, 2 або 0" ;;
    esac
  done
fi

trust_init

# --- Node.js runtime -----------------------------------------------------------------------------------------------
# npm is needed for a build (the main route) and for the production dependencies of the API; an Agent installed from a
# prepared release (--release … --component agent, or the component chosen later in the wizard) needs no npm.
need_npm=1
[ -n "$release" ] && [ "$component" != server ] && need_npm=0
select_runtime "$need_npm"
if [ -z "$node" ]; then
  printf '\n%s\n' "$why"
  echo "Буде встановлено окремий runtime Node Control:"
  if [ -n "$node_archive" ]; then echo "  • з архіву $node_archive (без завантаження)"
  else echo "  • Node.js $NODE_VERSION для linux-$arch з https://nodejs.org/dist/ (~30 МБ, HTTPS)"; fi
  echo "  • перевірка SHA-256 за значенням, зафіксованим у репозиторії (installer/bootstrap/node-runtime.env); інший архів відкидається"
  echo "  • у $RUNTIME_DIR/versions/ (root, лише читання для інших) і посилання $RUNTIME_NODE"
  echo "  • системний Node.js, npm, PATH, nvm, профілі shell і PM2 не змінюються"
  ask_yes "Встановити runtime? Введіть «так», щоб продовжити: " || { echo "Скасовано. Нічого не змінено."; exit 130; }
  install_runtime
  node=$RUNTIME_NODE
fi

# --- hand over ------------------------------------------------------------------------------------------------------
if [ -n "$release" ]; then
  if ! release=$(readlink -f -- "$release") || [ ! -f "$release/server-bundle/install/wizard.js" ]; then
    die "$release не є підготовленим релізом (немає server-bundle/install/wizard.js)"
  fi
  # The wizard runs as root from this directory: checked BEFORE any code of the release is executed.
  assert_protected "$release"
  # --use-system-ca: HTTPS checks (Agent → API) trust the system store with any runtime build, like the services.
  exec "$node" --use-system-ca "$release/server-bundle/install/wizard.js" --release "$release" ${component:+--component "$component"}
fi

# Root executes the preparation from this checkout (and git reads its .git as root when root owns it): the same trust
# rules as for a release, for exactly those parts.
[ -f "$checkout/installer/bootstrap/main.js" ] && [ -d "$checkout/.git" ] \
  || die "$checkout не є повним git checkout Node Control (немає installer/bootstrap або .git). Готовий реліз: --release <каталог>"
for part in installer/bootstrap scripts/deploy .git; do assert_protected "$checkout/$part"; done
exec "$node" --use-system-ca "$checkout/installer/bootstrap/main.js" --checkout "$checkout" --component "$component" --launcher "$self" ${runtime_installed:+--runtime-installed}
