# editor-ia-backend

API y servidor en tiempo real de **Cuaderno**, un editor colaborativo de documentación técnica con IA.

Stack: Node.js 24, TypeScript, Express 5, zod, pino, prom-client, Prisma 7 (solo como cliente), PostgreSQL 16 con pgvector y Redis.

El esquema de la base **no vive aquí**: vive en [editor-ia-database](https://github.com/Jonar519/editor-ia-database), en migraciones SQL numeradas. Este repo solo lo consume.

> Visión general del proyecto y tabla "cómo demostrar cada tema": [docs/README-general.md](docs/README-general.md).

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
| `npm run proto:generate` | Tipos TypeScript del contrato gRPC en `src/generated/ia` (no se versionan). |
| `npm run proto:check` | `buf lint` y `buf breaking` del contrato contra `main` (lo corre el CI). |
| `test.bat` | Vitest + Supertest contra la base de **pruebas** y Redis db 1. |
| `bd-preparar.bat` | Migra la base de pruebas con el esquema del repo de base. |
| `prisma-pull.bat` | Regenera `prisma/schema.prisma` desde la base de pruebas y el cliente de Prisma. |
| `openapi.bat` | Regenera `docs/openapi.json` desde los esquemas zod. |
| `mutar.bat [id...]` | Pruebas de mutación (`mutations/catalogo.json`). |
| `gitleaks.bat` | Busca secretos en todo el historial. |
| `ci.bat` | Corre los mismos pasos que el CI y muestra el código de salida de cada uno. |
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
| `POST /api/ia/explicar` | Explicar un fragmento (cualquier rol con acceso al documento). |
| `POST /api/ia/resumir`, `/mejorar` | Respuesta en streaming (SSE sobre `fetch` POST). Mejorar exige editor. Abortar el `fetch` cancela la generación. |
| `POST /api/espacios/{id}/buscar` | Búsqueda semántica: solo el espacio pedido y documentos con acceso hoy. |
| `POST /api/documentos/{id}/indice` | Encolar el indexado del documento para la búsqueda (editor). El indexado automático al dejar de editar queda pendiente para P2. |

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
| IA | Servicio gRPC aparte (`src/ia/`, contrato en `proto/`): los cuatro tipos de llamada, token entre servicios, deadlines, cancelación y salud estándar. Proveedor intercambiable (`AI_PROVIDER`); embeddings de 1024 dimensiones. Tope diario por cuenta en `uso_ia_diario`. |
| `/metrics` | Prometheus con prefijo `cuaderno_`. La duración HTTP se etiqueta con el **patrón** de ruta, nunca con la URL. |
| Apagado | `SIGTERM`/`SIGINT`: deja de aceptar conexiones, `/ready` pasa a 503, espera las peticiones en curso (hasta `SHUTDOWN_TIMEOUT_MS`), cierra el worker de BullMQ (espera el job en curso) y cierra base y Redis una sola vez. |
| Trabajos | BullMQ. Retención diaria a las 03:15 UTC: llama a `purgar_retencion()` de la base. Ver [docs/data-retention.md](docs/data-retention.md). |
| Errores | JSON `{ error: { codigo, mensaje, solicitud } }`. Un error inesperado responde 500 genérico: el detalle solo va al log. |
| Logs | pino en JSON. Nunca registra `Authorization`, cookies, contraseñas ni tokens. |
| OpenAPI | Generada desde los esquemas zod (`docs/openapi.json`). `npm run openapi:check` falla si quedó desactualizada. |
