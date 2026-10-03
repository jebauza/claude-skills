#!/usr/bin/env bash
# Claude Code statusline, two lines:
#   → <dir>
#   ⎇ <branch> [✗] │ <model>  <effort icon> <effort> │ ctx [<bar>] <pct>%
#
# Each section uses a single color; only the ctx section changes color
# (green < 60%, amber < 85%, red >= 85%). Uses the 256-color palette.
# Parses the stdin JSON with node (no jq needed, works in Git Bash on Windows).
input=$(cat)

# Unit separator keeps empty fields from collapsing.
IFS=$'\x1f' read -r cwd project_dir model effort used_pct <<< "$(node -e '
let d="";
process.stdin.on("data", c => d += c);
process.stdin.on("end", () => {
  let j;
  try { j = JSON.parse(d); } catch { j = {}; }
  const ws = j.workspace || {};
  const cwd = ws.current_dir || j.cwd || "";
  const model = (j.model && j.model.display_name) || "Claude";
  const effort = (j.effort && j.effort.level) || "";
  const pct = j.context_window && j.context_window.used_percentage;
  const pctInt = pct !== undefined && pct !== null ? String(Math.round(pct)) : "";
  process.stdout.write([cwd, ws.project_dir || "", model, effort, pctInt].join("\x1f"));
});
' <<< "$input")"

[ -z "$cwd" ] && cwd="$PWD"

fg() { printf '\033[38;5;%sm' "$1"; }
RESET=$'\033[0m'
BOLD=$'\033[1m'
DIM=$'\033[2m'

C_GIT=$(fg 116)
C_DIRTY="${BOLD}$(fg 208)"
C_MODEL=$(fg 75)
C_SEP=$(fg 240)
C_EMPTY=$(fg 238)
C_OK=$(fg 78)
C_WARN=$(fg 214)
C_CRIT=$(fg 203)

SEP=" ${C_SEP}│${RESET} "

# Directory: full path
dir_name="${project_dir:-$cwd}"

# Git section (single call to git status)
git_section=""
status=$(git -C "$cwd" --no-optional-locks status --porcelain=v2 --branch 2>/dev/null)
if [ -n "$status" ]; then
  branch=$(printf '%s\n' "$status" | sed -n 's/^# branch\.head //p')
  if [ "$branch" = "(detached)" ] || [ -z "$branch" ]; then
    branch=$(git -C "$cwd" --no-optional-locks rev-parse --short HEAD 2>/dev/null)
  fi
  dirty=""
  printf '%s\n' "$status" | grep -qv '^#' && dirty=" ${C_DIRTY}✗${RESET}"
  [ -n "$branch" ] && git_section="${BOLD}${C_GIT}⎇ ${branch}${RESET}${dirty}"
fi

# Model + effort section
model_section="${BOLD}${C_MODEL}${model}"
if [ -n "$effort" ]; then
  case "$effort" in
    low)    icon="◔" ;;
    medium) icon="◑" ;;
    high)   icon="◕" ;;
    xhigh)  icon="●" ;;
    max)    icon="◉" ;;
    *)      icon="◑" ;;
  esac
  model_section="${model_section}  ${icon} ${effort}"
fi
model_section="${model_section}${RESET}"

# Context section
ctx_section=""
if [ -n "$used_pct" ]; then
  ctx_pct=$used_pct
  [ "$ctx_pct" -gt 100 ] && ctx_pct=100
  if [ "$ctx_pct" -ge 85 ]; then
    color=$C_CRIT
  elif [ "$ctx_pct" -ge 60 ]; then
    color=$C_WARN
  else
    color=$C_OK
  fi
  filled=$(( (ctx_pct * 10 + 50) / 100 ))
  [ "$ctx_pct" -gt 0 ] && [ "$filled" -eq 0 ] && filled=1
  bar_on=""; bar_off=""
  for ((i = 0; i < filled; i++)); do bar_on+="▓"; done
  for ((i = filled; i < 10; i++)); do bar_off+="░"; done
  ctx_section="${BOLD}${color}ctx [${bar_on}${RESET}${C_EMPTY}${bar_off}${RESET}${BOLD}${color}] ${ctx_pct}%${RESET}"
fi

# Join non-empty sections with the separator
line2=""
for section in "$git_section" "$model_section" "$ctx_section"; do
  [ -z "$section" ] && continue
  if [ -z "$line2" ]; then line2="$section"; else line2="${line2}${SEP}${section}"; fi
done

printf '%s\n%s' "${DIM}→${RESET} ${BOLD}${dir_name}${RESET}" "$line2"
