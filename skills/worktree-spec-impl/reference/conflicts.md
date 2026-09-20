# Resolución de conflictos al integrar la rama base en la rama del worktree

> La **base** es la rama de la que nació el worktree y en la que aterrizará (`develop`, una rama de tarea, `main`…); consúltala con `node scripts/base.mjs <slug>`. Se integra con `git merge <base>` dentro de la rama de la spec: en ese merge, `ours` es la rama de la spec y `theirs` es la base.

Se aplica en la Fase 5, **dentro del worktree**. Regla general: un conflicto textual se resuelve
conservando la intención de *ambas* ramas, no eligiendo un lado. Si no puedes explicar en una frase
qué quería cada lado, no resuelvas: para y pregunta.

## Por clase de fichero

| Fichero | Resolución |
|---|---|
| Lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`) | **Nunca a mano.** `git checkout --theirs <lockfile>` (la versión de la base), reaplicar los cambios de `package.json` de tu rama y regenerarlo con el gestor del proyecto (`npm install`, `pnpm install`, `yarn install` o `bun install`). Commitear el resultado. |
| `package.json` | Conservar las dependencias de ambas ramas; luego regenerar el lockfile como arriba. |
| Migraciones (el directorio que use el proyecto: `migrations/`, `prisma/migrations/`…) | Nombres distintos → sin conflicto textual, pero **revisar el orden**: el timestamp fija el orden de aplicación. Si tu migración depende de una de la base con timestamp posterior al tuyo, renombra la tuya con la herramienta de creación del proyecto para que genere uno nuevo. Es legítimo porque tu BD de worktree es desechable y tu migración aún no se aplicó en ningún entorno compartido. **Nunca edites una migración que ya viene de la base.** Tu BD de worktree es una foto de la base tomada al crear el worktree, así que **no tiene las migraciones que otras specs hayan integrado en la base después**: tras el merge, ejecuta las nuevas contra la BD del worktree (con el script de migración del proyecto) antes de verificar. |
| `routes.ts` (composition roots) | Casi siempre conflicto de ambas partes: conservar los dos registros de rutas y los dos conjuntos de dependencias construidas. |
| `envs.ts`, `.env.template` | Conservar las variables de ambas ramas. Si la base añadió una variable **requerida**, añadirla también al `.env` local del worktree (está gitignorado y no se actualiza solo). |
| Entidades, servicios, DTOs | Conflicto **semántico**. Leer la spec de la otra rama (`specs/`) antes de decidir. Si ambas cambian la misma invariante o regla de negocio de forma incompatible, parar y presentar al usuario 2–3 opciones concretas. |
| Tests | Conservar los de ambas ramas; si dos tests prueban la misma cosa con expectativas distintas, es un conflicto semántico de la fila anterior. |

## Tras resolver

1. `git add` de cada fichero resuelto, sin `-A` (evita colar `.env` u otros ajenos).
2. Comprobar que no quedan marcadores: `git diff --check` y `grep -rn '^<<<<<<<\|^>>>>>>>' src test`.
3. Un conflicto resuelto que compila puede seguir siendo incorrecto: `node scripts/verify.mjs` (el
   `test`, `lint` y `typecheck` que defina el proyecto) y la comprobación real contra el servidor en el
   puerto asignado.
4. Commit del merge con mensaje que diga qué se resolvió y por qué en los ficheros no triviales.
