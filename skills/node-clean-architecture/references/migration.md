# Migrar un proyecto legacy hacia este patrón

Cuando el usuario pida mejorar/migrar la arquitectura de un proyecto existente:

1. **Auditar primero, no reescribir a ciegas.** Ubicar dónde vive hoy la lógica de negocio, dónde
   el acceso a datos, y qué tan mezclados están (ej. queries SQL directo en un controlador de
   Express, validación repetida en cada endpoint).

2. **Proponer el plan en plan mode**, nunca una migración "big bang" de todo el proyecto de una
   vez. Migrar **feature por feature**.

3. Por cada feature, en este orden:
   a. Extraer la entidad (`domain/entities/`) a partir del shape de datos actual, con su
      `static create()` validando lo que hoy se valida disperso.
   b. Definir el puerto del repositorio (`domain/repositories/`) con los métodos que el servicio
      de dominio realmente necesita — no copiar métodos de otro proyecto sin verificar que se
      usen.
   c. Definir el puerto del datasource (`domain/datasources/`) y extraer el datasource concreto
      (`infrastructure/data/<tecnología>/<entidad>/` + `infrastructure/repositories/<entidad>/`)
      desde el código de acceso a datos existente.
   d. Mover la composición (armar datasource→repository→service→controller) al composition root
      de ese feature; mantener el entrypoint principal sin conocer detalles de ningún feature
      individual.
   e. Escribir los tests de la entidad y el servicio de ese feature (ver `references/testing.md`)
      antes de pasar al siguiente — son la red de seguridad de la migración, no un paso posterior.

4. **Verificar cada feature end-to-end** (requests reales, no solo que compile) antes de migrar el
   siguiente. Nunca dar por terminada una migración sin correr el código.

5. Si un cambio de seguridad detectado durante la auditoría no toca ninguna firma pública (p. ej.
   `trust proxy`, una validación de longitud en una variable de entorno), arreglarlo junto con la
   migración. Si obliga a cambiar un contrato de dominio (p. ej. un hasher síncrono → asíncrono),
   tratarlo como una migración propia con su propia verificación — no mezclarlo con el resto.

6. Si el proyecto es JavaScript plano, aplicar la sección "Adaptación a JavaScript plano" del
   `SKILL.md` en vez de la sintaxis TypeScript.

7. Al terminar, copiar y adaptar el `CLAUDE.md` de un proyecto de referencia (ver
   `references/bootstrap.md`) en vez de dejar la arquitectura nueva sin documentar en el propio
   repo — así el patrón sobrevive a la sesión que lo migró.

## Señales de que una carpeta o fichero "no encaja" en ninguna capa

- **Vive en `domain/` pero importa `express`, `pg`, `mongodb` o cualquier driver**: no es dominio,
  hay que extraer la parte pura y mover el resto a `infrastructure/`.
- **Vive en `infrastructure/` pero contiene una regla de negocio** (ej. "un ticket no puede
  cerrarse si no fue asignado a un desk"): esa regla pertenece a un servicio de `domain/`, no al
  datasource ni al repository impl.
- **Un controller hace más de: parsear input → llamar al servicio → mapear la salida**: la lógica
  de más pertenece al servicio.
- **Dos datasources de tecnologías distintas duplican la misma validación**: la validación
  pertenece a `Entity.create()`, no a cada mapper.

## Convivencia legacy/nuevo y "feature migrado"

El `CLAUDE.md` de cada proyecto fija el criterio como checklist (§ "Adopción en un proyecto
existente"): lógica de negocio en un servicio de `domain/`, acceso a datos tras un puerto,
composición en el `routes.ts` del feature, endpoint verificado end-to-end, tests en verde. El
porqué de por qué ese criterio y no otro:

- **Convive por diseño, no por accidente**: el código migrado vive en la estructura nueva desde su
  primer feature — no hay una carpeta `src-v2/` ni un directorio "nueva arquitectura" temporal que
  luego haya que fusionar. El legacy simplemente se queda donde estaba hasta que le toca su turno.
  Fusionar árboles de carpetas después es un proyecto de migración en sí mismo, y suele costar más
  que haber migrado bien desde el principio.
- **"Migrado" es binario, no un espectro**: un feature a medio migrar (entidad extraída pero el
  controller todavía hace SQL directo) es peor que no haber empezado, porque dos rutas de acceso al
  mismo dato compiten sin que nadie decida cuál manda. El checklist existe para que "migrado" tenga
  una respuesta verificable, no una sensación.
- **Los tests son la red de seguridad de la migración, no un paso posterior**: escribirlos junto con
  la extracción de cada capa (no al final) es lo que permite migrar sin re-probar manualmente cada
  feature ya migrado en cada iteración siguiente.

## Orden de migración por riesgo

Migrar en el orden equivocado es la manera más común de que una migración legacy se abandone a
medias. Reglas para elegir el siguiente feature:

1. **Empieza por el feature con menos dependencias salientes** (menos llamadas a otros módulos, menos
   tablas compartidas), no por el más grande ni por el más visible para el negocio. Un feature con
   pocas dependencias se puede extraer, probar y dar por terminado en una sesión — construye
   confianza en el patrón antes de atacar algo más entrelazado.
2. **Evita empezar por el feature con más tráfico en producción**, salvo que sea también el más
   simple: el primer feature migrado es el que más probablemente tiene un error de traducción del
   comportamiento legacy (un `if` que nadie documentó, un `NULL` que en realidad significa otra
   cosa). Que ese primer error ocurra en un feature de bajo impacto es preferible.
3. **Dentro de un mismo feature, el orden es siempre el mismo** (entidad → puerto de repositorio →
   puerto de datasource → servicio → DTOs → datasource concreto → repository impl → controller →
   composition root → tests), sea cual sea el feature. El orden entre features es la única decisión
   de riesgo; el orden dentro de un feature no se negocia.

## Legacy en JavaScript

Cuando el proyecto legacy es JavaScript plano (no TypeScript), hay dos migraciones posibles y **nunca
se hacen las dos a la vez en el mismo feature**: si algo se rompe durante la migración, mezclar
ambas hace imposible saber si lo rompió el cambio de arquitectura o el cambio de tipos.

- **Opción A — arquitectura en JS, sin añadir tipos.** Se aplica la sección "Equivalencias en
  JavaScript plano" del `CLAUDE.md` (`abstract class` → clase base que lanza, `interface` → duck
  typing + JSDoc). Es la opción por defecto: separa las dos migraciones y dedica esta sesión solo a
  mover código a la estructura correcta.
- **Opción B — arquitectura ya migrada, tipos después.** Solo cuando la arquitectura de ese feature
  ya está migrada (opción A completa) y se decide adoptar TypeScript: `allowJs` + `checkJs` en
  `tsconfig.json`, fichero a fichero, empezando por `domain/` (que al no depender de ninguna
  librería externa es el más fácil de tipar sin fricción) y terminando por `presentation/`.

## Esquema de BD de un legacy sin migraciones versionadas

Un proyecto legacy típico tiene el esquema aplicado a mano o por un ORM en modo `sync()`, sin
historial. No se puede fingir que el esquema "nace vacío" al adoptar migraciones — eso las volvería
inconsistentes con la BD real en cuanto alguien las aplicara en un entorno nuevo.

La salida es una **migración baseline**: un único fichero de migración que reproduce (mediante
`pg_dump --schema-only` o equivalente, limpiado a mano) el esquema actual completo, y que se marca
como ya aplicada en la tabla de control de la librería de migraciones (`pgmigrations` o la que
corresponda) en cada entorno existente, **sin ejecutarla** en ellos — solo en un entorno nuevo que
arranque desde cero. A partir de esa baseline, toda migración siguiente sigue las reglas normales del
`CLAUDE.md`.

## Errores costosos ya detectados (para no repetirlos)

- Poner un puerto en `infrastructure/` "porque solo lo consume infraestructura" en vez de en
  `domain/` porque es una capacidad que el dominio necesita del mundo exterior. La pregunta
  correcta no es "¿quién lo importa hoy?" sino "¿es una capacidad que el dominio declara
  necesitar?" — ver "Dónde va cada contrato" en el `SKILL.md`.
- Escribir la documentación de la arquitectura solo en una skill que se carga por relevancia, sin
  un `CLAUDE.md` en el repo — la migración queda sin efecto duradero si nadie vuelve a invocar la
  skill. El `CLAUDE.md` se copia junto con el código migrado, no después.
