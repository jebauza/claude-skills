#!/usr/bin/env bash
# SessionStart hook: inyecta el estado real de git al arrancar / clear / resume / compact.
# Reemplaza el bloque gitStatus del prompt, que es un snapshot del inicio de sesión y queda
# obsoleto si se cambia de rama a mitad de sesión.
input=$(cat)

cwd=$(node -e '
let d="";
process.stdin.on("data", c => d += c);
process.stdin.on("end", () => {
  let j; try { j = JSON.parse(d); } catch { j = {}; }
  process.stdout.write((j.workspace && j.workspace.current_dir) || j.cwd || "");
});
' <<< "$input")

[ -z "$cwd" ] && cwd="$PWD"

git -C "$cwd" --no-optional-locks rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

branch=$(git -C "$cwd" --no-optional-locks branch --show-current 2>/dev/null)
[ -z "$branch" ] && branch=$(git -C "$cwd" --no-optional-locks rev-parse --short HEAD 2>/dev/null)
status=$(git -C "$cwd" --no-optional-locks status --short 2>/dev/null | head -20)

echo "LIVE git state (recalculado ahora; ignora el bloque gitStatus del prompt si difiere):"
echo "Current branch: $branch"
echo "Status:"
if [ -n "$status" ]; then echo "$status"; else echo "(clean)"; fi
echo "Recent commits:"
git -C "$cwd" --no-optional-locks log --oneline -5 2>/dev/null
