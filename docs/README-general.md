# Cuaderno: README general

**Cuaderno** es un editor colaborativo de documentación técnica con IA, algo así como un Google Docs simplificado para documentación de software. Es el Proyecto 3 de *Programación orientada a la web*.

Este README general viaja dentro del repo del backend. Reúne el estado de los tres repos, cómo demostrar cada tema de la materia y las decisiones vigentes.

## Repositorios

| Repo | Contenido |
|---|---|
| [editor-ia-database](https://github.com/Jonar519/editor-ia-database) | Esquema PostgreSQL 16 + pgvector: 23 migraciones SQL numeradas, pruebas SQL, rol de aplicación y [modelo de dominio](https://github.com/Jonar519/editor-ia-database/blob/main/docs/modelo-dominio.md). |
| [editor-ia-backend](https://github.com/Jonar519/editor-ia-backend) | API Express + TypeScript, servidor en tiempo real (WebSocket + Yjs) y servicio de IA por gRPC. Prisma solo como cliente. |
| [editor-ia-frontend](https://github.com/Jonar519/editor-ia-frontend) | Interfaz en JavaScript sin framework, con Vite: router por hash, editor CodeMirror 6 + Yjs, CSS con tokens, Service Worker. |

## Estado por tramo

| Tramo | Bloques | Estado |
|---|---|---|
| 1. Base e identidad (backend) | A–G | Cerrado |
| 2. Frontend de identidad | H1, H2, I, J | Cerrado (confirmado por escrito al cerrar J) |
| 3. Editor colaborativo | K1, K2, L, M, N, O | Cerrado. ADR [0002](adr/0002-comunicacion.md), [0003](adr/0003-crdt.md) y [0004](adr/0004-motor-de-edicion.md). |
| 4. IA | P1, P2, P3, Q | Cerrado. IA con proveedor simulado: **sin IA real** en el proyecto. |
| 5. Cierre | R1–R11 | En curso. Hechos: R1–R8. Faltan R9 (guía de demostración consolidada), R10 (lista de revisión) y R11 (fechas de dependencias: 2-11 y 5-11-2026). |

**Sin despliegue.** Todo corre en local. Lo que exige el despliegue está en «Antes del despliegue», más abajo.

**Sin medir al cierre del tramo 2** (se revisan en la lista de revisión de R10, [revision-bloque-R.md](https://github.com/Jonar519/editor-ia-frontend/blob/main/docs/revision-bloque-R.md) del frontend): la recodificación del avatar con fotos reales de cámara en Firefox, Safari, y lo que solo cubren las E2E sin mutación (olvidar la sesión después de eliminar la cuenta, el foco en las confirmaciones).

## Puertos locales

| Servicio | Dirección |
|---|---|
| PostgreSQL | `127.0.0.1:5435` |
| Redis | `127.0.0.1:6381` (db 0 desarrollo, 1 pruebas, 2 E2E y carga) |
| API | `127.0.0.1:4200` |
| Servicio de IA (gRPC) | `127.0.0.1:4210` |
| Frontend | `127.0.0.1:5175` |

## Cómo demostrar cada tema de la materia

- **Demo** indica el archivo `docs/demo-<bloque>.md` del repo correspondiente, con los pasos exactos para cmd.exe.
- **R9** indica la guía de demostración consolidada del bloque R9, **todavía sin escribir**. Hasta entonces, la columna «Cómo demostrarlo» dice qué prueba, script o informe lo muestra.
- Las mutaciones se corren con `scripts\mutar.bat <id>...` en el repo que se indica («back», «front», «base»). Cada una rompe la regla a propósito y alguna prueba tiene que fallar.

### Tramo 1: base e identidad (A–G)

| Bloque | Tema | Dónde está | Cómo demostrarlo | Demo |
|---|---|---|---|---|
| A | Migraciones SQL numeradas, con checksum, que no se editan | `editor-ia-database/migrations`, `scripts/migrate.mjs` | Editar una migración aplicada y ver que `db-migrate` se niega; pruebas que solo tocan bases `*_test` | base: A |
| A | Pruebas SQL con SQLSTATE exacto | `tests/sql/*.test.sql` del repo de base | `scripts\db-test.bat`; mutaciones base A01–A21 | base: A |
| B | Seguridad desde el diseño: cuenta pendiente sin sesiones ni tokens | CHECK + clave foránea compuesta (0003–0006) | Mutaciones base B01–B41 | base: B |
| C | Historial a prueba de manipulación | `versiones`: solo inserción y cadena de hash (0010) | Bloque psql de la demo C; mutaciones base C01–C08 | base: C |
| C | Aislamiento de datos para la IA | trigger + clave foránea compuesta + búsqueda filtrada (0011, 0023) | Mutaciones base C19–C23 y P04 | base: C |
| D | Privilegios mínimos | rol `cuaderno_app` (0012) y verificación al arrancar | Pruebas SQL 0012; arrancar en producción con el usuario dueño y ver que se niega; mutaciones base D01–D04 y back S22–S24 | back: D (pasos 1 y 6) |
| D | Configuración validada y segura por defecto | `src/config/entorno.ts` (zod) | Arrancar en producción con proveedores mock y ver que se niega; mutaciones back S01–S04 | back: D |
| D | Observabilidad | `/health`, `/ready`, `/metrics`, logs pino con redacción | Pasos 3–5 de la demo D; mutaciones back S05–S09, S12–S13 y S18 | back: D |
| D | Apagado ordenado | `src/apagado.ts` | SIGTERM real en el contenedor Linux (`scripts\demo-linux.bat sigterm`); mutaciones back S19–S21 | back: D (paso 6) |
| D | Documentación de API generada | `docs/openapi.json` desde zod | `npm run openapi:check` | back: D |
| E | Alta solo por invitación (el que invita no ve el enlace) | `src/invitaciones`, CLI `invitar.bat` + `buzon.bat` | Invitar, leer el buzón y completar | back: E |
| E | Sesión: access 15 min en memoria + refresh rotativo | `src/auth`, [ADR 0001](adr/0001-sesion.md) | Refrescar, reutilizar el viejo y ver la familia revocada | back: E |
| E | Sesión viva en cada petición | `requiereSesion` | Cerrar sesión y usar el access token viejo: 401 | back: E |
| E | Bloqueo progresivo sin enumeración de cuentas | `src/auth/servicio.ts`, `limites.ts` | 5 fallos con un correo real y con uno inexistente: mismo 429 | back: E |
| E | Límites de intentos con Redis (fallan cerrado) | `limitarTasa` | Prueba `limites.test.ts`; mutación back E18 | back: E |
| F | MFA TOTP sin librería (RFC 6238/4226) | `src/auth/totp.ts`, vectores del RFC en `totp.test.ts` | Admin: completar la invitación exige el primer código; login en dos pasos | back: F |
| F | Secreto MFA cifrado y ligado a la cuenta | AES-256-GCM con la cuenta como datos asociados (`cifrado.ts`) | Mutación back G07 | back: F |
| F | Anti-replay de códigos | `verificarTotp` + UPDATE condicional + trigger de la base (0016) | Mismo código dos veces: 401; mutaciones back G05 y G06, base F15 | back: F |
| F | Códigos de respaldo de un solo uso | 10 códigos, en la base solo su HMAC con subclave | Usar el mismo dos veces: 401 | back: F |
| F | Recuperación sin enumeración | `src/auth/recuperacion.ts`: responde antes de trabajar | Correo real e inexistente: misma respuesta y mismo tiempo | back: F |
| F | Auditoría de seguridad | `eventos_seguridad`: solo inserción, IP truncada, sin texto libre (0015) | Paso 9 de la demo F; mutaciones base F08–F14 y back G23 | back: F |
| F | Ningún token en logs ni en la base | `secretos.test.ts`: captura de logs + barrido de todas las tablas | Mutaciones back G01 y G02 | back: F |
| G | Limpieza de metadatos sin dependencias | `src/imagen/limpiar.ts`: lista blanca de segmentos JPEG y chunks PNG | Subir un JPEG con EXIF/GPS y ver que no queda; mutaciones back U01–U11 | back: G |
| G | Cambio de correo con re-verificación | `src/cuenta/perfil.ts`: enlace al correo nuevo, aviso al anterior | Pasos 3–4 de la demo G; mutaciones back U12–U17 | back: G |
| G | Sesiones activas y cierre remoto | `GET /api/cuenta/sesiones`, `src/geo` | Cerrar una sesión desde otra y ver el 401 | back: G |
| G | Exportación sin secretos | `src/cuenta/datos.ts` | Mutación back U26 (barrido de secretos en el JSON) | back: G |
| G | Eliminación por lápida sin huérfanos | `eliminar_cuenta()` en la base (0018) | 409 con propiedad compartida; mutaciones base G09–G15 y back U28–U31 | back: G |
| G | Retención con job agendado | `purgar_retencion()` (0019, 0023) + BullMQ (`src/trabajos/retencion.ts`) | [data-retention.md](data-retention.md); mutaciones base G16–G20 y back U32–U34 | back: G |

### Tramo 2: frontend de identidad (H1–J)

| Bloque | Tema | Dónde está | Cómo demostrarlo | Demo |
|---|---|---|---|---|
| H1 | Router por hash con carga bajo demanda por rol | `src/rutas.js` y `src/router.js` del frontend | Una persona lectora nunca descarga el editor ni la administración (`npm run presupuestos`) | front: H1 |
| H1 | Significado del color auditado y contraste AA medido | `scripts/colores.mjs` y `scripts/contraste.mjs` del frontend | `scripts\revisar.bat`; mutaciones front H01–H13, H40 y H41 | front: H1 |
| H1 | Presupuestos de peso por rol y por pantalla | `presupuestos.json` + `scripts/presupuestos.mjs` del frontend | `npm run presupuestos`; mutaciones front H14–H17, H24, H25 y H64 | front: H1, J |
| H2 | Token solo en memoria y un solo refresco a la vez | `src/api/cliente.js` del frontend (promesa compartida + Web Locks) | Pruebas `cliente.test.mjs`; mutaciones front H26–H34 | front: H2 |
| H2 | Service Worker que nunca cachea el API | `src/sw/sw.js` del frontend, [ADR 0007](adr/0007-sin-conexion.md) | `sw.spec.mjs` sin red; mutaciones front H35–H39 | front: H2 |
| H2 | Fuentes autoalojadas por subconjunto | `@fontsource-variable` con `unicode-range` | Pestaña Red: solo los subconjuntos usados, del mismo origen | front: H2 |
| H1–J | Accesibilidad WCAG 2.1 AA en los dos temas | axe en cada pantalla (Playwright, Chromium y Firefox) | `scripts\e2e.bat` | front: H1–J |
| I | Token de un enlace fuera de la URL antes de usarlo | `src/token-url.js` del frontend | Mutación front H42 | front: I |
| I | Entrada en dos pasos y recuperación desde la interfaz | `src/vistas/publico/` | Completar una invitación de admin con MFA y volver a entrar | front: I |
| J | Recorte del avatar en el cliente, sin metadatos | `src/vistas/lector/foto.js` y `src/reglas-cuenta.js` | E2E: el PNG subido no trae su trozo de texto; mutaciones front H51–H53 | front: J |
| J | Administración sin ver nunca el enlace de invitación | `src/vistas/admin/panel.js` | Invitar desde `#/admin` y comprobar que el enlace solo llega al buzón | front: J |

### Tramo 3: editor colaborativo (K1–O)

| Bloque | Tema | Dónde está | Cómo demostrarlo | Demo |
|---|---|---|---|---|
| K1 | Espacios, documentos y permisos: sin acceso 404, sin el rol 403 | `src/contenido/acceso.ts`; rol efectivo de la base (`rol_efectivo_documento`, 0009) | Pasos 2–4 de la demo K1; mutaciones back W01–W21 | back: K1 |
| K1 | Compactación del log Yjs que la app no puede saltarse | `compactar_documento()` (0021, `SECURITY DEFINER` con `search_path` fijo) | Paso 5 de la demo K1; mutaciones base K01–K12 | back: K1 |
| K2 | WebSocket con ticket de un solo uso en el subprotocolo (nunca en la URL) y Origin comprobado | `src/tiempo-real/`; [protocolo-tiempo-real.md](protocolo-tiempo-real.md) | `tiempo-real.test.ts`; mutaciones back T02 y T03 | R9 |
| K2 | Guardia de permiso en cada mensaje | `src/tiempo-real/servidor.ts` | Un lector que manda una actualización: se descarta, y a la tercera, cierre 4403; mutaciones back T01 y T08 | R9 |
| K2 | Revocación en vivo por avisos de la base | `NOTIFY cuaderno_permisos` (0022) → Redis → conexiones | Quitar a un miembro con el documento abierto: se corta (medido 8–19 ms); mutaciones back T04–T06, base K13–K15 | R9 |
| K2 | Auditoría de concesiones y revocaciones | `eventos_seguridad` con `objetivo_id` y `recurso_id` (0022) | `auditoria.test.ts`; mutaciones base K16 y K17 | R9 |
| L | Editor colaborativo CodeMirror 6 + Yjs, deshacer solo lo propio, Tab que no atrapa el foco | `src/vistas/editor/editar.js` del frontend, [ADR 0004](adr/0004-motor-de-edicion.md) | E2E `editor.spec.mjs`: dos personas a la vez, el mismo texto | R9 |
| L | Presencia con la identidad del servidor, no la del cliente | `src/tiempo-real/presencia.js` del frontend y el servidor | Un cliente que manda otro nombre o un color con CSS: no llega al DOM; mutaciones back T07 y T09, front L01–L03 | R9 |
| L | Colores de presencia con contraste medido | 6 tokens `--color-presencia-N`, nunca violeta | `npm run contraste` del frontend | R9 |
| M | Convergencia del CRDT contra el servidor y la base reales | `tests/integracion/convergencia.test.ts` (con semilla: réplicas, cortes, duplicados y compactación) | La prueba con su semilla; mutación back M01 (el fallo que encontró) | R9 |
| M | Trabajo sin conexión con copia local | `src/tiempo-real/almacen-local.js` (IndexedDB), [ADR 0007](adr/0007-sin-conexion.md) | E2E `editor.spec.mjs`: sin red, cerrar la página y volver; mutaciones front M01–M04 | R9 |
| N | Versiones con restauración como cambio nuevo | `src/versiones/` del backend (diff por líneas y por caracteres) | E2E `versiones-comentarios.spec.mjs`; mutaciones back N01–N11 | R9 |
| N | Comparación de versiones en un Web Worker | `src/diff/` del frontend (Myers) | Comparar dos versiones grandes sin congelar la página | R9 |
| N | Comentarios anclados con posiciones relativas de Yjs | `src/comentarios/anclas.js` del frontend | Escribir antes del tramo comentado y ver que el ancla lo sigue; mutaciones front N01 y N02 | R9 |
| O | Vista renderizada sin HTML, con dos capas de lista blanca | `src/markdown/vista.js` del frontend | Batería XSS unitaria y E2E `markdown.spec.mjs`; mutaciones front O01–O04 | R9 |
| O | Atajos, menú «/» y paleta Ctrl+K accesibles | `src/vistas/editor/comandos.js` y `paleta.js` del frontend | Usar el editor solo con el teclado; mutación front O05 (un bloque insertado no se pega al párrafo) | R9 |
| O | KaTeX y resaltado bajo demanda, con tope | `src/diferidas/` del frontend | `npm run presupuestos` (KaTeX 74,94 de 75 KiB) | R9 |
| O | Comentar desde la vista renderizada | `src/comentarios/posiciones.js` del frontend | E2E `anclaje-renderizado.spec.mjs`; mutaciones front O06–O08 | R9 |

### Tramo 4: IA (P1–Q)

| Bloque | Tema | Dónde está | Cómo demostrarlo | Demo |
|---|---|---|---|---|
| P1 | **gRPC** entre el API y el servicio de IA, con los cuatro tipos de llamada | `proto/cuaderno/ia/v1/ia.proto`, `src/ia/`, [ADR 0002](adr/0002-comunicacion.md): unaria (`Explicar`), del servidor (`Resumir`, `Mejorar`), del cliente (`IndexarDocumento`) y bidireccional (`Autocompletar`) | `ia-grpc.test.ts`; `scripts\ia.bat` y el API arriba | R9 |
| P1 | Token entre servicios, deadlines, cancelación y salud estándar | Interceptor del servicio; `grpc.health.v1` | Mutaciones back P01–P06 y P10–P14 | R9 |
| P1 | Contrato versionado que no se rompe sin querer | `buf lint` y `buf breaking` contra `main` (`npm run proto:check`, en el job `verificar` del CI) | Mutación back P27 | R9 |
| P2 | Búsqueda semántica aislada por espacio y por el acceso de hoy | `buscar_fragmentos` (0023) y `src/ia/` | `ia-p2.test.ts`; mutaciones back P19, P21 y P31–P34, base P01–P04 | R9 |
| P2 | Prompts armados contra la inyección | `src/ia/prompt.ts`: contenido escapado en un bloque con nonce, salida recortada | `ia-prompt.test.ts`; mutaciones back P28–P30 y P40–P43; riesgo R-04 | R9 |
| P2 | Topes de IA por cuenta y presupuesto de indexado por espacio | `uso_ia_diario`, `uso_ia_indexado_diario` (0023) | Mutaciones back P15, P16 y P35–P39, base P08–P10 | R9 |
| P3 | **Medición** gRPC frente a REST/JSON (HTTP/1.1 y h2c) | `scripts/medicion/`, [medicion-p3.md](medicion-p3.md) | `scripts\medir.bat --rapido` (no mide con más del 10 % de CPU ocupada); el informe abre con lo que no permite concluir | R9 |
| Q | Asistente de IA en la interfaz: Mejorar nunca se aplica solo | `src/diferidas/ia.js` del frontend | E2E `ia.spec.mjs`; mutaciones front Q01–Q07 | R9 |
| Q | Sugerencias mientras se escribe, por el WebSocket | `src/diferidas/ia-autocompletado.js` del frontend; `ia.autocompletar` en el protocolo | `ia-autocompletado.test.ts` del backend; mutaciones front Q08–Q14, back P06 y P23 | R9 |
| Q | IA bajo demanda: quien lee no descarga CodeMirror | Diferidas con tope de 25 KiB cada una | `npm run presupuestos`; mutaciones front Q15–Q17 | R9 |

### Tramo 5: cierre (R)

| Bloque | Tema | Dónde está | Cómo demostrarlo | Demo |
|---|---|---|---|---|
| R1 | Verificar la cadena de versiones desde la interfaz | `GET /api/documentos/{id}/versiones/verificacion`; el historial del frontend | Prueba de integración que altera una versión con el dueño de la base; mutaciones back R01–R03, front R01 y R02 | R9 |
| R2 | CSP estricta en el build | `scripts/lib/csp.mjs` del frontend | E2E `csp.spec.mjs` (un script en línea no corre); mutaciones front R03–R06; riesgo R-06 | R9 |
| R3 | **Carga** HTTP y WebSocket contra el API real | `scripts/carga/`, [carga-r.md](carga-r.md) | `scripts\carga.bat --rapido` y `scripts\carga-linux.bat --rapido` (base y Redis de pruebas; no mide con más del 10 % de CPU); mutaciones back R04–R06 | R9 |
| R4 | **Modelo de amenazas** STRIDE con riesgos residuales medidos | [modelo-amenazas.md](modelo-amenazas.md): diagrama de flujo de datos, análisis por elemento y R-01–R-07 | Cada riesgo residual dice su evidencia; R-01 medido con `tiempo-real.test.ts` | R9 |
| R4 | Abuso de almacenamiento por versiones (R-02) | `scripts/carga/medir-almacenamiento.ts`, [almacenamiento-r.md](almacenamiento-r.md) | `scripts\almacenamiento.bat --rapido`; mutación back R07 | R9 |
| R4 | **Límite general** de 600 pedidos por minuto y cuenta (R-07) | `limiteGeneral` en `src/auth/limites.ts` | `limite-general.test.ts` (con el límite agotado, `/health` responde y el WebSocket sigue); mutaciones back R08–R10; costo medido en [limite-r/carga-r.md](limite-r/carga-r.md) | R9 |
| R4 | Cuerpos comprimidos rechazados sin descomprimir | `inflate: false` en `express.json()` y `express.raw()` | 415 `codificacion_no_admitida`; mutaciones back B01–B03; riesgo R-05 | R9 |
| R5 | Modelo de dominio: cada regla con su prueba y su mutación | [modelo-dominio.md](https://github.com/Jonar519/editor-ia-database/blob/main/docs/modelo-dominio.md) del repo de base | Elegir una regla de la tabla y correr su mutación | R9 |
| R6 | Decisiones de arquitectura con su estado de verificación | [ADR 0001–0008](adr/) | Cada ADR separa lo verificado de lo que no tiene prueba propia | — |
| R7 | OpenAPI revisado ruta por ruta y protocolo de tiempo real | `src/openapi.ts`, [openapi.json](openapi.json), [protocolo-tiempo-real.md](protocolo-tiempo-real.md) | `openapi.test.ts` (toda ruta de Express documentada; 429 con `Retry-After` y 503 en todo `/api`); mutaciones back R11–R13 | R9 |

### En todos los repos

| Tema | Dónde está | Cómo demostrarlo | Demo |
|---|---|---|---|
| Pruebas de mutación | `mutations/catalogo.json` en cada repo; al cierre de R8: base 173, back 226 (2 equivalentes), front 105 | `scripts\mutar.bat` | todas |
| CI con los mismos pasos en local | `.github/workflows/ci.yml` y `scripts\ci.bat` en cada repo | Pestaña Actions de cada PR; `scripts\ci.bat` muestra el código de salida real de cada paso | todas |
| Dependencias: versiones exactas, 14 días de publicadas y `npm audit` | [ADR 0008](adr/0008-dependencias.md) | `npm audit --audit-level=high` en el CI | — |
| Ningún secreto en los repos públicos | gitleaks sobre todo el historial (`scripts\gitleaks.bat` y job `gitleaks`) | `scripts\gitleaks.bat` | todas |

## ⚠️ Antes del despliegue (AWS): paso obligatorio

**Todos los secretos de desarrollo se regeneran. Ninguno viaja a producción.** Son los de los `.env` locales, que se crearon con `env-init`:

| Secreto | Repo | Cómo regenerarlo |
|---|---|---|
| `PGPASSWORD` (dueño de las tablas) | editor-ia-database | Uno nuevo y aleatorio en el gestor de secretos de AWS |
| `CUADERNO_APP_PASSWORD` (rol `cuaderno_app`) | editor-ia-database / `DATABASE_URL` del backend | Uno nuevo; `ALTER ROLE cuaderno_app PASSWORD ...` en la base de producción |
| `MFA_ENCRYPTION_KEY` | editor-ia-backend | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `ACCESS_TOKEN_SECRET` | editor-ia-backend | El mismo comando (32 bytes en base64) |
| `METRICS_TOKEN` | editor-ia-backend | `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `IA_SERVICE_TOKEN` | editor-ia-backend (API y servicio de IA) | El mismo comando que `METRICS_TOKEN` |
| Contraseña de Redis (producción la exige) | infraestructura | Una nueva, o TLS (`rediss://`) |

Además, producción se niega a arrancar si:

- algún proveedor está en `mock`;
- falta `METRICS_TOKEN` o `IA_SERVICE_TOKEN`;
- el tráfico con el servicio de IA no tiene TLS mutuo ni `IA_RED_PRIVADA=true` (riesgo R-03);
- Redis no tiene contraseña ni TLS;
- `APP_URL` no es `https://`;
- `COOKIE_SECURE` no es `true`;
- `PASSWORD_HASH_COST` es menor que 15;
- el usuario de base tiene privilegios de más.

**El dueño de las tablas NO puede ser superusuario en producción.** En desarrollo lo es (`cuaderno`, el usuario de la imagen de Postgres), y `compactar_documento()` (`SECURITY DEFINER`, migración 0021) corre con los privilegios de ese dueño. En producción las migraciones se aplican con un rol dueño **sin** superusuario.

**Una sola instancia del API** (bloque K2): el documento abierto en tiempo real vive en la memoria del proceso. Con más de una instancia habría que reenviar los cambios de cada documento por Redis, y eso no está implementado.

`MFA_ENCRYPTION_KEY` se genera **una vez** para producción y no se cambia después: si cambia, los MFA ya configurados dejan de poder verificarse.

**Monitoreo del tamaño de las versiones** (riesgo R-02, aceptado sin tope en R4). Las versiones no tienen tope ni retención: una cuenta editora puede sumar hasta 534,5 MiB por hora (medido en [almacenamiento-r.md](almacenamiento-r.md)).
- Antes de abrir el servicio, una alerta sobre `pg_total_relation_size('versiones')` y el tamaño de la base.
- Si salta, se ve quién guardó (`versiones.creado_por`) y se decide la cuota o la retención.

**Límite por IP en el proxy inverso** (riesgo R-07, aceptado en R4). El API limita 600 pedidos por minuto y **cuenta**. No frena muchas cuentas a la vez ni los pedidos sin token: eso lo tiene que cortar un límite por IP delante del API.

**CSP por cabecera** (riesgo R-06). `frame-ancestors 'none'` no funciona en `<meta>` y va por cabecera; un nonce por respuesta (`EditorView.cspNonce`) reemplaza a `'unsafe-inline'` en los estilos.

**`/health`, `/ready` y `/metrics` quedan fuera de `/api`** (decisión de R7): sin límite de tasa ni sesión, para el orquestador y Prometheus. `/metrics` exige `METRICS_TOKEN` en producción.

## Decisiones vigentes

- **Redis sin contraseña en desarrollo.** Solo escucha en `127.0.0.1` y la decisión se reevaluó en el bloque D. En producción, la configuración exige contraseña o TLS.
- **Usuario de base de privilegios mínimos.** El backend se conecta como `cuaderno_app`. Producción se niega a arrancar con un usuario con privilegios de más.
- **Documentos dentro de un espacio.** El rol de espacio da acceso a todos sus documentos. Los documentos privados dentro de un espacio quedan como **mejora futura**.
- **Pruebas de mutación en serie.** Su tiempo en el CI se iba a reevaluar en el bloque R; sigue en serie.
- **Versiones fijadas.** Política completa y overrides con su motivo en el [ADR 0008](adr/0008-dependencias.md). TypeScript 6.0.3 en el backend (por `typescript-eslint`) y Prisma 7.10.0 (`latest` es una versión candidata).
- **Dos contraseñas en el `.env` del repo de base.** `PGPASSWORD` es del dueño de las tablas (migraciones y pruebas). `CUADERNO_APP_PASSWORD` es del rol del backend.
- **Primer admin.** Se invita con la CLI de operador (`invitar.bat`), y el enlace va a su correo. Completarlo exige configurar MFA y enviar el primer código (bloque F).
- **MFA.** Obligatorio para admin (la base lo exige), opcional para editor y lector. La inscripción pendiente de un admin vive en `inscripciones_mfa`, vence con la invitación y se borra con ella. El desafío del segundo paso vive en Redis (solo su hash, 5 min, un solo uso). Los fallos de MFA suman al bloqueo de la cuenta.
- **Auditoría.** `eventos_seguridad` guarda cuenta, IP truncada y tipo de evento, nunca tokens ni contraseñas. Retención de 180 días (se aplica en el bloque G). Al eliminar una cuenta se anonimizan sus filas (bloque G).
- **gRPC solo entre servicios internos** (confirmado con el profesor). El navegador habla REST/JSON, SSE y WebSocket. El bloque P se dividió en P1 (servicio gRPC), P2 (embeddings, búsqueda, inyección y gateway) y P3 (informe REST/JSON vs gRPC). El contrato se revisa con `buf` en el job `verificar` del CI (`npm run proto:check`), no en un job aparte.
- **Si hay que recortar tiempo**, LaTeX y Mermaid se recortan primero. KaTeX entró en O; Mermaid quedó como mejora futura.
- **Eliminación de cuenta (bloque G).** Se bloquea con 409 mientras la persona sea propietaria de documentos con otros colaboradores sin haber transferido la propiedad. Solo se borran los documentos sin colaboradores.
  - Colaborador es cualquier otro miembro del espacio del documento, porque los documentos no tienen privacidad dentro de su espacio.
  - También da 409 ser propietaria de un espacio con otros miembros: el espacio necesita un propietario.
  - La hace la base en una transacción (`eliminar_cuenta()`). La cuenta queda como lápida y sus eventos de seguridad se anonimizan.
- **Retención.** Detalle en [data-retention.md](data-retention.md):
  - los plazos los fija la base;
  - el job diario de BullMQ (03:15 UTC) corre dentro del proceso del API;
  - la purga de invitaciones vencidas entró en la migración 0020 (cuentas pendientes, 7 días después de vencer la invitación).
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
  - **Sin paginar**: las listas de espacios, miembros y documentos devuelven todo. Se pagina si un espacio llega a cientos de documentos.
- **Auditoría de permisos (bloque K2, migración 0022).** Cada concesión y revocación de miembros, permisos y propiedad queda en `eventos_seguridad`: quién, a quién (`objetivo_id`) y sobre qué (`recurso_id`, solo un id). Las creaciones no se registran.
- **Compactación del log Yjs (migración 0021).** El backend ya no borra actualizaciones por su cuenta: solo `compactar_documento()`, que escribe el estado y borra en la misma llamada (ADR 0003). La usa la compactación de K2.
- **Tiempo real (bloque K2).** WebSocket en `/api/tiempo-real`, en el mismo proceso y puerto que el API. Mensajes, ticket y códigos de cierre: [protocolo-tiempo-real.md](protocolo-tiempo-real.md).
  - **Entrar:** ticket de un solo uso (`POST /api/tiempo-real/tickets`, en `Sec-WebSocket-Protocol`).
  - **Guardia:** verifica el permiso en cada mensaje.
  - **Rol al día:** por los avisos de la base reenviados por Redis (revocación medida: 8–19 ms), por el rechazo de la base al guardar, y revalidándose cada 30 s.
  - **Persistencia:** directa, con búfer de 250 ms; la compactación va por BullMQ.
  - **Límites de operación:** en `src/tiempo-real/limites.ts`.
  - **Una sola instancia.**
  - **Riesgo residual R-01, medido:** en [modelo-amenazas.md](modelo-amenazas.md).
  - **Implementadas, sin prueba propia:**
    - el latido (4408);
    - la cola de envío de 4 MiB (1013);
    - el cierre cuando vence la sesión;
    - Redis caído al entrar (503);
    - el tope de 10 MiB por documento (4413);
    - el disparo de la compactación (200 filas o 5 min de inactividad);
    - la revalidación total al reconectar;
    - el apagado ordenado;
    - (bloque M) el vaciado que falla reintenta sin descartar, y un documento con cambios sin guardar no se descarga de memoria.

    Detalle en la sección "Estado de verificación" de los ADR [0002](adr/0002-comunicacion.md) y [0003](adr/0003-crdt.md).
  - **Convergencia (bloque M), verificada:** prueba con semilla contra el servidor y la base reales, con réplicas, cortes, ediciones sin conexión, duplicados y compactación. Encontró un fallo de K2 que perdía en la base lo que llegaba durante un `INSERT`; corregido (ADR 0003).
- **Versiones y comentarios (bloque N, sin migración: las tablas son de 0010).**
  - **Versiones** (`/api/documentos/:id/versiones`):
    - ver el historial y el texto de una versión, y verificar la cadena (R1): cualquier rol;
    - guardar y restaurar: editor o propietario (30 por hora por cuenta);
    - restaurar es un **cambio nuevo** en el documento vivo (lo reciben quienes lo tienen abierto) y una versión «restauración» que apunta a la restaurada; el historial (cadena de hash, solo inserción) no se reescribe;
    - restaurar toca solo lo que difiere: por líneas y, dentro de una línea cambiada, por caracteres. Así un comentario sobre texto que no cambió conserva su ancla;
    - versión automática tras 5 minutos sin cambios, si el texto cambió desde la última.
  - **Comentarios** (`/api/documentos/:id/comentarios`, `/api/comentarios/:id`):
    - hilos anclados con dos posiciones relativas de Yjs (validadas);
    - comentar: cualquier rol (60 cada 10 minutos por cuenta);
    - editar: quien lo escribió;
    - resolver: quien abrió el hilo, o un editor o propietario;
    - borrar: quien lo escribió, o el propietario del documento;
    - cada cambio avisa por el WebSocket.
  - **Verificado:** integración con el tiempo real (restaurar llega al editor y queda en la base; permisos; aviso), diff por líneas con semilla, mutaciones N01–N11, E2E y prueba en vivo.
  - **Implementadas, sin prueba propia:**
    - el disparo real de la versión automática por BullMQ (la función sí tiene prueba);
    - los límites de tasa de versiones y comentarios.
- **IA (tramo 4).** Proveedor simulado en todo el proyecto; producción exige uno real (`AI_PROVIDER=anthropic` y `ANTHROPIC_API_KEY`) y no hay ninguno configurado. Topes diarios por cuenta, presupuesto del indexado automático por espacio y salida recortada. El texto del hero se reescribió en R1 porque el asistente no responde con citas de otros documentos.
- **Límite general (R4, decisión escrita del 27-10-2026).** 600 pedidos por minuto y cuenta en todo `/api`, 429 con `Retry-After`, 503 si Redis falla; fuera de él `/health`, `/ready`, `/metrics` y el WebSocket. Los cuatro residuales de R-07 están aceptados.
- **Prueba inestable conocida (R7, aceptada).** El trabajador de Vitest puede morir con un crash nativo de Node en Windows. Detalle en el README del backend, «Problema conocido».
