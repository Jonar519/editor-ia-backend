# Cuaderno: README general

**Cuaderno** es un editor colaborativo de documentación técnica con IA, algo así como un Google Docs simplificado para documentación de software. Es el Proyecto 3 de *Programación orientada a la web*.

Este README general viaja dentro del repo del backend y se va completando bloque a bloque.

## Repositorios

| Repo | Contenido |
|---|---|
| [editor-ia-database](https://github.com/Jonar519/editor-ia-database) | Esquema PostgreSQL 16 + pgvector: migraciones SQL numeradas, pruebas SQL y rol de aplicación. |
| [editor-ia-backend](https://github.com/Jonar519/editor-ia-backend) | API Express + TypeScript y servidor en tiempo real. Prisma solo como cliente. |
| [editor-ia-frontend](https://github.com/Jonar519/editor-ia-frontend) | Interfaz en JavaScript sin framework, con Vite: router por hash, CSS con tokens, Service Worker. |

## Estado por tramo

| Tramo | Bloques | Estado |
|---|---|---|
| 1. Base e identidad (backend) | A–G | Cerrado |
| 2. Frontend de identidad | H1, H2, I, J | Cerrado (confirmado por escrito al cerrar J) |
| 3. Editor colaborativo | K1, K2, L–O | Abierto. ADR [0002](adr/0002-comunicacion.md), [0003](adr/0003-crdt.md) y [0004](adr/0004-motor-de-edicion.md) aceptados. K se divide en K1 (CRUD por REST y migraciones) y K2 (WebSocket, guardia, revocación, persistencia y compactación). |
| 4. IA | P1, P2, P3, Q | Pendiente |
| 5. Cierre | R | Pendiente |

**Sin medir al cierre del tramo 2** (se revisan en la guía consolidada del bloque R): la recodificación del avatar con fotos reales de cámara en Firefox, Safari, y lo que solo cubren las E2E sin mutación (olvidar la sesión después de eliminar la cuenta, el foco en las confirmaciones).

## Puertos locales

| Servicio | Dirección |
|---|---|
| PostgreSQL | `127.0.0.1:5435` |
| Redis | `127.0.0.1:6381` (db 0 desarrollo, 1 pruebas, 2 E2E) |
| API | `127.0.0.1:4200` |
| Frontend | `127.0.0.1:5175` |

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
| MFA TOTP sin librería (RFC 6238/4226) | `src/auth/totp.ts`, vectores del RFC en `totp.test.ts` | Admin: completar la invitación exige el primer código; login en dos pasos | backend: F |
| Secreto MFA cifrado y ligado a la cuenta | AES-256-GCM con la cuenta como datos asociados (`cifrado.ts`) | Mutación G07 | backend: F |
| Anti-replay de códigos | `verificarTotp` + UPDATE condicional + trigger de la base (0016) | Mismo código dos veces: 401; mutaciones G05, G06 y F15 | backend: F, database: F |
| Códigos de respaldo de un solo uso | 10 códigos, en la base solo su HMAC con subclave | Usar el mismo dos veces: 401 | backend: F |
| Recuperación sin enumeración | `src/auth/recuperacion.ts`: responde antes de trabajar | Correo real e inexistente: misma respuesta y mismo tiempo | backend: F |
| Auditoría de seguridad | `eventos_seguridad`: solo inserción, IP truncada, sin texto libre (0015) | Paso 9 de la demo F; mutaciones F08–F14 y G23 | backend: F, database: F |
| Ningún token en logs ni en la base | `secretos.test.ts`: captura de logs + barrido de todas las tablas | Mutaciones G01 y G02 | backend: F |
| Limpieza de metadatos sin dependencias | `src/imagen/limpiar.ts`: lista blanca de segmentos JPEG y chunks PNG | Subir un JPEG con EXIF/GPS y ver que no queda; mutaciones U01–U11 | backend: G |
| Cambio de correo con re-verificación | `src/cuenta/perfil.ts`: enlace al correo nuevo, aviso al anterior | Pasos 3–4 de la demo G; mutaciones U12–U17 | backend: G |
| Sesiones activas y cierre remoto | `GET /api/cuenta/sesiones`, `src/geo` | Cerrar una sesión desde otra y ver el 401 | backend: G |
| Exportación sin secretos | `src/cuenta/datos.ts` | Mutación U26 (barrido de secretos en el JSON) | backend: G |
| Eliminación por lápida sin huérfanos | `eliminar_cuenta()` en la base (0018) | 409 con propiedad compartida; mutaciones G09–G15 y U28–U31 | backend: G, database: G |
| Retención con job agendado | `purgar_retencion()` (0019) + BullMQ (`src/trabajos/retencion.ts`) | [data-retention.md](data-retention.md); mutaciones G16–G20 y U32–U34 | backend: G, database: G |
| Token solo en memoria y un solo refresco a la vez | `src/api/cliente.js` del frontend (promesa compartida + Web Locks) | Pruebas `cliente.test.mjs`; mutaciones H26–H34 | frontend: H2 |
| Significado del color auditado y contraste AA medido | `scripts/colores.mjs` y `scripts/contraste.mjs` del frontend | `scripts\revisar.bat`; mutaciones H01–H13, H40 y H41 | frontend: H1 |
| Presupuestos de peso por rol y por pantalla | `presupuestos.json` + `scripts/presupuestos.mjs` del frontend | `npm run presupuestos`; mutaciones H14–H17, H24, H25 y H64 | frontend: H1, J |
| Service Worker que nunca cachea el API | `src/sw/sw.js` del frontend | `sw.spec.mjs` sin red; mutaciones H35–H39 | frontend: H2 |
| Accesibilidad WCAG 2.1 AA en los dos temas | axe en cada pantalla (Playwright, Chromium y Firefox) | `scripts\e2e.bat` | frontend: H1–J |
| Token de un enlace fuera de la URL antes de usarlo | `src/token-url.js` del frontend | Mutación H42 | frontend: I |
| Recorte del avatar en el cliente, sin metadatos | `src/vistas/lector/foto.js` y `src/reglas-cuenta.js` | E2E: el PNG subido no trae su trozo de texto; mutaciones H51–H53 | frontend: J |
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
- **Primer admin.** Se invita con la CLI de operador (`invitar.bat`), y el enlace va a su correo. Completarlo exige configurar MFA y enviar el primer código (bloque F).
- **MFA.** Obligatorio para admin (la base lo exige), opcional para editor y lector. La inscripción pendiente de un admin vive en `inscripciones_mfa`, vence con la invitación y se borra con ella. El desafío del segundo paso vive en Redis (solo su hash, 5 min, un solo uso). Los fallos de MFA suman al bloqueo de la cuenta.
- **Auditoría.** `eventos_seguridad` guarda cuenta, IP truncada y tipo de evento, nunca tokens ni contraseñas. Retención de 180 días (se aplica en el bloque G). Al eliminar una cuenta se anonimizan sus filas (bloque G).
- **gRPC solo entre servicios internos** (confirmado con el profesor). El navegador habla REST/JSON y WebSocket. El bloque P se divide en P1 (servicio gRPC), P2 (embeddings, búsqueda, inyección y gateway) y P3 (informe REST/JSON vs gRPC), con un job `grpc` aparte en el CI. El ADR de comunicación va en el bloque K.
- **Si hay que recortar tiempo**, LaTeX y Mermaid se recortan primero.
- **Eliminación de cuenta (bloque G).** Se bloquea con 409 mientras la persona sea propietaria de documentos con otros colaboradores sin haber transferido la propiedad. Solo se borran los documentos sin colaboradores.
  - Colaborador es cualquier otro miembro del espacio del documento, porque los documentos no tienen privacidad dentro de su espacio.
  - También da 409 ser propietaria de un espacio con otros miembros: el espacio necesita un propietario.
  - La hace la base en una transacción (`eliminar_cuenta()`). La cuenta queda como lápida y sus eventos de seguridad se anonimizan.
- **Retención.** Detalle en [data-retention.md](data-retention.md):
  - los plazos los fija la base;
  - el job diario de BullMQ (03:15 UTC) corre dentro del proceso del API;
  - la purga de invitaciones vencidas queda propuesta, fuera del alcance de G.
- **Avatar.** Solo JPEG o PNG, 1 MiB y 4096 px como máximo. Se guarda en la base, ya limpio. Se sirve a cualquier sesión válida (presencia, comentarios) con `Content-Security-Policy: default-src 'none'; sandbox`.
- **Acciones sensibles de la cuenta.** Cambiar correo o contraseña, exportar y eliminar exigen la contraseña. Eliminar exige además el código MFA si la cuenta lo tiene. Los fallos suman al mismo bloqueo progresivo que el login.
- **Espacios, documentos y permisos (bloque K1).** Quién puede qué está en un solo lugar (`src/contenido/acceso.ts`). El rol sobre un documento lo calcula la base (`rol_efectivo_documento`).
  - **Sin acceso, 404** (no se distingue de "no existe"). **Con acceso pero sin el rol, 403.**
  - **Espacio:** lo crea una cuenta que no sea de solo lectura. El propietario lo renombra, agrega miembros por correo, cambia roles, quita miembros y lo transfiere. Cualquiera sale, salvo el propietario.
  - **Borrar un espacio** solo si el propietario es el único miembro (si no, 409 `espacio_compartido`).
  - **Documento:** lo crea un editor o el propietario del espacio. Lo renombra un editor efectivo. Lo borran, le dan permisos y lo transfieren solo su propietario.
  - **La propiedad nunca se cambia ni se quita: se transfiere.** El anterior queda como editor.
  - **Quitar a quien posee documentos** del espacio responde 409 `propiedad_documentos` con la lista, como el 409 de eliminar la cuenta.
  - **Un permiso propio solo puede ser "editor"**: el rol efectivo es el mayor, así que "lector" no cambiaría nada.
  - **Agregar miembros** responde 404 genérico si no hay una cuenta **activa** con ese correo, y tiene un límite de 30 por cuenta cada 15 min contra la enumeración de correos.
  - Cada cambio bloquea la fila del espacio o del documento antes de comprobar el rol: dos cambios simultáneos se esperan.
  - **Sin paginar en K1**: las listas de espacios, miembros y documentos devuelven todo. Se pagina si un espacio llega a cientos de documentos.
  - **Sin auditoría de cambios de permisos** en `eventos_seguridad` (sus tipos los fija un CHECK de la base): queda propuesta.
- **Compactación del log Yjs (migración 0021).** El backend ya no borra actualizaciones por su cuenta: solo `compactar_documento()`, que escribe el estado y borra en la misma llamada (ADR 0003). La usa la compactación de K2.
