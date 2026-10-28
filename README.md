# editor-ia-backend

API y servidor en tiempo real de **Cuaderno**, un editor colaborativo de documentación técnica con IA.

Stack: Node.js 24, TypeScript, Express 5, zod, pino, prom-client, Prisma 7 (solo como cliente), PostgreSQL 16 con pgvector y Redis.

El esquema de la base **no vive aquí**: vive en [editor-ia-database](https://github.com/Jonar519/editor-ia-database), en migraciones SQL numeradas. Este repo solo lo consume.

> Visión general del proyecto y tabla "cómo demostrar cada tema": [docs/README-general.md](docs/README-general.md).

## Estado

Al cierre de R8 (28-10-2026), el backend tiene completos los bloques D a R7:
- identidad (D–G);
- espacios, documentos y tiempo real (K1–N);
- IA por gRPC con proveedor simulado (P1–P3);
- verificación de la cadena, carga, modelo de amenazas, límite general, ADRs, OpenAPI revisado y protocolo (R1–R7).

**Sin despliegue y sin IA real.** Lo que exige el despliegue está en el README general. Quedan del bloque R:
- R9: guía de demostración consolidada;
- R10: lista de revisión;
- R11: dependencias. El 2-11-2026 entra `fast-uri` 3.1.9; el 5-11-2026 se revisa el override de `body-parser` 2.4.0, riesgo R-05.

## Requisitos

- Node.js 24 o superior
- Docker Desktop
- El repo hermano `editor-ia-database`, con sus servicios arriba (`scripts\db-up.bat` de ese repo)

## Puesta en marcha (cmd.exe)

```bat
cd /d "...\editor-ia\editor-ia-database"
scripts\db-up.bat
scripts\db-migrate.bat dev

cd /d "...\editor-ia\editor-ia-backend"
npm ci
npm run prisma:generate
npm run proto:generate
scripts\env-init.bat
scripts\dev.bat
```

El API queda en `http://127.0.0.1:4200`. Para revisarlo: `/health`, `/ready` y `/metrics`.

El **servicio de IA** es un proceso aparte (gRPC en `127.0.0.1:4210`, proveedor simulado). En otra ventana:

```bat
scripts\ia.bat
```

Los dos procesos comparten `.env` (el mismo `IA_SERVICE_TOKEN`). Sin el servicio, el API funciona igual: las rutas de IA responden 503 y `/ready` muestra `"ia": "falla"` sin dejar de responder 200.

## Scripts

| Script | Qué hace |
|---|---|
| `env-init.bat` | Crea o completa `.env`. Genera `MFA_ENCRYPTION_KEY`, `ACCESS_TOKEN_SECRET`, `METRICS_TOKEN` e `IA_SERVICE_TOKEN`, y arma las URL de base con la contraseña de `cuaderno_app` del repo de base. Nunca cambia un valor existente. |
| `dev.bat` | Servidor de desarrollo con recarga. |
| `ia.bat` | Servicio de IA (gRPC, `127.0.0.1:4210`) con recarga. |
| `reindexar.bat` | Encola el reindexado de todos los documentos (por ejemplo, al cambiar el modelo de embeddings). Lo procesa el API. |
| `medir.bat [--rapido]` | Medición P3: la misma operación por gRPC y por REST/JSON (HTTP/1.1 y h2c) en el mismo proceso. Escribe `docs/medicion-p3.json` y `docs/medicion-p3.md`. No mide si la CPU de la máquina ya está ocupada (más del 10 %). |
| `carga.bat [--rapido]` | Pruebas de carga del bloque R contra el API real (`npm run build` antes): HTTP H1–H4 con autocannon y WebSocket W1–W2 con generadores propios. Usa la base de pruebas `cuaderno_carga_test`, que recrea, y la db 2 de Redis, que vacía; nunca la de desarrollo. Escribe `docs/carga-r.json` y `docs/carga-r.md`, que abre con lo que la medición no permite concluir. No mide con más del 10 % de CPU ocupada. |
| `carga-linux.bat [--rapido]` | Lo mismo en el contenedor de Linux, en la red Docker de Cuaderno, contra los mismos PostgreSQL y Redis; junta sus datos con los de Windows. |
| `almacenamiento.bat [--rapido]` | Cuánto ocupa cada versión según el tamaño y el contenido del documento, y si el límite de 30 por hora corta (riesgo R-02). Mismo API, base de pruebas y Redis que `carga.bat`. Escribe `docs/almacenamiento-r.json` y `docs/almacenamiento-r.md`. |
| `npm run proto:generate` | Tipos TypeScript del contrato gRPC en `src/generated/ia` (no se versionan). |
| `npm run proto:check` | `buf lint` y `buf breaking` del contrato contra `main` (lo corre el CI). |
| `test.bat` | Vitest + Supertest contra la base de **pruebas** y Redis db 1. |
| `bd-preparar.bat` | Migra la base de pruebas con el esquema del repo de base. |
| `prisma-pull.bat` | Regenera `prisma/schema.prisma` desde la base de pruebas y el cliente de Prisma. |
| `openapi.bat` | Regenera `docs/openapi.json` desde los esquemas zod. |
| `mutar.bat [id...]` | Pruebas de mutación (`mutations/catalogo.json`). |
| `gitleaks.bat` | Busca secretos en todo el historial. |
| `ci.bat` | Corre los mismos pasos que el CI y muestra el código de salida de cada uno. |
| `demo-linux.bat sigterm\|produccion` | En el contenedor de Linux y contra la base de pruebas: SIGTERM real y el apagado, o las negativas de producción (`npm run build` antes). |
| `invitar.bat --correo .. --nombre ".." --rol ..` | CLI de operador: invita una cuenta (por ejemplo, el primer admin). El enlace va **solo** al correo. |
| `buzon.bat <correo>` | Buzón simulado (solo desarrollo y solo con el proveedor mock): los correos recibidos por una dirección. |
| `totp.bat <secreto>` | Código TOTP vigente de un secreto base32, como una app autenticadora (para la demo). No lee la base ni el `.env`. |

## API

Detalle completo en [docs/openapi.json](docs/openapi.json). Decisiones de sesión en [docs/adr/0001-sesion.md](docs/adr/0001-sesion.md).

| Ruta | Para qué |
|---|---|
| `POST /api/auth/sesion` | Iniciar sesión. Sin MFA: 201 con el access token (15 min, solo en memoria) y la cookie de refresco. Con MFA: 202 con un desafío (5 min, un solo uso). |
| `POST /api/auth/mfa` | Segundo paso: desafío + código TOTP o de respaldo. Cualquier fallo responde igual (401 `mfa_invalido`). |
| `POST /api/auth/recuperacion` | Pedir el enlace de recuperación. Responde 202 y el mismo mensaje exista o no el correo. |
| `POST /api/auth/recuperacion/completar` | Nueva contraseña con el token del enlace (15 min, un solo uso). Cierra todas las sesiones. |
| `POST /api/auth/refresco` | Rotar el refresh. Reutilizar uno ya usado revoca la sesión entera. |
| `DELETE /api/auth/sesion` | Cerrar la sesión. |
| `GET /api/auth/yo` | Cuenta de la sesión actual. |
| `POST/GET /api/admin/invitaciones` | Invitar y listar las pendientes (solo admin). La respuesta nunca trae el enlace. |
| `POST /api/admin/invitaciones/{id}/reenviar` | Reenviar la invitación con un enlace nuevo. |
| `DELETE /api/admin/invitaciones/{id}` | Cancelar la invitación. |
| `POST /api/invitaciones/consultar` | Datos de la invitación. El token va en el cuerpo. |
| `POST /api/invitaciones/mfa` | Admin pendiente: secreto TOTP y `otpauth://` para el QR, antes de completar. |
| `POST /api/invitaciones/completar` | Elegir contraseña, activar la cuenta y abrir la primera sesión. Un admin envía además `codigoTotp` y recibe sus 10 códigos de respaldo. |
| `POST /api/cuenta/mfa/iniciar`, `/confirmar` | Activar MFA (editor y lector). Confirmar entrega los códigos de respaldo. |
| `POST /api/cuenta/mfa/codigos-respaldo` | Regenerar los códigos de respaldo (exige un código TOTP). |
| `DELETE /api/cuenta/mfa` | Desactivar MFA. Para un admin: 409 `mfa_obligatorio`. |
| `GET/PATCH /api/cuenta` | Perfil: leer, o cambiar nombre y teléfono. |
| `POST /api/cuenta/correo` | Pedir el cambio de correo (exige la contraseña). Enlace al correo nuevo y aviso al anterior. Misma respuesta esté o no en uso la dirección. |
| `POST /api/cuenta/correo/confirmar` | Confirmar el correo nuevo con el token del enlace (sin sesión). Avisa al anterior. |
| `POST /api/cuenta/contrasena` | Cambiar la contraseña (exige la actual). Cierra las demás sesiones. |
| `GET /api/cuenta/sesiones` | Sesiones vivas con IP truncada, ubicación aproximada y user-agent corto. |
| `DELETE /api/cuenta/sesiones/{id}`, `POST /api/cuenta/sesiones/cerrar-otras` | Cerrar una sesión, o todas menos la actual. |
| `PUT/DELETE /api/cuenta/avatar` | Subir (JPEG o PNG, se guarda sin metadatos) o borrar el avatar. |
| `GET /api/usuarios/{id}/avatar` | Avatar de una cuenta (con ETag). |
| `POST /api/cuenta/exportacion` | Exportar los datos en JSON, sin secretos (exige la contraseña). |
| `DELETE /api/cuenta` | Eliminar la cuenta por lápida (contraseña y, con MFA, un código). 409 si hay propiedad compartida. |
| `GET/POST /api/espacios`, `GET/PATCH/DELETE /api/espacios/{id}` | Espacios con tu rol en cada uno; crear, renombrar y borrar (solo si el propietario es el único miembro). |
| `/api/espacios/{id}/miembros`, `/miembros/{usuarioId}`, `/propiedad` | Agregar miembros por correo, cambiar su rol, quitarlos o salir, y transferir el espacio. |
| `GET/POST /api/espacios/{id}/documentos` | Documentos del espacio con tu rol efectivo; crear uno. |
| `GET/PATCH/DELETE /api/documentos/{id}`, `/propiedad`, `/permisos`, `/permisos/{usuarioId}` | Metadatos, renombrar, borrar, transferir y permisos propios ("editor"). |
| `GET /api/documentos/{id}/texto` | El texto actual, desde la memoria del servidor. |
| `POST /api/tiempo-real/tickets` | Ticket de un solo uso (30 s) para abrir el WebSocket del documento. Protocolo en [docs/protocolo-tiempo-real.md](docs/protocolo-tiempo-real.md). |
| `GET/POST /api/documentos/{id}/versiones`, `/versiones/{numero}`, `/versiones/{numero}/restaurar` | Historial, guardar una versión, ver su texto y restaurarla como cambio nuevo. |
| `GET /api/documentos/{id}/versiones/verificacion` | Verificar la cadena de hash de todas las versiones (la recalcula la base). |
| `GET/POST /api/documentos/{id}/comentarios`, `PATCH/DELETE /api/comentarios/{id}` | Hilos anclados y respuestas: comentar, editar, resolver y borrar. |
| `POST /api/ia/explicar` | Explicar un fragmento (cualquier rol con acceso al documento). |
| `POST /api/ia/resumir`, `/mejorar` | Respuesta en streaming (SSE sobre `fetch` POST). Mejorar exige editor. Abortar el `fetch` cancela la generación. |
| `POST /api/espacios/{id}/buscar` | Búsqueda semántica: solo el espacio pedido y documentos con acceso hoy. |
| `POST /api/documentos/{id}/indice` | Encolar el indexado del documento para la búsqueda (editor). Además, el documento se indexa solo 5 minutos después de dejar de editarlo, contra el presupuesto diario del espacio. |
| `GET /api/ia/uso` | El uso de IA de hoy, los topes y cuándo se renuevan. |

El autocompletado va por el WebSocket del documento (mensaje de control `ia.autocompletar`). Decisiones de IA y tabla de errores gRPC → HTTP en [docs/adr/0002-comunicacion.md](docs/adr/0002-comunicacion.md).

## Configuración

Todas las variables están en [.env.example](.env.example), cada una con su comentario. Se validan con zod al arrancar: un valor inválido detiene el proceso y lista los problemas, sin mostrar nunca un valor secreto.

**En producción el servidor se niega a arrancar** si se da cualquiera de estas condiciones:

- algún proveedor externo (IA, correo, geolocalización) está en `mock`;
- falta `METRICS_TOKEN`;
- falta `IA_SERVICE_TOKEN`, o el tráfico con el servicio de IA no tiene TLS mutuo (`IA_TLS_*`) ni `IA_RED_PRIVADA=true` (lo mismo vale para el servicio de IA, que además exige `ANTHROPIC_API_KEY` con `AI_PROVIDER=anthropic`);
- Redis no tiene contraseña ni TLS;
- el usuario de base tiene privilegios de más: es superusuario, es dueño de tablas, puede crear en `public`, puede crear bases o roles, o puede saltarse RLS.

## Diseño

| Tema | Cómo |
|---|---|
| Usuario de base | `cuaderno_app`, con privilegios mínimos. No puede desactivar triggers, hacer `TRUNCATE` ni cambiar el esquema. Ver el README del repo de base. |
| Prisma | Solo cliente. `prisma/schema.prisma` sale de `db pull` y `npm run prisma:check` falla si se desvía de la base. `vector` y `cidr` no los soporta Prisma: se manejan con SQL parametrizado. |
| `/health` | Solo responde que el proceso vive; no revisa dependencias. |
| `/ready` | Revisa base, versión mínima del esquema y Redis, con 2 s por comprobación. Responde 503 si algo falla o si el proceso se está apagando. Muestra además la salud del servicio de IA (`grpc.health.v1`), que es **informativa**: su falla no da 503. |
| IA | Servicio gRPC aparte (`src/ia/`, contrato en `proto/`): los cuatro tipos de llamada, token entre servicios, deadlines, cancelación y salud estándar. Proveedor intercambiable (`AI_PROVIDER`); embeddings de 1024 dimensiones (el API lo verifica con `Describir`). Tope diario por cuenta en `uso_ia_diario` y presupuesto del indexado automático por espacio. Prompts armados contra la inyección (`src/ia/prompt.ts`: contenido escapado en un bloque con nonce, instrucciones aparte, salida recortada). |
| `/metrics` | Prometheus con prefijo `cuaderno_`. La duración HTTP se etiqueta con el **patrón** de ruta, nunca con la URL. |
| Apagado | `SIGTERM`/`SIGINT`: deja de aceptar conexiones, `/ready` pasa a 503, espera las peticiones en curso (hasta `SHUTDOWN_TIMEOUT_MS`), cierra el worker de BullMQ (espera el job en curso) y cierra base y Redis una sola vez. |
| Trabajos | BullMQ. Retención diaria a las 03:15 UTC: llama a `purgar_retencion()` de la base. Ver [docs/data-retention.md](docs/data-retention.md). |
| Errores | JSON `{ error: { codigo, mensaje, solicitud } }`. Un error inesperado responde 500 genérico: el detalle solo va al log. |
| Logs | pino en JSON. Nunca registra `Authorization`, cookies, contraseñas ni tokens. |
| OpenAPI | Generada desde los esquemas zod (`docs/openapi.json`). `npm run openapi:check` falla si quedó desactualizada. Los errores comunes de `/api` (400, 401, 413, 415, 429 con `Retry-After`, 503) se agregan en un solo lugar, y `openapi.test.ts` exige que toda ruta de Express esté documentada. |
| Tiempo real | WebSocket en `/api/tiempo-real`, en el mismo proceso: ticket de un solo uso en el subprotocolo, guardia por mensaje, revocación por los avisos de la base y persistencia con búfer de 250 ms. [ADR 0002](docs/adr/0002-comunicacion.md), [ADR 0003](docs/adr/0003-crdt.md) y [protocolo](docs/protocolo-tiempo-real.md). |
| Límites | Por ruta sensible (login, MFA, recuperación, miembros, versiones, comentarios, IA, tickets) y un límite general de 600 pedidos por minuto y cuenta en todo `/api`. Todos en Redis y fallan cerrado (503). |

## Documentación

| Documento | Qué tiene |
|---|---|
| [docs/README-general.md](docs/README-general.md) | Los tres repos, la tabla de demostración de A a R, lo que exige el despliegue y las decisiones vigentes |
| [docs/adr/](docs/adr/) | ADR 0001–0008, cada uno con su estado de verificación |
| [docs/modelo-amenazas.md](docs/modelo-amenazas.md) | STRIDE por elemento y riesgos residuales R-01–R-07 |
| [docs/protocolo-tiempo-real.md](docs/protocolo-tiempo-real.md) | Ticket, comprobaciones del upgrade, mensajes, límites y códigos de cierre |
| [docs/openapi.json](docs/openapi.json) | El API REST, generado |
| [docs/medicion-p3.md](docs/medicion-p3.md), [docs/carga-r.md](docs/carga-r.md), [docs/almacenamiento-r.md](docs/almacenamiento-r.md), [docs/limite-r/carga-r.md](docs/limite-r/carga-r.md) | Mediciones generadas por sus scripts, cada una con lo que no permite concluir |
| [docs/data-retention.md](docs/data-retention.md) | Plazos de retención |
| `docs/demo-D.md` … `docs/demo-K1.md` | Pasos de demostración para cmd.exe de los bloques D, E, F, G y K1 |

## Problema conocido: el trabajador de Vitest muere en Windows con la CPU saturada

**Aceptado y sin causa raíz** (decisión escrita del cierre de R7).

**Qué pasa:** muy de vez en cuando, una corrida de pruebas en Windows termina con un error así y **sin ninguna línea FAIL**:

```
Unhandled Error: [vitest-pool]: Worker forks emitted error
Worker exited unexpectedly with exit code 3221226505
```

El código 3221226505 es `0xC0000409` (`STATUS_STACK_BUFFER_OVERRUN`): un crash nativo de `node.exe` (`abort` o `__fastfail`) en el proceso trabajador de Vitest. No es una aserción que falla ni un cuelgue.

**Cuándo se vio**, investigado en R7 con `tests/integracion/ia-autocompletado.test.ts`:

| Condición | Corridas | Fallas |
|---|---|---|
| Windows, sin carga | 198, más 20 vueltas del runner de mutaciones | 0 |
| Windows, con la CPU al 100 % (procesos de carga aparte) | 390 | 1, después de que pasaran 4 de las 6 pruebas |
| Linux: el CI y cada réplica local en el contenedor | sin serie aparte | nunca se vio |

- **Frecuencia y entorno:** alrededor de 1 cada 400 corridas, y solo con la CPU saturada. Node v24.13.1 en Windows 11, Vitest 5.0.4 con el pool `forks`.
- **Sin la causa nativa.** 200 corridas más con `--report-on-fatalerror` no lo reprodujeron, así que no hay informe.
- **No se va más lejos:** no se instala `procdump` ni se activan los volcados de Windows Error Reporting, porque exigen tocar el registro.

**Qué hacer si aparece:**
- **Repetir la corrida.** Si se repite sin carga en la máquina, o en Linux, es otra cosa y se investiga.
- **En la corrida final de las mutaciones,** `scripts/mutar.mjs` ya deja la evidencia:
  - imprime el error no manejado como evidencia;
  - imprime `status`, `signal`, la duración y las últimas 40 líneas;
  - guarda la salida completa en `mutations/fallas/final-<fecha>.log`, que no se versiona.
