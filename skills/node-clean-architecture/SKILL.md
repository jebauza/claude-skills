---
name: node-clean-architecture
description: Arquitectura por capas escalable para backends Node.js/TypeScript/JavaScript (domain/infrastructure/presentation, entidades, repositorios abstractos, datasources intercambiables por tecnología), con catálogo de patrones de diseño, seguridad de API y tests unitarios. Úsala al diseñar o implementar un backend Node nuevo (o un feature nuevo en uno existente), y también cuando el usuario pida mejorar, refactorizar o migrar la arquitectura de un proyecto backend existente hacia algo más escalable ("mejora la arquitectura", "migra esto a algo más limpio/escalable", "este proyecto tiene una arquitectura poco escalable").
user_invocable: true
---

# node-clean-architecture

Patrón de arquitectura por capas para backends Node.js, validado y refinado de punta a punta en el
proyecto `13-ticket-desk`, que sirve como **ejemplo real ya migrado** — si necesitas ver el patrón
aplicado con archivos concretos y ese repo está disponible en esta máquina, léelo directamente ahí
(búscalo por nombre; no asumas una ruta fija, varía entre máquinas). Su `CLAUDE.md` es el documento
normativo portable de este mismo patrón, y se copia a cada proyecto nuevo.

**Frontera con `CLAUDE.md`**: este skill explica el patrón — el porqué de cada carpeta, catálogo
de patrones con su razonamiento, plantillas de código, cómo arrancar un proyecto o migrar uno
legacy. Las reglas normativas ("siempre / nunca / debe") no se repiten aquí: viven en el
`CLAUDE.md` de cada proyecto (ver `references/bootstrap.md` para copiarlo a uno nuevo). Si al
editar este skill una frase empieza por "siempre", "nunca" o "debe", probablemente pertenece al
`CLAUDE.md`, no aquí.

Dos modos de uso:
- **Referencia pasiva**: al escribir código nuevo (proyecto nuevo o feature nuevo en uno
  existente), aplica esta estructura directamente, sin preguntar si se debe usar.
- **Migración activa**: cuando el usuario pida mejorar/migrar la arquitectura de un proyecto
  existente, sigue `references/migration.md`.

Ficheros de este skill:

```
SKILL.md                 este documento: regla de dependencia, estructura, catálogo de patrones,
                          seguridad, tests, regla de comentarios, checklist de feature nuevo
references/patterns.md       plantilla de código canónica por tipo de artefacto
references/testing.md        config de Jest + ts-jest, dobles a mano, ejemplos por capa, supertest
references/bootstrap.md      arrancar un proyecto nuevo desde cero (incluye copiar el CLAUDE.md)
references/migration.md      migrar un proyecto legacy hacia este patrón
references/db-migrations.md  el porqué y las plantillas de las migraciones de esquema
```

## Regla de dependencia

Tres capas, las flechas de import solo apuntan hacia adentro:

```
presentation/  →  domain/
infrastructure/ →  domain/
domain/         →  (nada fuera de sí mismo)
```

`domain/` nunca importa de `infrastructure/` ni de `presentation/`. Los únicos puntos donde se
cruzan capas hacia infraestructura son los **composition roots** (ver más abajo). Criterio
verificable de que la regla se cumple de verdad, no solo de nombre: **`domain/` debe compilar sin
Express, `pg`, `ws` ni ninguna librería de infraestructura instalada.** Si borrar esas dependencias
del `package.json` rompe algo dentro de `domain/`, la regla está violada en algún sitio.

## Estructura de carpetas

```
src/
  config/envs.ts                        env-var, .required(), opcionales para datasources alternos
  domain/
    entities/         <entity>.entity.ts
    datasources/      <entity>.datasource.ts      (puerto, abstract class)
    repositories/     <entity>.repository.ts      (puerto, abstract class)
    services/         <entity>.service.ts
    dtos/
      <entidad>/request/*.dto.ts                  private ctor + static create(): [error?, dto?]
      <entidad>/response/*.dto.ts                 interface + <X>ResponseMapper
      shared/pagination.dto.ts
    interfaces/       id-manager, password-hasher, token-manager, realtime-notifier  (interface, no abstract class)
    errors/custom.error.ts
  infrastructure/
    data/
      <tech>/                                     postgres | mongo | external-api | ...
        <tech>.database.ts | <tech>.client.ts     singleton: ctor privado, static connect(), static get instance()
        migrations/*.sql                          si aplica; secciones -- Up / -- Down
        <entidad>/
          <entity>.datasource.impl.ts
          <entity>.mapper.ts                      reshapea columnas/documentos; NUNCA valida
    repositories/<entidad>/<entity>.repository.impl.ts
    adapters/         uuid, bcrypt, jwt, http-client   clases con métodos estáticos
    websocket/        (si el proyecto usa tiempo real) wss.server.ts, wss.notifier.ts
  presentation/
    http/
      server.ts                                   express + seguridad; setRoutes() y fallbacks al final
      api/
        routes.ts                                 agregador: monta cada feature bajo /api/<feature>
        shared/api-response.ts                    { data } | { data, meta }
        middlewares/                               auth, error-handler, rate-limit, require-admin, ...
        <feature>/
          routes.ts                               composition root del feature
          controller.ts
          presenters/<entity>.presenter.ts
    cli/<algo>.command.ts                         composition root de comando
  app.ts                                          conecta infra compartida y arranca; no conoce features
```

### Por qué se organiza así (no por accidente — cada carpeta resuelve una pregunta distinta)

- **`data/<tecnología>/<entidad>/`**: la tecnología (Postgres, Mongo, una API externa) es el eje
  porque **una tecnología puede respaldar varias entidades**, y **una entidad puede tener varios
  datasources intercambiables** (hoy Postgres, mañana Mongo, sin tocar el resto). El
  `<tecnología>.database.ts` (conexión/pool) vive en la raíz de esa carpeta porque lo comparten
  todos los datasources de esa tecnología. La tecnología es **carpeta**, no sufijo de fichero: el
  datasource concreto se llama `<entity>.datasource.impl.ts` en todas, no
  `<entity>.postgres.datasource.ts` en una y `<entity>.mongo.datasource.ts` en otra.
- **`infrastructure/repositories/<entidad>/`**: aquí NO se organiza por tecnología —
  `TicketDatasource` es el contrato común que TODAS las tecnologías implementan, y
  `TicketRepositoryImpl` es agnóstico de tecnología. Vive fuera de `data/` a propósito: si viviera
  dentro de `data/postgres/`, cambiar de tecnología significaría desenterrar el contrato de la
  carpeta de un competidor tecnológico.
- **`adapters/`**: solo para utilidades de **un único rol activo a la vez**, sin necesidad de swap
  en runtime (ej. `uuid.adapter.ts`, `http-client.adapter.ts`, `bcrypt.adapter.ts`). Si mañana
  cambias de librería (uuid → nanoid, fetch → axios), **reescribes el mismo archivo**, no creas uno
  nuevo por librería. No llevan `implements` de ningún puerto — son clases con métodos estáticos,
  consumidas pasando la clase misma donde se espera el contrato (funciona por tipado estructural en
  TS; en JS plano no hace falta ni eso).
- **`presentation/http/api/<feature>/routes.ts` es el composition root del feature**: arma
  `datasource → repository → service → controller` ahí mismo. El entrypoint principal
  (`app.ts`/`main.ts`) se mantiene mínimo — solo conecta infraestructura compartida (pools de
  conexión, servidor WebSocket si aplica) y monta los routers de cada feature — y por eso **no
  crece** a medida que se agregan features nuevos.
- **`presentation/cli/`**: scripts de comando (seeds, migraciones manuales, tareas puntuales) son
  otro "canal de entrada" igual de válido que HTTP — no viven sueltos en `src/`, tienen su propio
  composition root igual que las rutas HTTP.

## Dónde va cada contrato

> **Los puertos (`abstract class` para repositorios/datasources, `interface` para capacidades
> técnicas) viven en `domain/`. Las implementaciones concretas viven en `infrastructure/`.**
> `domain/` declara todo lo que necesita del mundo exterior y no importa nada de él — es la
> inversión de dependencias aplicada, no una preferencia de carpetas.

Ejemplos ya resueltos:
- `TicketRepository` (abstract class) → `domain/repositories/`, porque `TicketService` (dominio)
  lo recibe por constructor, y porque es un puerto que el dominio declara necesitar.
- `TicketDatasource` (abstract class) → **también** `domain/datasources/`, aunque solo lo consuma
  `TicketRepositoryImpl` (infraestructura): sigue siendo un puerto — describe una capacidad que el
  dominio necesita del mundo exterior — y todos los puertos se agrupan en `domain/` para que se
  vean juntos.
- `IdManager`/`PasswordHasher`/`TokenManager`/`RealtimeNotifier` (interface) → `domain/interfaces/`,
  por el mismo motivo, con una asimetría deliberada frente a repositorios/datasources: son
  `interface` plana, no `abstract class`, porque se satisfacen por tipado estructural pasando la
  clase del adapter directamente, sin `extends`.
- `HttpClientAdapter` → `infrastructure/adapters/`, porque no es un puerto que el dominio declare
  necesitar — es infraestructura hablándose a sí misma (p. ej. un `ExternalApiClient` llamando a
  una API externa), nunca lo ve un servicio de dominio.

Antes de ubicar un contrato nuevo, pregúntate: **¿el dominio necesita esta capacidad para cumplir
una regla de negocio (persistencia, generar ids, hashear, notificar), o es un detalle técnico que
solo usa otra pieza de infraestructura?** Lo primero es un puerto → `domain/`. Lo segundo es un
adapter → `infrastructure/adapters/`.

## Patrones de diseño y principios en uso

El código no solo respeta una regla de dependencia — aplica un catálogo de patrones concreto, cada
uno resolviendo un problema puntual. Nombrarlos ayuda a razonar el patrón en un dominio distinto en
vez de copiar la forma sin entender el motivo:

| Patrón | Dónde | Qué resuelve |
|---|---|---|
| **Repository** | `domain/repositories/` + `infrastructure/repositories/` | El dominio pide datos sin saber de dónde salen |
| **Strategy** | varios `<entity>.datasource.impl.ts` tras un mismo puerto | Cambiar Postgres→Mongo→API sin tocar nada más |
| **Adapter** | `infrastructure/adapters/` | Aislar librerías de terceros (jwt, bcrypt, uuid) detrás de un contrato propio |
| **Data Mapper** | `data/<tech>/<entidad>/<entity>.mapper.ts` | Traducir `snake_case`/`_id` a la entidad sin duplicar validación |
| **DTO** | `domain/dtos/` | Validar la entrada en el borde y controlar la forma de la salida |
| **Presenter** | `presentation/http/api/<feature>/presenters/` | Dar forma a la respuesta HTTP y materializar getters derivados |
| **Factory Method** | `Entity.create()`, `Dto.create()`, middlewares-factory | Un objeto solo existe si es válido; o inyectar deps a un middleware |
| **Singleton** | `PostgresDatabase`, `ExternalApiClient`, `WssServer` | Un solo pool/cliente por proceso, con fallo explícito si no se inicializó |
| **Observer / Pub-Sub** | `RealtimeNotifier` + `broadcast()` | El dominio notifica sin conocer WebSockets ni ningún transporte concreto |
| **Dependency Injection** (por constructor) | todos los servicios y repositorios | Sustituir cualquier colaborador, empezando por los tests |
| **Composition Root** | `<feature>/routes.ts`, `cli/*.command.ts` | Un único sitio por canal de entrada donde se conoce lo concreto |

Principios detrás de la estructura, siempre anclados al código y no en abstracto:

- **Regla de dependencia**: las flechas de import apuntan hacia dentro. Lo estable (dominio) no
  depende de lo volátil (framework, BD, librería HTTP).
- **Inversión de dependencias**: el dominio *declara* lo que necesita (`domain/interfaces/`,
  `domain/repositories/`, `domain/datasources/`) y la infraestructura se adapta a esa declaración.
  Es la razón de que los puertos vivan en `domain/` — no una preferencia de organización.
- **La infraestructura es un plugin**: Express, Postgres, `ws` son detalles reemplazables. La
  prueba de que se cumple es la de la sección "Regla de dependencia" arriba.
- **Responsabilidad única aplicada por capas**: entidad = invariantes; servicio = reglas de
  negocio; repositorio = caché y traducción de errores; datasource = tecnología; controller = HTTP.
- **Objetos siempre válidos**: constructor privado + factory estática. No existe una entidad a
  medio construir, así que ninguna capa posterior tiene que revalidar lo que ya llegó válido.

**Nombra el patrón cuando aclara, no siempre.** El catálogo sirve para decidir dónde poner algo
nuevo y para explicar una decisión — no para decorar. No crees una clase
`UserFactoryStrategyAdapter` porque el catálogo exista; si un caso no encaja limpio en ninguno, va
sin nombre de patrón.

## Entidades (`domain/entities/`)

Constructor **privado**, propiedades públicas, getters para valores derivados (no propiedades
propias — no aparecen en `JSON.stringify` a menos que se referencien explícitamente vía presenter),
y un `static create(props)` que valida los campos requeridos y normaliza los opcionales (fechas
como string → `Date`, `undefined` → `null` explícito, strings recortados/normalizados):

```ts
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

`fromObject()` delega en `create()` — no hay dos caminos de validación. El **id lo genera siempre
el servicio** (vía `IdManager` inyectado), nunca la entidad ni el mapper: `create()` exige que ya
venga.

Cada mapper tecnológico (`ticket.mapper.ts` en `data/postgres/tickets/`, otro en
`data/mongo/tickets/`, otro en `data/external-api/tickets/`) solo renombra las claves de su formato
crudo (`snake_case`, `_id`, JSON con fechas en string) y delega toda la validación/normalización en
`TicketEntity.create()` — así la lógica de parseo no se duplica una vez por tecnología.

## Repositorios y datasources: abstract class, no interface

Ambos contratos (`domain/repositories/<entity>.repository.ts` y
`domain/datasources/<entity>.datasource.ts`) se declaran como **`abstract class`**, no `interface`:

```ts
export abstract class TicketRepository {
  abstract getAll(): Promise<TicketEntity[]>;
  abstract create(id: string): Promise<TicketEntity>;
  // ...
}
```

Las implementaciones usan `extends` (no `implements`) y llaman `super()` explícitamente si definen
su propio constructor.

## Repository vs Datasource — la diferencia tangible

- **Datasource**: sabe la tecnología concreta. Un datasource Postgres sabe SQL y columnas; uno
  Mongo sabe queries de Mongo; uno de API externa sabe llamar HTTP. Nada más.
- **Repository**: no sabe nada de tecnología. Es dueño de cualquier lógica que no es de la
  tecnología ni regla de negocio de dominio: traducir errores de infraestructura a errores de
  dominio, y cachear.

Ejemplo real de caché en el repositorio (el datasource nunca se entera de que existe):

```ts
export class TicketRepositoryImpl extends TicketRepository {
  private cache: TicketEntity[] | null = null;

  constructor(private readonly datasource: TicketDatasource) {
    super();
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
      this.cache = null; // invalidar en cada mutación
      return ticket;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  private handleError(error: unknown): CustomError {
    if (error instanceof CustomError) return error;
    console.error(error);
    return CustomError.internalServer('Persistence error');
  }
}
```

## Otros patrones de implementación (plantilla completa en `references/patterns.md`)

- **DTOs de request** (`domain/dtos/<entidad>/request/`): constructor privado +
  `static create(object): [string | undefined, Dto | undefined]`. Devuelven tupla, no lanzan — el
  controller corta con 400 sin `try/catch`.
- **DTOs de response** (`domain/dtos/<entidad>/response/`): `interface` plana + clase
  `<X>ResponseMapper` con `fromEntity`/`fromEntities`. Se usan cuando la entidad tiene un secreto
  que nunca debe salir: el servicio devuelve el DTO de respuesta, no la entidad, así el compilador
  impide filtrar el secreto sin depender de que la capa HTTP recuerde aplicar un presenter.
- **Presenters** (`presentation/http/api/<feature>/presenters/`): dan forma a la respuesta HTTP y
  **materializan los getters derivados** de la entidad (que de otro modo no sobreviven a
  `JSON.stringify`). Distinción con el DTO de respuesta: el DTO de respuesta protege un secreto a
  nivel de dominio; el presenter da forma a nivel HTTP. Una entidad sin secretos solo necesita
  presenter, no DTO de respuesta.
- **Controllers**: propiedades de función flecha (quedan ligadas al pasarse a Express). Validación
  de DTO → `res.status(400)` inline; errores de negocio → `next(error)`; respuesta siempre
  envuelta con un helper tipo `ApiResponse.success(...)`.
- **Middlewares**: factory cuando necesitan dependencias inyectadas
  (`authMiddleware(repository, tokenManager)`), función plana cuando no. El error handler y
  cualquier catch-all se registran **después** de las rutas de la API o `next(error)` nunca llega.
- **Asociaciones M:N entre agregados independientes** (ej. usuarios y roles): el agregado **no**
  las incluye automáticamente; van en endpoints aparte (`GET|PUT /api/users/:id/roles`). Un solo
  servicio es dueño de la escritura, el otro solo lee la inversa. Contrasta con la
  **composición**, que sí viaja con el agregado (ej. las direcciones de un usuario).
- **Escrituras multi-tabla**: el `.database.ts` de la tecnología expone un helper de transacción
  (`transaction(fn)` que presta un client) para cualquier datasource que escriba en más de una
  tabla como una sola operación atómica — dos queries sueltas contra el pool pueden caer en
  conexiones distintas y no comparten transacción.
- **Singletons de infraestructura**: constructor privado, `static connect(options)`,
  `static get instance()` que lanza si no se inicializó.

## Seguridad de la API

La seguridad es parte del patrón, no un añadido posterior: depende de *dónde* vive cada cosa (el
secreto se protege en el DTO de dominio, no en el presenter; la autorización se compone en el
`routes.ts` del feature). Las reglas normativas concretas están en el `CLAUDE.md` de cada
proyecto — aquí el porqué de cada una.

### Postura de autenticación/autorización

- **JWT con expiración obligatoria** y seed validado (`.required()` + longitud mínima).
  **El payload del token lleva solo el id** — nunca rol ni permisos.
- **El middleware de auth recarga el usuario desde la BD en cada request**, en vez de confiar en
  el payload. Es la decisión de seguridad más importante del diseño: un usuario borrado o
  degradado pierde acceso al instante, sin esperar a que caduque el token. Es también la razón de
  que el rol no viaje en el token — no puede quedar obsoleto.
- **Autorización en middlewares componibles**: uno responde "¿quién eres?" (autenticación), otro
  "¿puedes?" (autorización). Se encadenan por ruta en el `routes.ts` del feature, así el nivel de
  protección de cada endpoint se lee de un vistazo en una sola línea.
- **El secreto nunca sale, garantizado por el compilador**: los servicios devuelven el DTO de
  respuesta, no la entidad — la protección no depende de que la capa HTTP recuerde un presenter.
- **Mensaje de login genérico** (el mismo si el usuario no existe o si la contraseña falla), para
  no permitir enumerar cuentas.
- **El error handler no filtra internos**: un error de dominio conocido responde con su mensaje y
  status; cualquier otra cosa devuelve un 500 genérico, y el detalle va solo al log del servidor.
  Nunca loguear el body de un request — puede llevar credenciales.

### Checklist de endurecimiento para producción

Huecos habituales al copiar este patrón a un proyecto nuevo, con el porqué de cada uno:

1. **`trust proxy`**: detrás de un reverse proxy, sin configurarlo, `req.ip` es la IP del proxy
   para todas las peticiones — el rate limit pasa a ser un cupo global compartido en vez de por
   cliente, y cualquier log por IP se vuelve inútil.
2. **Hash de contraseñas asíncrono, con cost factor explícito**: una implementación síncrona
   bloquea el event loop en cada login/registro. Ojo: cambiar esto normalmente **obliga a cambiar
   el puerto** del hasher a `Promise`, así que sube hasta el contrato de dominio — no es solo un
   cambio de adapter.
3. **WebSocket autenticado y filtrado por cliente** en cuanto se emita algo que no sea público —
   si hoy solo se hace `broadcast()` de un dato genérico, documentarlo como decisión consciente y
   dejar dicho que hay que revisarlo el día que se emita algo por usuario o por rol.
4. **CORS solo si el frontend se separa del backend**: si se sirve estático desde el mismo Express,
   es same-origin y no hace falta. Cuando se separen, allowlist de orígenes explícita, nunca `*`
   (que además es inválido junto con credenciales).
5. **Revocación de tokens**: un JWT robado sirve hasta que caduca. La recarga de usuario en cada
   request mitiga parcialmente (un usuario borrado pierde acceso), pero no cubre a un usuario
   válido cuyo token fue robado. Salida estándar: un campo de versión en el usuario, incluido en
   el token y comparado al validar.
6. **Ningún middleware de seguridad "fantasma"**: si se define un middleware y no se monta en
   ninguna ruta, es peor que no tenerlo — parece una protección activa y no lo es. Verificar
   siempre que lo que se define, se usa.
7. **Gating por rol simple vs. RBAC granular**: si el proyecto tiene un rol simple
   (admin/usuario) y además un sistema de roles/permisos granular, es razonable que las decisiones
   de acceso arranquen gateando solo con el rol simple (problema de arranque: alguien tiene que
   poder asignar el primer rol granular). Documentarlo como estado consciente, no como bug, y
   dejar explícito cuándo se conecta el RBAC granular a decisiones de acceso reales.

### SQL injection: defensa en tres capas

Cada capa cubre lo que la anterior no puede. El orden importa — invertirlo es el error clásico:
confiar en el filtro de entrada y descuidar las queries.

**Capa 1 — Queries parametrizadas. Es la protección real.** Toda query usa placeholders
(`$1, $2, ...`) y pasa los valores como array; el driver los envía separados del texto SQL, así que
el valor nunca se interpreta como sintaxis:

```ts
await this.pool.query('SELECT * FROM tickets WHERE id = $1 LIMIT 1', [id]);
```

Un template literal multilínea **sin** interpolación es correcto para SQL largo; lo prohibido es
meter un `${}` dentro del texto de la query.

**Capa 2 — Lint que impide la regresión al escribir, no en revisión.** Dos reglas de
`no-restricted-syntax` en nivel `error`:

```js
"CallExpression[callee.property.name='query'] > TemplateLiteral[expressions.length>0]"  // `... ${x}`
"CallExpression[callee.property.name='query'] > BinaryExpression[operator='+']"         // 'a' + x
```

`expressions.length>0` es deliberado: permite el template literal multilínea limpio y bloquea solo
el interpolado. Sin ese matiz la regla molesta más de lo que protege.

**Capa 3 — Middleware de detección perimetral (opcional, defensa en profundidad).** Filtra
`body`/`query`/`params`/`path` contra firmas conocidas (`union select`, `--`, `; drop`,
`' or 1=1`, etc.) de forma recursiva, loguea y corta con 400 genérico si detecta algo. Se monta
**después** del parser de body, porque necesita el body ya parseado.

Advertencias para no usar mal esta capa 3:
- Es detección y registro, **no** licencia para relajar la capa 1.
- Es un filtro por firmas: tiene falsos positivos con texto libre legítimo (una nota que contenga
  `--`, un nombre con "select"). Si un campo de texto libre empieza a rechazar entradas válidas, la
  solución es excluirlo del filtro, nunca debilitar la capa 1.
- **No cubre identificadores dinámicos** — un `ORDER BY` o nombre de columna elegido por el
  cliente no se puede parametrizar con `$1`; eso se valida contra una **lista blanca** de columnas
  permitidas. Es el hueco por el que se cuela una inyección en un proyecto que ya se cree
  "protegido".
- Con Mongo el vector cambia de forma (operadores `$` en el payload, no comillas): la capa 1
  equivalente es no pasar objetos del usuario directos a un filtro sin sanear.

## Tests unitarios

Ver `references/testing.md` para la configuración completa y ejemplos por capa. Resumen del
argumento: esta arquitectura no es testeable por casualidad — cada puerto es una costura donde
enchufar un doble, y por eso **no hace falta framework de mocking**. Un repositorio falso es una
clase que hace `extends TicketRepository` y devuelve datos en memoria; tipado real, así que si el
puerto cambia, el compilador rompe el doble en vez de dejarlo mintiendo. Si un test necesita
`jest.mock()` de un módulo, casi siempre es señal de que falta una inyección, no de que falte una
herramienta.

Qué se testea en cada capa:

| Capa | Se testea | Doble que se usa |
|---|---|---|
| Entidades | invariantes de `create()`: requeridos, normalización, rechazo de inválidos, getters derivados | ninguno, son puras |
| DTOs de request | la tupla `[error, dto]`: cada regla y el caso feliz | ninguno |
| Servicios | reglas de negocio y errores de dominio | repositorio falso + interfaces de dominio falsas |
| Repository impl | caché e invalidación en mutaciones, traducción de errores | datasource falso que puede lanzar |
| Presenters / mappers de response | forma de salida, y que el secreto no aparece | ninguno |
| Rutas (supertest) | códigos de estado del cableado (401/403/400/2xx) | servicio falso inyectado |
| Datasources concretos | no se testean aquí (requieren infraestructura real) | — |

## La regla de comentarios

> Los nombres cargan la explicación. Un comentario solo se justifica si dice algo que el código no
> puede decir por sí mismo.
>
> **Comenta**: invariantes que no se ven en la firma; decisiones de seguridad y su motivo;
> restricciones de orden; comportamiento contraintuitivo de una librería; el motivo de una
> concesión deliberada.
>
> **No comentes**: lo que el nombre ya dice; encabezados de sección; tablas de equivalencia
> didácticas con otras librerías; narración paso a paso de la línea siguiente; código muerto
> comentado — se borra.
>
> Antes de escribir un comentario, intenta primero renombrar o extraer una función privada. Si eso
> lo vuelve innecesario, era un comentario de más.

**Nota**: el proyecto de referencia (`13-ticket-desk`) tiene una densidad de comentarios superior a
esta regla por su origen didáctico. Al leerlo como ejemplo, imita su *estructura*, no su cantidad
de comentarios.

## Checklist de feature nuevo

Orden de creación, de dentro hacia fuera:

1. Entidad (`domain/entities/`) con su `create()`.
2. Puerto de repositorio (`domain/repositories/`).
3. Puerto de datasource (`domain/datasources/`).
4. Servicio (`domain/services/`), recibiendo el repositorio y las interfaces técnicas que necesite.
5. DTOs de request y, si hay secretos, de response (`domain/dtos/`).
6. Datasource concreto + mapper (`infrastructure/data/<tech>/<entidad>/`).
7. Implementación del repositorio (`infrastructure/repositories/<entidad>/`).
8. Controller + presenter (`presentation/http/api/<feature>/`).
9. `routes.ts` del feature (composition root) y montarlo en `api/routes.ts`.
10. Migración de esquema si aplica (ver `references/db-migrations.md` para plantilla y porqué).
11. Tests de la entidad, los DTOs y el servicio (ver "Tests unitarios" arriba).

Un feature no está terminado sin el paso 11, y `npm test`/equivalente debe quedar verde antes de
darlo por hecho — junto con la comprobación real contra el servidor levantado, que los tests no
sustituyen.

## Adaptación a JavaScript plano (sin TypeScript)

La tabla normativa de equivalencias (qué usar en JS por cada contrato de TS) vive en la sección
"Equivalencias en JavaScript plano" del `CLAUDE.md` de cada proyecto — no se repite aquí. Lo que
añade este apartado es el porqué de cada equivalencia:

- `abstract class` con métodos `abstract` → clase ES6 normal cuyos métodos base hacen
  `throw new Error('Method not implemented')`. Las subclases los sobreescriben. El motivo de
  lanzar en vez de dejar el método vacío: un método base vacío que nadie sobreescribe falla en
  silencio (devuelve `undefined` donde se esperaba un array o una entidad); lanzar lo convierte en
  un error inmediato y localizado, la mejor aproximación a lo que TypeScript daría gratis en tiempo
  de compilación.
- Sin tipos de retorno ni `interface` — la validación de forma vive solo en `Entity.create()`
  (lanzando `Error` si falta un campo requerido). `@typedef` de JSDoc documenta la forma para el
  editor, pero no la hace cumplir en runtime — quien hace cumplir sigue siendo `Entity.create()`.
- **Qué se pierde sin compilador**: la garantía de que un servicio no puede devolver
  accidentalmente una entidad con un secreto en vez de su DTO de respuesta — en TS eso lo bloquea el
  tipo de retorno declarado; en JS nada lo impide en tiempo de escritura.
- **Qué lo compensa**: el test del servicio que verifica la forma exacta del objeto devuelto (sin el
  campo secreto) deja de ser "cobertura deseable" y pasa a ser **obligatorio**, no opcional — es la
  única red que queda para ese caso concreto.
- El resto de la estructura de carpetas, la regla de dependencia y el catálogo de patrones aplican
  igual.
