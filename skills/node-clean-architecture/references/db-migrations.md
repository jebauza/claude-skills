# Migraciones de esquema

Las reglas normativas (dónde viven, nomenclatura, inmutabilidad, migración ≠ seed) están en la
sección "Migraciones de esquema" del `CLAUDE.md` de cada proyecto. Aquí el porqué y las plantillas.

## Por qué SQL versionado y no `sync()`/`db push`

Un ORM que aplica el esquema en caliente (`sequelize.sync()`, `prisma db push`) es cómodo en
desarrollo y peligroso en cualquier entorno compartido: no hay historial de qué cambió y cuándo, no
pasa por revisión de PR como el resto del código, y no tiene camino de vuelta atrás — si el cambio
rompe algo, no hay un `down` que ejecutar. Una migración versionada en un fichero por cambio da las
tres cosas: reproducibilidad entre entornos (todos aplican la misma secuencia, en el mismo orden),
revisión en PR igual que cualquier otro cambio, y rollback explícito.

## Por qué el runner vive en `presentation/cli/`

Mismo argumento que para un seed: ejecutar migraciones es otro canal de entrada al sistema, tan
legítimo como HTTP, y como tal necesita su propio composition root. Si el runner viviera como script
suelto en la raíz del proyecto, tendría que reconstruir la configuración de conexión por su cuenta —
en la práctica, casi siempre divergiendo de `config/envs.ts` con el tiempo. Poniéndolo en
`presentation/cli/migrate.command.ts` y haciéndolo leer las mismas `envs` validadas que usa la app,
la configuración de BD tiene una sola fuente de verdad.

## Plantilla de migración (`.sql` con `-- Up` / `-- Down`)

Tomada de `13-ticket-desk` (`1700000003000_create-tickets.sql`), que ya resuelve el caso con índices
parciales:

```sql
-- Up Migration
CREATE TABLE IF NOT EXISTS "tickets" (
  "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
  "number"          INTEGER NOT NULL,
  "create_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "handle_at_desk"  TEXT,
  "handle_at"       TIMESTAMPTZ,
  "done"            BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "PK_tickets_id" PRIMARY KEY ("id")
);

-- Acelera getPending() (WHERE handle_at_desk IS NULL ORDER BY number).
CREATE INDEX "IDX_tickets_number" ON "tickets" ("number")
  WHERE "handle_at_desk" IS NULL;

-- Acelera getWorkingOn() y getCurrentByDesk().
CREATE INDEX "IDX_tickets_handle_at_desk_handle_at" ON "tickets" ("handle_at_desk", "handle_at" DESC)
  WHERE "handle_at_desk" IS NOT NULL;

-- Down Migration
DROP INDEX "IDX_tickets_handle_at_desk_handle_at";
DROP INDEX "IDX_tickets_number";
DROP TABLE "tickets";
```

Cada índice lleva un comentario de una línea con la query que acelera — sin eso, un índice
"huérfano" es indistinguible de uno que ya no hace falta, y nadie se atreve a borrarlo.

## Plantilla del composition root (`migrate.command.ts`)

```ts
import path from 'path';
import { runner } from 'node-pg-migrate';
import { envs } from '../../config/envs';

// Composition root de las migraciones: usan las mismas credenciales validadas
// por envs.ts (DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD) en vez de un
// DATABASE_URL separado que podría desincronizarse de la config real.
//
// Uso: ts-node src/presentation/cli/migrate.command.ts up | down
(async () => {
  await main();
})().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});

async function main() {
  const direction = parseDirection(process.argv[2]);

  await runner({
    direction,
    databaseUrl: {
      host: envs.DB_HOST,
      port: envs.DB_PORT,
      database: envs.DB_NAME,
      user: envs.DB_USER,
      password: envs.DB_PASSWORD,
    },
    dir: path.join(__dirname, '../../infrastructure/data/postgres/migrations'),
    migrationsTable: 'pgmigrations',
    // Cada migración es un archivo .sql con secciones "-- Up" / "-- Down",
    // así el esquema se define en SQL puro y no en la API programática.
    // count: undefined => aplica/revierte todas las pendientes en 'up',
    // pero solo la última en 'down' (comportamiento por defecto de la lib).
    count: direction === 'down' ? 1 : Infinity,
  });

  console.log(`Migrations (${direction}) finished`);
  process.exit(0);
}

function parseDirection(arg: string | undefined): 'up' | 'down' {
  if (arg !== 'up' && arg !== 'down') {
    throw new Error(`Usage: migrate.command.ts <up|down>, got "${arg}"`);
  }
  return arg;
}
```

Dos decisiones que vale la pena entender antes de copiarlas:

- **Credenciales desde `envs.ts`, no un `DATABASE_URL` suelto**: si el runner tuviera su propia
  variable de entorno para la conexión, un cambio de credenciales en producción podría actualizar
  una y olvidar la otra — el runner fallaría (o peor, apuntaría a la BD equivocada) sin que nada lo
  avise en el resto de la app.
- **`count: direction === 'down' ? 1 : Infinity`**: subir aplica todo lo pendiente (se espera llegar
  al último estado conocido); bajar revierte solo un paso por invocación, porque deshacer varias
  migraciones de un tirón sin mirar cada una es la manera más rápida de perder datos por accidente.

## Equivalentes por tecnología

- **Mongo**: no hay esquema que migrar en el sentido de Postgres (colecciones sin schema fijo), pero
  sí hace falta versionar **migraciones de datos** (reshape de documentos existentes) e **índices**
  (`createIndex` con nombre explícito, igual razonamiento que arriba). El mismo composition root en
  `presentation/cli/` sirve, cambiando el runner por un script que itera con el driver de Mongo.
- **API externa**: no aplica — el esquema lo posee el servicio remoto.

## JavaScript plano

El runner y el fichero de migración no cambian de forma — es SQL y una función `main()`, ninguno de
los dos necesita tipos. Solo cambia la extensión del composition root
(`migrate.command.js`) y, si el proyecto no usa `ts-node`, el comando de `package.json` que lo
invoca (`node` en vez de `ts-node`).

## Errores caros ya detectados

- **Editar una migración ya aplicada** en vez de crear una nueva: dos entornos que corrieron la
  migración en momentos distintos terminan con esquemas distintos sin que nada lo detecte, hasta que
  una query falla en producción por una columna que "debería" existir.
- **`-- Down` que no revierte los índices**, solo la tabla: al revertir y volver a aplicar, Postgres
  se queja de que el índice ya existe (o, peor, queda un índice huérfano apuntando a una tabla que ya
  no es la misma).
- **Olvidar el índice que sostiene una query concreta del datasource**: el síntoma no aparece en la
  migración, aparece semanas después como un `getPending()` lento en producción. La disciplina del
  comentario por índice (ver plantilla arriba) es la que evita este caso — obliga a preguntarse, al
  escribir la migración, qué query la necesita.
