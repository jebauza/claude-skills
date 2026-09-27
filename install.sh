#!/usr/bin/env bash
# Copia las skills de este repo en ~/.claude/skills/ (o $CLAUDE_CONFIG_DIR/skills).
#
# Uso:
#   ./install.sh             instala solo las skills que no existen en el destino
#   ./install.sh --dry-run   muestra qué haría, sin tocar nada
#
# Es idempotente: si una skill ya existe en el destino (directorio, copia o enlace),
# se deja intacta. Nunca se sobrescribe ni se borra nada.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$REPO_DIR/skills"
CLAUDE_SKILLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=true ;;
    -h|--help)  sed -n '2,8p' "${BASH_SOURCE[0]}"; exit 0 ;;
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

echo "Repo:    $REPO_DIR"
echo "Destino: $CLAUDE_SKILLS"
$DRY_RUN && echo "(dry-run: no se modifica nada)"
echo

run mkdir -p "$CLAUDE_SKILLS"

installed=0
for src in "$SKILLS_SRC"/*/; do
  src="${src%/}"
  name="$(basename "$src")"
  target="$CLAUDE_SKILLS/$name"

  if [[ -e "$target" || -L "$target" ]]; then
    echo "  = $name (ya existe, se omite)"
    continue
  fi

  run cp -r "$src" "$target"
  echo "  + $name"
  installed=$((installed + 1))
done

echo
echo "Skills instaladas: $installed"
echo "Listo. Reinicia la sesión de Claude Code para que reindexe las skills."
