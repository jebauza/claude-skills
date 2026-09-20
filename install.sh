#!/usr/bin/env bash
# Enlaza las skills de este repo en ~/.claude/skills/ (o $CLAUDE_CONFIG_DIR/skills).
#
# Uso:
#   ./install.sh                 enlaza en ~/.claude/skills/
#   ./install.sh --link-agents   además reapunta ~/.agents/skills/<name> a este repo,
#                                para las skills que originalmente vivían allí
#   ./install.sh --dry-run       muestra qué haría, sin tocar nada
#
# Es idempotente: un enlace que ya apunta aquí se deja como está.
# Nada se borra nunca — lo que estorba se mueve a un directorio de backup con timestamp.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$REPO_DIR/skills"
CLAUDE_SKILLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
AGENTS_SKILLS="$HOME/.agents/skills"
BACKUP_DIR="$CLAUDE_SKILLS/.backup-$(date +%Y%m%d-%H%M%S)"

# Skills que en la máquina original vivían en ~/.agents/skills y se enlazaban desde ~/.claude/skills.
AGENT_SKILLS=(caveman frontend-design spec spec-impl worktree-spec-impl)

LINK_AGENTS=false
DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --link-agents) LINK_AGENTS=true ;;
    --dry-run)     DRY_RUN=true ;;
    -h|--help)     sed -n '2,10p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Opción desconocida: $arg (usa --help)" >&2; exit 1 ;;
  esac
done

run() {
  if $DRY_RUN; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

# Deja $1 libre para crear un symlink nuevo. Devuelve 1 si ya es el enlace correcto.
prepare_target() {
  local target="$1" want="$2"

  if [[ -L "$target" ]]; then
    if [[ "$(readlink -f "$target")" == "$(readlink -f "$want")" ]]; then
      echo "  = $(basename "$target") (ya enlazada)"
      return 1
    fi
    echo "  ~ $(basename "$target") (enlace a otro destino, se respalda)"
  elif [[ -e "$target" ]]; then
    echo "  ~ $(basename "$target") (directorio real, se respalda)"
  else
    return 0
  fi

  run mkdir -p "$BACKUP_DIR"
  run mv "$target" "$BACKUP_DIR/"
  return 0
}

echo "Repo:    $REPO_DIR"
echo "Destino: $CLAUDE_SKILLS"
$DRY_RUN && echo "(dry-run: no se modifica nada)"
echo

run mkdir -p "$CLAUDE_SKILLS"

for src in "$SKILLS_SRC"/*/; do
  src="${src%/}"
  name="$(basename "$src")"
  target="$CLAUDE_SKILLS/$name"

  if prepare_target "$target" "$src"; then
    run ln -s "$src" "$target"
    echo "  + $name"
  fi
done

if $LINK_AGENTS; then
  echo
  echo "Reapuntando $AGENTS_SKILLS a este repo:"
  for name in "${AGENT_SKILLS[@]}"; do
    src="$SKILLS_SRC/$name"
    target="$AGENTS_SKILLS/$name"
    [[ -d "$src" ]] || continue
    if [[ -d "$AGENTS_SKILLS" ]] && prepare_target "$target" "$src"; then
      run ln -s "$src" "$target"
      echo "  + $name"
    fi
  done
fi

echo
if [[ -d "$BACKUP_DIR" ]]; then
  echo "Backup de lo que había antes: $BACKUP_DIR"
fi
echo "Listo. Reinicia la sesión de Claude Code para que reindexe las skills."
