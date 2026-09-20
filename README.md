# claude-skills

Mis skills de Claude Code, versionadas para usarlas en cualquier máquina.

El repo es la **única fuente de verdad**: `install.sh` no copia nada, crea symlinks desde
`~/.claude/skills/` hacia `skills/` de este repo. Editar una skill desde cualquier máquina es
editar el fichero que git versiona — no hay copias que se desincronicen.

## Instalar en una máquina nueva

```bash
git clone <url-del-repo> ~/claude-skills
cd ~/claude-skills
./install.sh
```

Reinicia la sesión de Claude Code para que reindexe las skills.

Opciones:

```bash
./install.sh --dry-run       # muestra qué haría, sin tocar nada
./install.sh --link-agents   # además reapunta ~/.agents/skills/ a este repo (ver abajo)
```

`install.sh` es idempotente y **nunca borra**: si en el destino ya hay una skill (directorio real o
symlink a otro sitio), la mueve a `~/.claude/skills/.backup-<timestamp>/` antes de crear el enlace.

## Actualizar

```bash
cd ~/claude-skills && git pull
```

Como son symlinks, el `pull` actualiza las skills en todos los proyectos de esa máquina a la vez.
No hace falta reinstalar salvo que se haya añadido una skill nueva (entonces, `./install.sh` otra
vez para enlazar la nueva).

## Añadir una skill

1. `mkdir skills/<nombre>` con su `SKILL.md` (frontmatter `name` + `description`).
2. `./install.sh` para enlazarla.
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

## Nota sobre `~/.agents/skills/`

En la máquina original, las cinco skills de terceros vivían en `~/.agents/skills/` y
`~/.claude/skills/` solo tenía symlinks hacia allí. Al instalar este repo, `~/.claude/skills/` pasa
a apuntar aquí, y esas copias de `~/.agents/skills/` quedan como originales huérfanos que pueden
divergir.

Si quieres una sola fuente de verdad también para la otra herramienta, usa `--link-agents`: reapunta
`~/.agents/skills/<name>` a este repo (respaldando antes lo que hubiera).

## Skills NO incluidas

Las `peon-ping-*` (`peon-ping-config`, `peon-ping-log`, `peon-ping-toggle`, `peon-ping-use`) se
quedan fuera a propósito: no son autónomas, invocan
`~/.claude/hooks/peon-ping/peon.sh`. Versionar la skill sin el hook copiaría un puntero a un script
inexistente, y las cuatro fallarían en el primer uso. Para tenerlas en otra máquina hay que instalar
el plugin peon-ping allí, no clonar este repo.
