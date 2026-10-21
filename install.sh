#!/usr/bin/env bash
# Node Control — launcher of the guided installer (Central Server / Agent).
#
# Minimal on purpose: it finds a PREPARED release (artifacts + server-bundle written by scripts/deploy/build-release.js),
# checks that nobody but root or the user who built it can modify that release, checks Node.js 22, and runs the wizard
# FROM THAT RELEASE (server-bundle/install/wizard.js). Everything else — questions, plan, confirmation, installation —
# is the wizard and the existing installers. Nothing on the system is changed here.
#
# A symlink to this file is resolved to the real checkout: the default release directory is next to the real checkout.
set -euo pipefail

self=$(readlink -f -- "${BASH_SOURCE[0]}")
checkout=$(dirname -- "$self")
releases_dir="$(dirname -- "$checkout")/node-control-releases"
node=/usr/bin/node

usage() {
  cat <<EOF
Node Control — майстер встановлення (Central Server або Agent).

Використання:
  sudo ./install.sh                     реліз — єдиний підготовлений у $releases_dir
  sudo ./install.sh --release <каталог> явно вказаний підготовлений реліз
  ./install.sh --help                   ця довідка (без root, нічого не змінює)
Від root — те саме без sudo.

Реліз готується заздалегідь звичайним користувачем (не root), з чистого запушеного checkout:
  npm ci
  node scripts/deploy/build-release.js --out "$releases_dir/\$(git rev-parse --short HEAD)"
Докладно: docs/INSTALLATION.md.
EOF
}

release=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --release)
      [ $# -ge 2 ] || { echo "✗ --release потребує каталогу" >&2; exit 2; }
      release=$2; shift 2 ;;
    --release=*) release=${1#--release=}; shift ;;
    *) printf '✗ невідомий параметр: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$release" ]; then
  candidates=()
  if [ -d "$releases_dir" ]; then
    for c in "$releases_dir"/*/; do
      [ -f "${c}server-bundle/install/wizard.js" ] && candidates+=("${c%/}")
    done
  fi
  case ${#candidates[@]} in
    0)
      printf '✗ Підготовленого релізу не знайдено в %s.\n\n' "$releases_dir" >&2
      usage >&2
      exit 1 ;;
    1) release=${candidates[0]} ;;
    *)
      echo "Знайдено кілька підготовлених релізів — оберіть явно (майстер не обирає «найновіший» сам):" >&2
      for c in "${candidates[@]}"; do printf '  sudo %q --release %q\n' "$self" "$c" >&2; done
      exit 2 ;;
  esac
fi

if ! release=$(readlink -f -- "$release") || [ ! -f "$release/server-bundle/install/wizard.js" ]; then
  printf '✗ %s не є підготовленим релізом (немає server-bundle/install/wizard.js).\n' "$release" >&2
  exit 1
fi

# The wizard runs as root from this directory: nobody else may be able to change it.
owner_ok=0
[ -n "${SUDO_UID:-}" ] && owner_ok=$SUDO_UID
problem=$(find "$release" \( -type l -o -perm -020 -o -perm -002 -o \( ! -user 0 ! -user "$(id -u)" ! -user "$owner_ok" \) \) -print -quit)
if [ -n "$problem" ]; then
  printf '✗ Реліз не захищений від змін іншими користувачами: %s\n' "$problem" >&2
  echo "  Без symlink, без запису для групи/інших, власник — root або користувач, що зібрав реліз (chown -R / chmod -R go-w)." >&2
  exit 1
fi
dir=$release
while [ "$dir" != "/" ]; do
  dir=$(dirname -- "$dir")
  if [ -n "$(find "$dir" -maxdepth 0 \( -perm -020 -o -perm -002 \) ! -perm -1000 -print)" ]; then
    printf '✗ Каталог %s доступний на запис іншим користувачам — перенесіть реліз у захищений каталог.\n' "$dir" >&2
    exit 1
  fi
done

if [ ! -x "$node" ] || [ "$("$node" -p 'process.versions.node.split(".")[0]')" != "22" ]; then
  echo "✗ Потрібен Node.js 22 у $node (Ubuntu 26.04: apt install nodejs npm)." >&2
  exit 1
fi

exec "$node" "$release/server-bundle/install/wizard.js" --release "$release"
