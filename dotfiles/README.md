# dotfiles

Statusline + hook de contexto git, versionados aquí para replicar el prompt de Claude Code en
otra máquina (línea 1: ruta; línea 2: `(rama) [✗ si dirty] | Modelo [effort] | ctx:NN%`).

## Instalar en máquina nueva

```bash
mkdir -p ~/.claude/hooks
cp dotfiles/statusline-command.sh ~/.claude/statusline-command.sh
cp dotfiles/hooks/git-context.sh ~/.claude/hooks/git-context.sh
chmod +x ~/.claude/statusline-command.sh ~/.claude/hooks/git-context.sh
```

Requiere `node` en PATH (los scripts parsean el JSON de stdin con `node -e`).

Luego añadir en `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash C:/Users/<usuario>/.claude/statusline-command.sh"
  },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "bash C:/Users/<usuario>/.claude/hooks/git-context.sh"
          }
        ]
      }
    ]
  }
}
```

Ajustar la ruta `C:/Users/<usuario>/...` al home de la máquina destino (en Linux/macOS,
`~/.claude/...` sin la letra de unidad). Reiniciar la sesión de Claude Code para que tome el
statusline nuevo.

## Qué hace cada uno

- `statusline-command.sh`: statusline. Lee `cwd`, `model.display_name`, `effort.level` y
  `context_window.used_percentage` del JSON que Claude Code pasa por stdin; añade rama git y
  marca `✗` si el working tree está sucio.
- `hooks/git-context.sh`: hook `SessionStart`. Inyecta el estado real de git (rama, status,
  últimos 5 commits) al arrancar/resume/clear/compact, para que no quede obsoleto el snapshot
  del prompt si se cambia de rama a mitad de sesión.
