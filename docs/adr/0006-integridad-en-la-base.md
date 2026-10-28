# ADR 0006 · La integridad vive en la base: el API es la primera línea y PostgreSQL la última

- **Estado:** aceptada. Aplicada desde el bloque A (migraciones 0001–0023); este ADR la formaliza al cierre (R6).
- **Fecha:** 2026-10-27
- **Dónde está:** [editor-ia-database](https://github.com/Jonar519/editor-ia-database). Cada regla, con dónde se aplica, su prueba y su mutación, está en su [modelo de dominio](https://github.com/Jonar519/editor-ia-database/blob/main/docs/modelo-dominio.md).
- **Relacionados:** [ADR 0001](0001-sesion.md) (sesión viva en la base), [ADR 0003](0003-crdt.md) (`compactar_documento`), [modelo de amenazas](../modelo-amenazas.md) (D1, PostgreSQL).

## Contexto

- **Las reglas que importan son de estado:**
  - una cuenta pendiente no tiene sesiones;
  - un admin activo tiene MFA;
  - todo documento tiene exactamente un propietario;
  - un lector nunca escribe;
  - el historial no se reescribe;
  - la IA no indexa lo que no se puede leer.
- **Si solo las aplicara el API,** bastaría un error del backend, una carrera entre dos pedidos o un cambio por SQL directo para dejar la base en un estado imposible. Y nadie se daría cuenta.
- **Hay varios escritores:**
  - el API;
  - el servidor de tiempo real (en el mismo proceso, por otro camino);
  - los trabajos de BullMQ;
  - las CLI de operador;
  - en el futuro, otro cliente.
- **Prisma se usa solo como cliente** (`prisma db pull`): el esquema lo definen las migraciones SQL, no un ORM.

## Decisión

**Cada regla de estado se aplica en PostgreSQL**, con el mecanismo más simple que alcance:

1. **Restricciones:** `CHECK`, claves foráneas (también **compuestas**), `UNIQUE` y `EXCLUDE`. La clave foránea compuesta `(usuario_id, estado_usuario) → usuarios (id, estado)`, junto con un `CHECK` sobre `estado_usuario`, ata una fila al **estado actual** de su cuenta.
2. **Triggers y funciones:** las reglas que miran otras filas, como el rol efectivo, la cadena de hash y las transiciones de estado. Las que valen «al terminar la transacción» son *constraint triggers* **diferidos al `COMMIT`**: un propietario por espacio y por documento, y un admin con MFA.
3. **Rol de la aplicación:** el backend se conecta como `cuaderno_app`, con privilegios mínimos por tabla y por columna. Lo que no debe hacer, como reescribir versiones, borrar actualizaciones Yjs o vaciar tablas, no puede hacerlo **aunque lo intente**, ni aunque falte el trigger.
4. **Funciones con privilegios acotados** para lo que la app sí tiene que hacer pero de forma controlada:
   - `compactar_documento` es `SECURITY DEFINER`, con `search_path` fijo y sin PUBLIC;
   - `eliminar_cuenta` hace todo en una llamada y responde `CU409` si hay propiedad compartida;
   - `purgar_retencion` mide los plazos con el reloj de la base.
5. **El tiempo lo fija la base:** `creado_en` y los vencimientos se calculan con su reloj. Los plazos solo se acortan.

**El API sigue validando primero** (zod, `src/contenido/acceso.ts`), para dar el código HTTP y el mensaje correctos:
- **Si el API ya negó, la base no llega a ver el pedido.** Si la base rechaza algo que el API dejó pasar, es un error del API o una carrera.
- **Errores de la base que el backend traduce:**
  - `CU409` de `eliminar_cuenta`: 409 con la lista;
  - `42501` del trigger de escritura en el tiempo real: dispara la revalidación inmediata (riesgo R-01).
- **Las demás violaciones** responden 500 genérico (sin filtrar el mensaje) y quedan en el log.

**Cómo se prueba cada regla:**
- una prueba SQL que intenta violarla (`tests/sql/`, cada caso termina en `ROLLBACK`);
- una mutación que la quita y exige que esa prueba falle;
- las carreras se prueban con transacciones reales en `tests/integracion/`.

**Despliegue: base primero.** Una migración nueva no puede romper al backend que ya está corriendo. Por eso, por ejemplo, la `buscar_fragmentos` de 4 parámetros se conserva mientras algún backend la llame.

## Alternativas

Las dos primeras se descartaron al diseñar el esquema (bloque A). Las de procedimientos almacenados y RLS se escriben **al cierre**: no se discutieron por escrito antes, y quedan para confirmar.

| Alternativa | Por qué no |
|---|---|
| **Solo en el API** (la base como almacén) | Lo de arriba: un error, una carrera o un SQL directo dejan estados imposibles. Además la regla queda repartida entre el API, el tiempo real y los trabajos. |
| **Esquema y reglas desde un ORM** (`prisma migrate`, validaciones del modelo) | El ORM no expresa claves foráneas compuestas contra el estado, triggers diferidos, `EXCLUDE` parciales, privilegios por columna ni funciones `SECURITY DEFINER`. Y sus validaciones viven en el proceso, no en la base. |
| **Toda la lógica en procedimientos almacenados** | Se usó solo donde hacía falta atomicidad o privilegios propios (las cuatro funciones de arriba). El resto queda en el API, donde se prueba y se lee mejor. |
| **Row Level Security (RLS)** para el acceso por rol | El rol efectivo ya se calcula en la base y lo exigen los triggers de escritura, comentario, presencia e indexado. RLS en las lecturas obligaría a pasar la cuenta en cada conexión del pool (`SET` por transacción). Las lecturas las filtra el API, con el mismo rol efectivo. No se descarta para el futuro. |

## Consecuencias

- **Más SQL que mantener y revisar:** 23 migraciones y 198 casos SQL. Una regla que se redefine (por ejemplo, `purgar_retencion` en 0019, 0020 y 0023) exige que su mutación apunte a la definición vigente; si no, sobrevive sin que nada falle.
- **Algunas reglas no tienen mutación detectable,** como el `FOR UPDATE` de `eliminar_cuenta` (una carrera entre dos conexiones). Se declaran en el modelo de dominio.
- **El dueño de las tablas no puede ser superusuario en producción:** `compactar_documento` corre con sus privilegios (README general).
- **Lo que la base no puede saber queda en el API:**
  - el ritmo (límites y bloqueo progresivo);
  - el contenido de Yjs (la compactación lo verifica el backend antes de llamar);
  - reglas de interfaz, como quién edita un comentario.

  Está listado en el modelo de dominio.

## Estado de verificación al cierre (R6)

**Verificado en el CI de la base, en Windows y en Linux** (R5, rama `feat/cierre-r` de editor-ia-database; Linux en el contenedor de Playwright con pgvector:pg16):
- 198 casos SQL pasan, 0 fallan;
- 74 pruebas de Vitest pasan, con la integración contra Postgres real;
- mutaciones: **170 detectadas**, 0 sobreviven y 3 equivalentes declaradas (C29, F04 y K10).

**Verificado en el backend:**
- `prisma:check`: el esquema de Prisma coincide con la base de pruebas;
- producción aborta si el usuario de base tiene privilegios de más (back S22–S24);
- `/ready` falla si el esquema está por detrás del mínimo (back S25, S29);
- la verificación de la cadena detecta una versión manipulada por el dueño de la base (back R01–R03, con prueba de integración).

**Sin prueba propia:** las restricciones de tamaño (`actualizaciones_tamano`, `documentos_estado_tamano` y `versiones_estado_tamano`) y el `FOR UPDATE` de `eliminar_cuenta`. Detalle en el modelo de dominio.
