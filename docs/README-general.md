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
| Pruebas de mutación | `mutations/catalogo.json` en cada repo | `scripts\mutar.bat` | todos |
| CI | `.github/workflows/ci.yml` en cada repo | Pestaña Actions de cada PR | todos |

## Decisiones vigentes

- **Redis sin contraseña en desarrollo.** Solo escucha en `127.0.0.1` y la decisión se reevaluó en el bloque D. En producción, la configuración exige contraseña o TLS.
- **Usuario de base de privilegios mínimos.** El backend se conecta como `cuaderno_app`. Producción se niega a arrancar con un usuario con privilegios de más.
- **Documentos dentro de un espacio.** El rol de espacio da acceso a todos sus documentos. Los documentos privados dentro de un espacio quedan como **mejora futura**.
- **Pruebas de mutación en serie.** Su tiempo en el CI se reevalúa en el bloque R.
- **Eliminación de cuenta (bloque G).** Se bloquea con 409 mientras la persona sea propietaria de documentos con otros colaboradores sin haber transferido la propiedad. Solo se borran los documentos sin colaboradores.
