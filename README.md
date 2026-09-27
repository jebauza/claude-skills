# claude-skills

Mis skills de Claude Code, versionadas para usarlas en cualquier máquina.

El repo es el almacén de mis skills. `install.sh` **copia** cada skill de `skills/` a
`~/.claude/skills/` solo si todavía no existe allí. No crea symlinks.

## Instalar en una máquina nueva

```bash
git clone <url-del-repo> ~/claude-skills
cd ~/claude-skills
./install.sh
```

Reinicia la sesión de Claude Code para que reindexe las skills.

Opción:

```bash
./install.sh --dry-run   # muestra qué haría, sin tocar nada
```

`install.sh` es idempotente y **nunca sobrescribe ni borra**: si una skill ya existe en el destino,
la omite.

## Actualizar

Las copias en `~/.claude/skills/` son independientes del repo. Para llevar una skill actualizada
del repo a una máquina donde ya está instalada, hay que reemplazarla a mano (borrar la carpeta
en `~/.claude/skills/` y volver a ejecutar `./install.sh`).

## Añadir una skill

1. `mkdir skills/<nombre>` con su `SKILL.md` (frontmatter `name` + `description`).
2. `./install.sh` para instalarla.
3. Commit y push.

## Qué hay aquí

| Skill | Origen |
|---|---|
| `node-clean-architecture` | Propia. Arquitectura por capas para backends Node (TS y JS), con plantillas, bootstrap, migración de legacy y migraciones de esquema |
| `caveman` | Terceros |
| `frontend-design` | Terceros (ver `LICENSE.txt`) |
| `spec` | Terceros |
| `spec-impl` | Terceros |
| `worktree-spec-impl` | Terceros |

Las de terceros se versionan aquí para no depender de la herramienta que las instaló en su día. La
contrapartida es que son **copias**: si el proyecto original publica cambios, no llegan solos.

## Statusline y hooks

`dotfiles/` versiona el statusline (ruta + rama + modelo + %contexto) y el hook `SessionStart`
que inyecta el estado git real. Ver `dotfiles/README.md` para instalarlos en máquina nueva.

## Skills NO incluidas

Las `peon-ping-*` (`peon-ping-config`, `peon-ping-log`, `peon-ping-toggle`, `peon-ping-use`) se
quedan fuera a propósito: no son autónomas, invocan
`~/.claude/hooks/peon-ping/peon.sh`. Versionar la skill sin el hook copiaría un puntero a un script
inexistente, y las cuatro fallarían en el primer uso. Para tenerlas en otra máquina hay que instalar
el plugin peon-ping allí, no clonar este repo.
