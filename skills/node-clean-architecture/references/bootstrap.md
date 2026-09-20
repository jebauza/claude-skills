# Arrancar un proyecto nuevo desde cero

## Primer paso: copiar el `CLAUDE.md`

Antes de escribir código, copia el `CLAUDE.md` de un proyecto que ya siga este patrón (por
ejemplo `13-ticket-desk`) al nuevo repo, y reemplaza su "Parte B" (la sección marcada
`## Este proyecto (reemplazar al copiar a otro)`) con los datos del proyecto nuevo: qué es la app,
stack concreto, comandos, entidades y agregados, deuda conocida (empieza vacía). La "Parte A" — la
normativa — se copia tal cual, sin editar.

Esto es lo primero, no lo último: es lo que hace que el proyecto nuevo cumpla la arquitectura desde
el primer commit en vez de converger hacia ella por revisión.

## Dependencias base

```bash
npm init -y
npm i express dotenv env-var helmet express-rate-limit jsonwebtoken bcryptjs uuid
npm i -D typescript @types/node @types/express @types/jsonwebtoken @types/bcryptjs
npm i -D ts-node-dev rimraf eslint @eslint/js typescript-eslint
npm i -D jest ts-jest @types/jest supertest @types/supertest
```

Añadir el driver de la tecnología de persistencia elegida (`pg` + `@types/pg` para Postgres,
`mongodb` para Mongo, nada adicional para una API externa vía `fetch` nativo). Añadir `ws` +
`@types/ws` solo si el proyecto necesita tiempo real.

## `tsconfig.json`

Estricto, sin transigir en estos flags — capturan errores que de otro modo aparecen en producción:

```jsonc
{
  "include": ["src", "test"],
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist/",
    "module": "nodenext",
    "target": "esnext",
    "types": ["node", "jest"],
    "sourceMap": true,
    "declaration": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "strict": true,
    "isolatedModules": true,
    "noUncheckedSideEffectImports": true,
    "moduleDetection": "force",
    "skipLibCheck": true
  }
}
```

`tsconfig.build.json` separado, que excluye `test/`:

```jsonc
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "test"]
}
```

## `package.json` — scripts

```json
{
  "scripts": {
    "dev": "tsnd --respawn src/app.ts",
    "build": "rimraf ./dist && tsc -p tsconfig.build.json",
    "start": "npm run build && node dist/app.js",
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage",
    "lint": "eslint ."
  }
}
```

Si el proyecto usa migraciones SQL versionadas (recomendado sobre `sequelize.sync`/`prisma db push`
en producción), añadir `node-pg-migrate` y los scripts `migrate`/`migrate:down`/`migrate:create`.
Ver `references/db-migrations.md` para la plantilla del composition root y del fichero de migración,
y el porqué de cada decisión.

## `jest.config.js`

Ver `references/testing.md`.

## `eslint.config.js` — regla anti SQL injection desde el primer commit

```js
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

const noDynamicSqlRules = {
  'no-restricted-syntax': [
    'error',
    {
      selector: "CallExpression[callee.property.name='query'] > TemplateLiteral[expressions.length>0]",
      message: 'No interpoles valores en una query SQL. Usa placeholders ($1, $2, ...) y un array de parámetros.',
    },
    {
      selector: "CallExpression[callee.property.name='query'] > BinaryExpression[operator='+']",
      message: 'No concatenes strings para construir una query SQL. Usa placeholders ($1, $2, ...) y un array de parámetros.',
    },
  ],
};

module.exports = tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['src/**/*.ts'], rules: { ...noDynamicSqlRules } },
);
```

Solo aplica si el proyecto usa SQL crudo (`pg`, `mysql2`...). Con un ORM que parametriza siempre
por diseño (Prisma, Drizzle), esta regla no hace falta — pero sigue haciendo falta la Capa 1 de la
sección de seguridad del `SKILL.md`: nunca construir una query con un fragmento SQL crudo
interpolado, ni siquiera "por una vez".

## `config/envs.ts`

```ts
import 'dotenv/config';
import { get } from 'env-var';

export const envs = {
  APP_URL: get('APP_URL').required().asUrlString(),
  APP_PORT: get('APP_PORT').required().asPortNumber(),

  DB_HOST: get('DB_HOST').required().asString(),
  DB_PORT: get('DB_PORT').required().asPortNumber(),
  DB_NAME: get('DB_NAME').required().asString(),
  DB_USER: get('DB_USER').required().asString(),
  DB_PASSWORD: get('DB_PASSWORD').required().asString(),

  JWT_SEED: get('JWT_SEED').required().asString(),
  JWT_EXPIRES_IN: get('JWT_EXPIRES_IN').default('2h').asString(),
};

if (envs.JWT_SEED.length < 32) {
  throw new Error('JWT_SEED must be at least 32 characters long');
}
```

`.env.template` con las mismas claves sin valores reales, para que un colaborador nuevo sepa qué
configurar sin exponer secretos.

## `docker-compose.yml` (si la tecnología de persistencia lo pide)

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: ${DB_NAME}
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    ports:
      - '${DB_PORT}:5432'
    volumes:
      - ./postgres:/var/lib/postgresql/data
```

## `app.ts` mínimo

```ts
import { createServer } from 'http';
import { envs } from './config/envs';
import { ApiRoutes } from './presentation/http/api/routes';
import { Server } from './presentation/http/server';

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  process.exit(1);
});

(async () => {
  const server = new Server({ port: envs.APP_PORT });
  const httpServer = createServer(server.app);

  // Conectar aquí la infraestructura compartida (pool de BD, WebSocket) antes de montar rutas.

  server.setRoutes(ApiRoutes.routes);
  httpServer.listen(envs.APP_PORT, () => {
    console.log(`API listening on ${envs.APP_URL}:${envs.APP_PORT}/api`);
  });
})().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
```

## Primer feature

Sigue el checklist de "Feature nuevo" del `SKILL.md` para el primer agregado del dominio. No
empieces por la capa HTTP — empieza por la entidad.
