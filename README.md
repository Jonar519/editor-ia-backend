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
scripts\env-init.bat
scripts\dev.bat
```

El API queda en `http://127.0.0.1:4200`. Para revisarlo: `/health`, `/ready` y `/metrics`.

## Scripts

| Script | Qué hace |
|---|---|
| `env-init.bat` | Crea o completa `.env`. Genera `MFA_ENCRYPTION_KEY` y `METRICS_TOKEN`, y arma las URL de base con la contraseña de `cuaderno_app` del repo de base. Nunca cambia un valor existente. |
| `dev.bat` | Servidor de desarrollo con recarga. |
| `test.bat` | Vitest + Supertest contra la base de **pruebas** y Redis db 1. |
| `bd-preparar.bat` | Migra la base de pruebas con el esquema del repo de base. |
| `prisma-pull.bat` | Regenera `prisma/schema.prisma` desde la base de pruebas y el cliente de Prisma. |
| `openapi.bat` | Regenera `docs/openapi.json` desde los esquemas zod. |
| `mutar.bat [id...]` | Pruebas de mutación (`mutations/catalogo.json`). |
| `gitleaks.bat` | Busca secretos en todo el historial. |
| `ci.bat` | Corre los mismos pasos que el CI y muestra el código de salida de cada uno. |
| `invitar.bat --correo .. --nombre ".." --rol ..` | CLI de operador: invita una cuenta (por ejemplo, el primer admin). El enlace va **solo** al correo. |
| `buzon.bat <correo>` | Buzón simulado (solo desarrollo y solo con el proveedor mock): los correos recibidos por una dirección. |

## API

Detalle completo en [docs/openapi.json](docs/openapi.json). Decisiones de sesión en [docs/adr/0001-sesion.md](docs/adr/0001-sesion.md).

| Ruta | Para qué |
|---|---|
| `POST /api/auth/sesion` | Iniciar sesión. Devuelve el access token (15 min, solo en memoria) y fija la cookie de refresco. |
| `POST /api/auth/refresco` | Rotar el refresh. Reutilizar uno ya usado revoca la sesión entera. |
| `DELETE /api/auth/sesion` | Cerrar la sesión. |
| `GET /api/auth/yo` | Cuenta de la sesión actual. |
| `POST/GET /api/admin/invitaciones` | Invitar y listar las pendientes (solo admin). La respuesta nunca trae el enlace. |
| `POST /api/admin/invitaciones/{id}/reenviar` | Reenviar la invitación con un enlace nuevo. |
| `DELETE /api/admin/invitaciones/{id}` | Cancelar la invitación. |
| `POST /api/invitaciones/consultar` | Datos de la invitación. El token va en el cuerpo. |
| `POST /api/invitaciones/completar` | Elegir contraseña, activar la cuenta y abrir la primera sesión. |

## Configuración

Todas las variables están en [.env.example](.env.example), cada una con su comentario. Se validan con zod al arrancar: un valor inválido detiene el proceso y lista los problemas, sin mostrar nunca un valor secreto.

**En producción el servidor se niega a arrancar** si se da cualquiera de estas condiciones:

- algún proveedor externo (IA, correo, geolocalización) está en `mock`;
- falta `METRICS_TOKEN`;
- Redis no tiene contraseña ni TLS;
- el usuario de base tiene privilegios de más: es superusuario, es dueño de tablas, puede crear en `public`, puede crear bases o roles, o puede saltarse RLS.

## Diseño

| Tema | Cómo |
|---|---|
| Usuario de base | `cuaderno_app`, con privilegios mínimos. No puede desactivar triggers, hacer `TRUNCATE` ni cambiar el esquema. Ver el README del repo de base. |
| Prisma | Solo cliente. `prisma/schema.prisma` sale de `db pull` y `npm run prisma:check` falla si se desvía de la base. `vector` y `cidr` no los soporta Prisma: se manejan con SQL parametrizado. |
| `/health` | Solo responde que el proceso vive; no revisa dependencias. |
| `/ready` | Revisa base, versión mínima del esquema y Redis, con 2 s por comprobación. Responde 503 si algo falla o si el proceso se está apagando. |
| `/metrics` | Prometheus con prefijo `cuaderno_`. La duración HTTP se etiqueta con el **patrón** de ruta, nunca con la URL. |
| Apagado | `SIGTERM`/`SIGINT`: deja de aceptar conexiones, `/ready` pasa a 503, espera las peticiones en curso (hasta `SHUTDOWN_TIMEOUT_MS`) y cierra base y Redis una sola vez. |
| Errores | JSON `{ error: { codigo, mensaje, solicitud } }`. Un error inesperado responde 500 genérico: el detalle solo va al log. |
| Logs | pino en JSON. Nunca registra `Authorization`, cookies, contraseñas ni tokens. |
| OpenAPI | Generada desde los esquemas zod (`docs/openapi.json`). `npm run openapi:check` falla si quedó desactualizada. |
