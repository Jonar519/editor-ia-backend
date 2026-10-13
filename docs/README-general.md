# Cuaderno: README general

**Cuaderno** es un editor colaborativo de documentación técnica con IA, algo así como un Google Docs simplificado para documentación de software. Es el Proyecto 3 de *Programación orientada a la web*.

Este README general viaja dentro del repo del backend y se va completando bloque a bloque.

## Repositorios

| Repo | Contenido |
|---|---|
| [editor-ia-database](https://github.com/Jonar519/editor-ia-database) | Esquema PostgreSQL 16 + pgvector: migraciones SQL numeradas, pruebas SQL y rol de aplicación. |
| [editor-ia-backend](https://github.com/Jonar519/editor-ia-backend) | API Express + TypeScript y servidor en tiempo real. Prisma solo como cliente. |
| [editor-ia-frontend](https://github.com/Jonar519/editor-ia-frontend) | Interfaz en JavaScript sin framework, con Vite (pendiente, tramo 2). |

## Puertos locales

| Servicio | Dirección |
|---|---|
| PostgreSQL | `127.0.0.1:5435` |
| Redis | `127.0.0.1:6381` (db 0 desarrollo, 1 pruebas, 2 E2E) |
| API | `127.0.0.1:4200` |
| Frontend | `127.0.0.1:5175` (pendiente) |

## Cómo demostrar cada tema de la materia

La tabla crece con cada bloque. **Demo** indica el archivo `docs/demo-<fase>.md` del repo correspondiente, con los pasos exactos para cmd.exe.

| Tema | Dónde está | Cómo demostrarlo | Demo |
|---|---|---|---|
| Modelo de datos relacional con integridad en la base | `editor-ia-database/migrations` | Pruebas SQL que intentan violar cada regla y mutaciones que la quitan | database: A, B, C |
| Seguridad desde el diseño: cuenta pendiente sin sesiones ni tokens | CHECK + clave foránea compuesta (0003–0006) | `scripts\mutar.bat B01 ... B10` en el repo de base | database: B |
| Historial a prueba de manipulación | `versiones`: solo inserción y cadena de hash (0010) | Bloque psql de la demo C y mutaciones C01–C08 | database: C |
| Aislamiento de datos para la IA | trigger + clave foránea compuesta + búsqueda filtrada (0011) | Mutaciones C19–C23 | database: C |
| Privilegios mínimos | rol `cuaderno_app` (0012) y verificación al arrancar | Pruebas SQL 0012; arrancar en producción con el usuario dueño y ver que se niega | database: D, backend: D |
| Configuración validada y segura por defecto | `src/config/entorno.ts` (zod) | Arrancar en producción con proveedores mock y ver que se niega | backend: D |
| Observabilidad | `/health`, `/ready`, `/metrics`, logs pino con redacción | Pasos 3–5 de la demo D | backend: D |
| Apagado ordenado | `src/apagado.ts` | SIGTERM real en el contenedor Linux (demo D, paso 7) | backend: D |
| Documentación de API generada | `docs/openapi.json` desde zod | `npm run openapi:check` | backend: D |
| Alta solo por invitación (el que invita no ve el enlace) | `src/invitaciones`, CLI `invitar.bat` + `buzon.bat` | Invitar, leer el buzón y completar | backend: E |
| Sesión: access 15 min en memoria + refresh rotativo | `src/auth`, [ADR 0001](adr/0001-sesion.md) | Refrescar, reutilizar el viejo y ver la familia revocada | backend: E |
| Sesión viva en cada petición | `requiereSesion` | Cerrar sesión y usar el access token viejo: 401 | backend: E |
| Bloqueo progresivo sin enumeración de cuentas | `src/auth/servicio.ts`, `limites.ts` | 5 fallos con un correo real y con uno inexistente: mismo 429 | backend: E |
| Límites de intentos con Redis (fallan cerrado) | `limitarTasa` | Prueba `limites.test.ts`; mutación E18 | backend: E |
| Pruebas de mutación | `mutations/catalogo.json` en cada repo | `scripts\mutar.bat` | todos |
| CI | `.github/workflows/ci.yml` en cada repo | Pestaña Actions de cada PR | todos |

## ⚠️ Antes del despliegue (AWS): paso obligatorio

**Todos los secretos de desarrollo se regeneran. Ninguno viaja a producción.** Son los de los `.env` locales, que se crearon con `env-init`:

| Secreto | Repo | Cómo regenerarlo |
|---|---|---|
| `PGPASSWORD` (dueño de las tablas) | editor-ia-database | Uno nuevo y aleatorio en el gestor de secretos de AWS |
| `CUADERNO_APP_PASSWORD` (rol `cuaderno_app`) | editor-ia-database / `DATABASE_URL` del backend | Uno nuevo; `ALTER ROLE cuaderno_app PASSWORD ...` en la base de producción |
| `MFA_ENCRYPTION_KEY` | editor-ia-backend | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `ACCESS_TOKEN_SECRET` | editor-ia-backend | El mismo comando (32 bytes en base64) |
| `METRICS_TOKEN` | editor-ia-backend | `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| Contraseña de Redis (producción la exige) | infraestructura | Una nueva, o TLS (`rediss://`) |

Además, producción se niega a arrancar si:

- algún proveedor está en `mock`;
- falta `METRICS_TOKEN`;
- Redis no tiene contraseña ni TLS;
- `APP_URL` no es `https://`;
- `COOKIE_SECURE` no es `true`;
- `PASSWORD_HASH_COST` es menor que 15;
- el usuario de base tiene privilegios de más.

`MFA_ENCRYPTION_KEY` se genera **una vez** para producción y no se cambia después: si cambia, los MFA ya configurados dejan de poder verificarse.

## Decisiones vigentes

- **Redis sin contraseña en desarrollo.** Solo escucha en `127.0.0.1` y la decisión se reevaluó en el bloque D. En producción, la configuración exige contraseña o TLS.
- **Usuario de base de privilegios mínimos.** El backend se conecta como `cuaderno_app`. Producción se niega a arrancar con un usuario con privilegios de más.
- **Documentos dentro de un espacio.** El rol de espacio da acceso a todos sus documentos. Los documentos privados dentro de un espacio quedan como **mejora futura**.
- **Pruebas de mutación en serie.** Su tiempo en el CI se reevalúa en el bloque R.
- **Versiones fijadas por compatibilidad.** TypeScript 6.0.3 en el backend (por `typescript-eslint`) y Prisma 7.10.0 (`latest` es una versión candidata). `overrides` de `deepmerge-ts` y `mysql2` por vulnerabilidades del CLI de Prisma.
- **Dos contraseñas en el `.env` del repo de base.** `PGPASSWORD` es del dueño de las tablas (migraciones y pruebas). `CUADERNO_APP_PASSWORD` es del rol del backend.
- **Primer admin.** Se invita con la CLI de operador (`invitar.bat`), y el enlace va a su correo. Completarlo exige MFA, que llega en el bloque F.
- **Eliminación de cuenta (bloque G).** Se bloquea con 409 mientras la persona sea propietaria de documentos con otros colaboradores sin haber transferido la propiedad. Solo se borran los documentos sin colaboradores.
