# Tests unitarios: configuración y ejemplos por capa

Stack: **Jest + ts-jest**, más **supertest** para la capa HTTP. Sin base de datos — la suite corre
en CI sin infraestructura.

## Montaje

```bash
npm i -D jest ts-jest @types/jest supertest @types/supertest
```

`jest.config.js`:

```js
/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  clearMocks: true,
};
```

En `tsconfig.json`, la línea `"types": ["node", /* "jest" */]` se descomenta a `"types": ["node",
"jest"]`. En `tsconfig.build.json`, excluir `test/**` para que no acabe en `dist/`.

Scripts en `package.json`:

```json
"test": "jest",
"test:watch": "jest --watch",
"test:coverage": "jest --coverage"
```

`coverage/` va al `.gitignore`.

## Por qué no hace falta un framework de mocking

Cada puerto (`domain/repositories/`, `domain/datasources/`, `domain/interfaces/`) es una clase
abstracta o interface pensada para tener múltiples implementaciones — eso es exactamente lo que
hace falta para un doble de test. Un repositorio falso:

```ts
// test/helpers/fakes.ts
import { TicketEntity } from '../../src/domain/entities/ticket.entity';
import { TicketRepository } from '../../src/domain/repositories/ticket.repository';

export class FakeTicketRepository extends TicketRepository {
  private tickets: TicketEntity[] = [];

  async findOne(id: string) {
    return this.tickets.find((t) => t.id === id) ?? null;
  }
  async getAll() {
    return this.tickets;
  }
  async create(id: string) {
    const ticket = TicketEntity.create({ id, number: this.tickets.length + 1 });
    this.tickets.push(ticket);
    return ticket;
  }
  // Helper de test, no del puerto: sembrar estado sin pasar por create().
  seed(tickets: TicketEntity[]) {
    this.tickets = tickets;
  }
}
```

Tipado real: si el puerto `TicketRepository` cambia de firma, el compilador rompe este fake — no
queda una implementación mintiendo en silencio. Interfaces técnicas se satisfacen con un objeto
literal:

```ts
export const fixedIdManager: IdManager = {
  generate: () => 'fixed-id',
  isValid: () => true,
};
```

**Si un test necesita `jest.mock()` de un módulo, casi siempre es señal de que falta una
inyección** — la clase está construyendo su propia dependencia en vez de recibirla por
constructor. La solución es inyectarla, no añadir más mocking.

## Ejemplos por capa

### Entidad

```ts
// test/domain/entities/user.entity.test.ts
import { UserEntity } from '../../../src/domain/entities/user.entity';

describe('UserEntity.create', () => {
  const validProps = { id: '1', name: 'Ana', email: 'ANA@Test.com', password: 'secret123' };

  it('normaliza el email a minúsculas', () => {
    const user = UserEntity.create(validProps);
    expect(user.email).toBe('ana@test.com');
  });

  it('rechaza un email inválido', () => {
    expect(() => UserEntity.create({ ...validProps, email: 'not-an-email' })).toThrow();
  });

  it('rechaza si falta un campo requerido', () => {
    expect(() => UserEntity.create({ ...validProps, name: '' })).toThrow('name is required');
  });
});
```

### DTO de request

```ts
// test/domain/dtos/create-user.dto.test.ts
import { CreateUserDto } from '../../../src/domain/dtos/users/request/create-user.dto';

describe('CreateUserDto.create', () => {
  it('devuelve error si falta el email', () => {
    const [error, dto] = CreateUserDto.create({ name: 'Ana', password: 'secret123' });
    expect(error).toBe('Missing email');
    expect(dto).toBeUndefined();
  });

  it('devuelve el DTO en el caso feliz', () => {
    const [error, dto] = CreateUserDto.create({
      name: 'Ana', email: 'ana@test.com', password: 'secret123',
    });
    expect(error).toBeUndefined();
    expect(dto?.email).toBe('ana@test.com');
  });
});
```

### Servicio, con repositorio falso — el caso de alto valor: anti-enumeración

```ts
// test/domain/services/auth.service.test.ts
import { AuthService } from '../../../src/domain/services/auth.service';
import { CustomError } from '../../../src/domain/errors/custom.error';
import { FakeUserRepository } from '../../helpers/fakes';

describe('AuthService.login', () => {
  it('da el mismo error si el email no existe o si la password falla', async () => {
    const repository = new FakeUserRepository();
    const service = new AuthService(repository, fixedIdManager, fakeHasher, fakeTokenManager);

    let errorForMissingEmail: CustomError | undefined;
    try {
      await service.login({ email: 'nadie@test.com', password: 'x' });
    } catch (e) {
      errorForMissingEmail = e as CustomError;
    }

    repository.seed([validUser]);
    let errorForWrongPassword: CustomError | undefined;
    try {
      await service.login({ email: validUser.email, password: 'wrong' });
    } catch (e) {
      errorForWrongPassword = e as CustomError;
    }

    expect(errorForMissingEmail?.statusCode).toBe(errorForWrongPassword?.statusCode);
    expect(errorForMissingEmail?.message).toBe(errorForWrongPassword?.message);
  });
});
```

### Repository impl, con datasource falso — invalidación de caché

```ts
// test/infrastructure/repositories/ticket.repository.impl.test.ts
import { TicketRepositoryImpl } from '../../../src/infrastructure/repositories/tickets/ticket.repository.impl';
import { TicketDatasource } from '../../../src/domain/datasources/ticket.datasource';

class FakeDatasource extends TicketDatasource {
  getAllCalls = 0;
  async getAll() { this.getAllCalls++; return []; }
  async create(id: string) { return TicketEntity.create({ id, number: 1 }); }
  // resto de métodos con implementación mínima...
}

describe('TicketRepositoryImpl', () => {
  it('no vuelve a llamar al datasource si getAll ya cacheó', async () => {
    const datasource = new FakeDatasource();
    const repo = new TicketRepositoryImpl(datasource);

    await repo.getAll();
    await repo.getAll();

    expect(datasource.getAllCalls).toBe(1);
  });

  it('invalida la caché al crear', async () => {
    const datasource = new FakeDatasource();
    const repo = new TicketRepositoryImpl(datasource);

    await repo.getAll();
    await repo.create('new-id');
    await repo.getAll();

    expect(datasource.getAllCalls).toBe(2);
  });
});
```

### Presenter / mapper de response — el secreto no aparece

```ts
// test/domain/dtos/user.response.dto.test.ts
import { UserResponseMapper } from '../../../src/domain/dtos/users/response/user.response.dto';
import { UserEntity } from '../../../src/domain/entities/user.entity';

it('nunca incluye la password', () => {
  const user = UserEntity.create({ id: '1', name: 'Ana', email: 'a@test.com', password: 'hashed' });
  const dto = UserResponseMapper.fromEntity(user);

  expect(dto).not.toHaveProperty('password');
});
```

### Rutas con supertest

Requiere que `XRoutes.routes` acepte un parámetro de dependencias **opcional** — ver la nota de
prerrequisito abajo.

```ts
// test/presentation/http/users.routes.test.ts
import request from 'supertest';
import express from 'express';
import { UserRoutes } from '../../../src/presentation/http/api/users/routes';
import { errorHandlerMiddleware } from '../../../src/presentation/http/api/middlewares/error-handler.middleware';

function buildApp(deps: Parameters<typeof UserRoutes.routes>[0]) {
  const app = express();
  app.use(express.json());
  app.use('/api/users', UserRoutes.routes(deps));
  app.use(errorHandlerMiddleware);
  return app;
}

describe('GET /api/users', () => {
  it('devuelve 401 sin token', async () => {
    const app = buildApp({ service: fakeUserService, requireAuth: realAuthMiddleware });
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(401);
  });

  it('devuelve 200 con token válido', async () => {
    const app = buildApp({ service: fakeUserService, requireAuth: alwaysAuthenticated });
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(200);
  });
});
```

## Prerrequisito: hacer opcional el parámetro de deps en `XRoutes.routes`

Si `routes.ts` construye sus propias dependencias en un getter estático, supertest no puede
inyectar un doble sin levantar la infraestructura real. El cambio mínimo, que no rompe nada:

```ts
export class UserRoutes {
  static routes(deps?: { service?: UserService; requireAuth?: RequestHandler }): Router {
    const service = deps?.service ?? buildRealService();
    const requireAuth = deps?.requireAuth ?? buildRealAuthMiddleware();
    // ...resto igual
  }
}
```

Sin argumentos, construye lo real — el entrypoint principal no cambia. Con argumentos, usa los
dobles del test. Es un cambio de firma pequeño, no una reorganización del composition root.

## Casos de alto valor (por qué estos y no cobertura por cobertura)

Prioriza tests que protegen una decisión de diseño concreta sobre tests que solo ejercitan líneas:

- Anti-enumeración: mismo error para email inexistente y para password incorrecta.
- Ningún DTO de response ni presenter expone un campo sensible.
- El repository invalida caché exactamente en las mutaciones, no en las lecturas.
- Un `update` con patch parcial conserva los campos no enviados.
- Cada regla de validación de un DTO de request tiene su propio caso, no solo el camino feliz.

## Regla de cierre

Un feature no está terminado sin tests de su servicio y de las invariantes de su entidad.
`npm test` debe quedar verde antes de dar el trabajo por hecho — y los tests no sustituyen la
comprobación end-to-end contra el servidor real levantado.
