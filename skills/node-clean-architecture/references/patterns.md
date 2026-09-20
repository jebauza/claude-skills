# Plantillas de código por tipo de artefacto

Ejemplos completos, listos para adaptar. Todos toman como referencia el proyecto `13-ticket-desk`
(ver la nota sobre el proyecto de referencia en `SKILL.md`).

## Entidad

```ts
// domain/entities/ticket.entity.ts
export interface TicketCreateProps {
  id: string;
  number: number;
  createAt?: Date | string;
  handleAtDesk?: string | null;
  handleAt?: Date | string | null;
  done?: boolean;
}

export class TicketEntity {
  private constructor(
    public id: string,
    public number: number,
    public createAt: Date,
    public handleAtDesk: string | null,
    public handleAt: Date | null,
    public done: boolean,
  ) {}

  public get isPending(): boolean {
    return this.handleAtDesk === null;
  }

  static create(props: TicketCreateProps): TicketEntity {
    const { id, number, createAt, handleAtDesk, handleAt, done } = props;
    if (!id) throw new Error('id is required');
    if (number === undefined) throw new Error('number is required');

    return new TicketEntity(
      id,
      number,
      createAt ? new Date(createAt) : new Date(),
      handleAtDesk ?? null,
      handleAt ? new Date(handleAt) : null,
      !!done,
    );
  }

  static fromObject(object: { [key: string]: any }): TicketEntity {
    return TicketEntity.create(object as TicketCreateProps);
  }
}
```

## Puerto de repositorio y de datasource

```ts
// domain/repositories/ticket.repository.ts
import { TicketEntity } from '../entities/ticket.entity';

export abstract class TicketRepository {
  abstract findOne(id: string): Promise<TicketEntity | null>;
  abstract getAll(): Promise<TicketEntity[]>;
  abstract create(id: string): Promise<TicketEntity>;
  abstract update(id: string, data: TicketEntity): Promise<TicketEntity | null>;
  abstract delete(id: string): Promise<boolean>;
}
```

```ts
// domain/datasources/ticket.datasource.ts
import { TicketEntity } from '../entities/ticket.entity';

export abstract class TicketDatasource {
  abstract findOne(id: string): Promise<TicketEntity | null>;
  abstract getAll(): Promise<TicketEntity[]>;
  abstract create(id: string): Promise<TicketEntity>;
  abstract update(id: string, data: TicketEntity): Promise<TicketEntity | null>;
  abstract delete(id: string): Promise<boolean>;
}
```

Repository y datasource suelen empezar con la misma firma — el repository añade después métodos
que no son de ninguna tecnología concreta (agregaciones sobre varias llamadas, políticas de
reintento) sin tocar el datasource.

## Repository impl (caché + traducción de errores)

```ts
// infrastructure/repositories/tickets/ticket.repository.impl.ts
import { TicketEntity } from '../../../domain/entities/ticket.entity';
import { CustomError } from '../../../domain/errors/custom.error';
import { TicketDatasource } from '../../../domain/datasources/ticket.datasource';
import { TicketRepository } from '../../../domain/repositories/ticket.repository';

export class TicketRepositoryImpl extends TicketRepository {
  private cache: TicketEntity[] | null = null;

  constructor(private readonly datasource: TicketDatasource) {
    super();
  }

  async findOne(id: string): Promise<TicketEntity | null> {
    try {
      return await this.datasource.findOne(id);
    } catch (error) {
      throw this.handleError(error);
    }
  }

  async getAll(): Promise<TicketEntity[]> {
    if (this.cache) return this.cache;
    try {
      this.cache = await this.datasource.getAll();
      return this.cache;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  async create(id: string): Promise<TicketEntity> {
    try {
      const ticket = await this.datasource.create(id);
      this.cache = null;
      return ticket;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  private handleError(error: unknown): CustomError {
    if (error instanceof CustomError) return error;
    console.error(error);
    return CustomError.internalServer('Ticket persistence error');
  }
}
```

## Datasource concreto + mapper (Postgres)

```ts
// infrastructure/data/postgres/tickets/ticket.mapper.ts
import { TicketEntity } from '../../../../domain/entities/ticket.entity';

interface TicketRow {
  id: string;
  number: number;
  create_at: Date;
  handle_at_desk: string | null;
  handle_at: Date | null;
  done: boolean;
}

export class TicketMapper {
  static fromRow(row: TicketRow): TicketEntity {
    return TicketEntity.create({
      id: row.id,
      number: row.number,
      createAt: row.create_at,
      handleAtDesk: row.handle_at_desk,
      handleAt: row.handle_at,
      done: row.done,
    });
  }
}
```

```ts
// infrastructure/data/postgres/tickets/ticket.datasource.impl.ts
import { TicketEntity } from '../../../../domain/entities/ticket.entity';
import { TicketDatasource } from '../../../../domain/datasources/ticket.datasource';
import { PostgresDatabase } from '../postgres.database';
import { TicketMapper } from './ticket.mapper';

export class TicketDatasourceImpl extends TicketDatasource {
  private get pool() {
    return PostgresDatabase.instance.pool;
  }

  async findOne(id: string): Promise<TicketEntity | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM tickets WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0] ? TicketMapper.fromRow(rows[0]) : null;
  }

  async getAll(): Promise<TicketEntity[]> {
    const { rows } = await this.pool.query('SELECT * FROM tickets ORDER BY number ASC');
    return rows.map(TicketMapper.fromRow);
  }

  async create(id: string): Promise<TicketEntity> {
    const { rows } = await this.pool.query(
      `INSERT INTO tickets (id, number)
       VALUES ($1, (SELECT COALESCE(MAX(number), 0) + 1 FROM tickets))
       RETURNING *`,
      [id],
    );
    return TicketMapper.fromRow(rows[0]);
  }
}
```

## Singleton de infraestructura con helper de transacción

```ts
// infrastructure/data/postgres/postgres.database.ts
import { Pool, PoolClient } from 'pg';

interface Options {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export class PostgresDatabase {
  private static _instance: PostgresDatabase;
  public readonly pool: Pool;

  private constructor(options: Options) {
    this.pool = new Pool(options);
    // Sin este listener, un error de conexión idle tumba el proceso.
    this.pool.on('error', (error) => console.error('Unexpected Postgres error', error));
  }

  static get instance(): PostgresDatabase {
    if (!PostgresDatabase._instance) throw new Error('PostgresDatabase not initialized');
    return PostgresDatabase._instance;
  }

  static async connect(options: Options): Promise<PostgresDatabase> {
    PostgresDatabase._instance = new PostgresDatabase(options);
    return PostgresDatabase._instance;
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
```

## Adapter (métodos estáticos, sin `implements`)

```ts
// infrastructure/adapters/uuid.adapter.ts
import { v4 as uuidv4, validate } from 'uuid';

export class UuidAdapter {
  static generate(): string {
    return uuidv4();
  }
  static isValid(id: string): boolean {
    return validate(id);
  }
}
```

Se pasa la clase directamente donde se espera el puerto `IdManager` (`{ generate(): string;
isValid(id): boolean }`) — el tipado estructural de TS lo acepta sin `implements`.

## DTO de request (tupla, no excepción)

```ts
// domain/dtos/users/request/create-user.dto.ts
export class CreateUserDto {
  private constructor(
    public name: string,
    public email: string,
    public password: string,
  ) {}

  static create(object: { [key: string]: any }): [string | undefined, CreateUserDto | undefined] {
    const { name, email, password } = object;
    if (!name) return ['Missing name', undefined];
    if (!email) return ['Missing email', undefined];
    if (!password) return ['Missing password', undefined];
    if (password.length < 6) return ['Password must be at least 6 characters', undefined];

    return [undefined, new CreateUserDto(name, email, password)];
  }
}
```

Consumo en el controller:

```ts
public createUser = async (req: Request, res: Response, next: NextFunction) => {
  const [error, dto] = CreateUserDto.create(req.body);
  if (error) return res.status(400).json({ error });

  try {
    const user = await this.service.createUser(dto!);
    res.status(201).json(ApiResponse.success(user));
  } catch (error) {
    next(error);
  }
};
```

## DTO de response (protege un secreto por tipado)

```ts
// domain/dtos/users/response/user.response.dto.ts
import { UserEntity } from '../../../entities/user.entity';

export interface UserResponseDto {
  id: string;
  name: string;
  email: string;
  // NO lleva password — el servicio devuelve esto, nunca UserEntity.
}

export class UserResponseMapper {
  static fromEntity(user: UserEntity): UserResponseDto {
    return { id: user.id, name: user.name, email: user.email };
  }
  static fromEntities(users: UserEntity[]): UserResponseDto[] {
    return users.map(UserResponseMapper.fromEntity);
  }
}
```

## Presenter (da forma HTTP y materializa getters derivados)

```ts
// presentation/http/api/tickets/presenters/ticket.presenter.ts
import { TicketEntity } from '../../../../../domain/entities/ticket.entity';

export class TicketPresenter {
  static fromEntity(ticket: TicketEntity) {
    return {
      id: ticket.id,
      number: ticket.number,
      done: ticket.done,
      isPending: ticket.isPending, // getter: no sobrevive a JSON.stringify sin esto
    };
  }
  static fromEntities(tickets: TicketEntity[]) {
    return tickets.map(TicketPresenter.fromEntity);
  }
}
```

## Middleware factory (recibe dependencias) vs. plano

```ts
// presentation/http/api/middlewares/auth.middleware.ts
export function authMiddleware(repository: UserRepository, tokenManager: TokenManager) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    const token = authHeader.slice('Bearer '.length);
    const payload = await tokenManager.verify<{ id: string }>(token);
    if (!payload) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    // Recarga desde la BD, no confía en el payload — ver SKILL.md "Seguridad de la API".
    const user = await repository.findOne(payload.id);
    if (!user) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    req.user = user;
    next();
  };
}
```

```ts
// presentation/http/api/middlewares/require-admin.middleware.ts
export function requireAdminMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: 'Admin role required' });
    return;
  }
  next();
}
```

## Composition root de un feature

```ts
// presentation/http/api/users/routes.ts
export class UserRoutes {
  static get routes(): Router {
    const router = Router();

    const datasource = new UserDatasourceImpl();
    const repository = new UserRepositoryImpl(datasource);
    const service = new UserService(repository, UuidAdapter, BcryptAdapter);
    const controller = new UserController(service);
    const requireAuth = authMiddleware(repository, JwtAdapter);

    router.post('/', writeRateLimiterMiddleware, controller.createUser);
    router.get('/', requireAuth, controller.getUsers);

    return router;
  }
}
```

## Composition root de un comando CLI

```ts
// presentation/cli/ticket.seed.command.ts
async function main() {
  await PostgresDatabase.connect({ /* ...envs */ });

  const datasource = new TicketDatasourceImpl();
  const repository = new TicketRepositoryImpl(datasource);
  const service = new TicketService(repository, UuidAdapter, new WssNotifier());

  await service.seedTickets();
  console.log('Seed finished');
  process.exit(0);
}
```

## Error de dominio

```ts
// domain/errors/custom.error.ts
export class CustomError extends Error {
  private constructor(public readonly statusCode: number, public readonly message: string) {
    super(message);
  }
  static badRequest(message: string) { return new CustomError(400, message); }
  static unauthorized(message: string) { return new CustomError(401, message); }
  static forbidden(message: string) { return new CustomError(403, message); }
  static notFound(message: string) { return new CustomError(404, message); }
  static conflict(message: string) { return new CustomError(409, message); }
  static internalServer(message: string) { return new CustomError(500, message); }
}
```

Propagado siempre con `next(error)` hacia un único error handler al final de la cadena de
middlewares de Express.
