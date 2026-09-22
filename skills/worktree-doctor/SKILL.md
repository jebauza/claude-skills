---
name: worktree-doctor
description: Read-only diagnostic to run once on a new machine or project, before /worktree-spec-impl. Reports what will work and what will not (node/git versions, package manager, .trees/ ignored, database reachability and CREATEDB permission, detected port and database variables, hardlink support, Windows long paths) without creating anything permanent.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/../worktree-spec-impl/scripts/doctor.mjs:*)
---

# /worktree-doctor — Check a machine and project before creating worktrees

`/worktree-spec-impl` provisions ports, databases and dependencies per worktree. If something it needs is missing, you would otherwise find out halfway through a bootstrap, with the worktree already created. This command turns that into a readable report first.

It is **read-only in effect**: it probes hardlink support by creating and immediately deleting a temporary file under `.trees/`, and leaves nothing behind. It never creates a database, a worktree or a branch.

## Instructions

Run it from the project (any checkout of the repository):

```
node ${CLAUDE_SKILL_DIR}/../worktree-spec-impl/scripts/doctor.mjs
```

Show the user the report as it is printed. Each line is `✓` (fine), `⚠` (works, with a caveat) or `✗` (blocks the skill). It exits non-zero only when there is at least one `✗`.

Then explain, in one or two sentences each, only the `⚠` and `✗` lines, with the concrete fix. The usual ones:

| Line | Fix |
|---|---|
| `.trees/ NO está en .gitignore` | Add `.trees/` to `.gitignore`. A worktree directory must never be committed into the primary checkout. |
| `no existe ".env"` (or whatever `envFile` is configured to) | The project uses a different name (`.env.local`, `app.env`…). Either add `"envFile": "<name>"` to `.claude/worktree.json` yourself, or just run `/worktree-spec-impl`: it will ask you for the real name and save it there. Without this, port and database detection silently read nothing and the worktree ends up sharing the primary checkout's. |
| `rama base por defecto: "<rama>"` | Informational. It is the branch active in the primary checkout, the one `/worktree-spec-impl` creates worktrees from and lands them on. Use `--base <branch>` to pick another local branch. |
| `HEAD desacoplado en el checkout principal` | There is no active branch to use as the base. Either `git switch <branch>` or always pass `--base <branch>`. |
| `el repo no tiene commits` | Make an initial commit: a worktree needs a commit to branch from. |
| `cambios sin commitear` | Informational: uncommitted changes in the primary checkout do **not** reach the worktree. Commit what the worktree needs before creating it. |
| `el usuario NO tiene CREATEDB` | Grant it (`ALTER ROLE <user> CREATEDB`) or use a user that has it; otherwise no per-worktree database can be created. |
| `tiene N conexión(es) abierta(s)` | Not an error. While something is connected to the base database (e.g. `npm run dev` in the primary checkout) Postgres cannot clone it by TEMPLATE, so it is copied with `pg_dump \| psql` instead (a consistent snapshot, nobody is disconnected). Slower, same result. |
| `falta pg_dump y psql en el PATH` | With the base in use, the bootstrap will **fail** (it never creates an empty database). Install the PostgreSQL client (same major version as the server or newer), or point to its folder with `"db": {"pgBin": "<folder>"}` in `.claude/worktree.json`. |
| `pg_dump … es más antiguo que el servidor` | `pg_dump` refuses to dump a newer server. Install the client of the server's major version or newer. |
| `la BD es REMOTA` | Not an error. `/worktree-spec-impl` will ask the user before cloning, because it copies real data into another database on that server. |
| `BD detectada … pero sin motor deducible` | The `.env` declares a database but no known driver (`pg`, `mysql2`, `mongodb`, `better-sqlite3`) is a dependency. Set `"db": {"engine": "pg\|mysql\|mongo\|sqlite"}` or `"db": {"skip": true}`. |
| `el fichero base no existe` (SQLite) | There is nothing to copy; the bootstrap will fail. |
| `el driver … no está instalado` | The project uses a database whose driver is not installed, so the skill cannot connect and **the bootstrap will fail** rather than share the base database. Install it, or set `"db": {"skip": true}` in `.claude/worktree.json` to skip provisioning. |
| `no se detectó variable de puerto` | Two servers at once would collide. Set `"portVars": ["<NAME>"]` in `.claude/worktree.json`. |
| `core.longpaths desactivado` (Windows) | `git config --global core.longpaths true`. Paths over 260 characters fail otherwise, and `node_modules` gets deep. |
| `el volumen no admite hardlinks` | Not an error: each worktree will install with the package manager (slower, more disk). |

If everything is `✓`, say the machine is ready and the user can run `/worktree-spec-impl <spec>`.

Do not fix anything on your own: this command diagnoses, the user decides.
