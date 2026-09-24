#!/usr/bin/env bash
# Claude Code statusline: línea 1 = ruta completa; línea 2 = (branch [x if dirty]) | Model [effort] | ctx:NN%
input=$(cat)

IFS=$'\t' read -r cwd model effort used_pct <<< "$(node -e '
let d="";
process.stdin.on("data", c => d += c);
process.stdin.on("end", () => {
  let j;
  try { j = JSON.parse(d); } catch { j = {}; }
  const cwd = (j.workspace && j.workspace.current_dir) || j.cwd || "";
  const model = (j.model && j.model.display_name) || "Claude";
  const effort = (j.effort && j.effort.level) || "";
  const pct = (j.context_window && j.context_window.used_percentage);
  process.stdout.write([cwd, model, effort, pct !== undefined && pct !== null ? pct : ""].join("\t"));
});
' <<< "$input")"

[ -z "$cwd" ] && cwd="$PWD"

branch=""
dirty=""
if git -C "$cwd" --no-optional-locks rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch=$(git -C "$cwd" --no-optional-locks branch --show-current 2>/dev/null)
  [ -z "$branch" ] && branch=$(git -C "$cwd" --no-optional-locks rev-parse --short HEAD 2>/dev/null)
  [ -n "$(git -C "$cwd" --no-optional-locks status --porcelain 2>/dev/null)" ] && dirty="1"
fi

RESET="\033[0m"
BOLD="\033[1m"
CYAN="\033[1;36m"
GREEN="\033[1;32m"
RED="\033[1;31m"
YELLOW="\033[1;33m"
MAGENTA="\033[1;35m"
BLUE="\033[1;34m"
WHITE="\033[1;37m"

line1=$(printf "${CYAN}%s${RESET}" "$cwd")

line2=""
if [ -n "$branch" ]; then
  line2="$(printf "${GREEN}(%s)${RESET}" "$branch")"
  [ -n "$dirty" ] && line2="${line2}$(printf " ${RED}\xE2\x9C\x97${RESET}")"
fi
[ -n "$line2" ] && line2="${line2}$(printf " ${WHITE}|${RESET} ")"
line2="${line2}$(printf "${YELLOW}%s${RESET}" "$model")"
[ -n "$effort" ] && line2="${line2}$(printf " ${MAGENTA}[%s]${RESET}" "$effort")"
if [ -n "$used_pct" ]; then
  pct_int=$(printf '%.0f' "$used_pct")
  line2="${line2}$(printf " ${WHITE}|${RESET} ${BLUE}ctx:%s%%${RESET}" "$pct_int")"
fi

printf "%s\n%s" "$line1" "$line2"
