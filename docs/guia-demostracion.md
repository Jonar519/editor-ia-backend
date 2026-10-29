# Guía de demostración (cmd.exe)

Pasos exactos para levantar **Cuaderno** desde un clon limpio y demostrar cada tema de la materia. Reúne lo que antes estaba repartido en las demos de cada bloque; esas demos siguen en su repo para el detalle (`docs/demo-<bloque>.md`).

- **Terminal:** `cmd.exe`. Cada bloque de código se pega tal cual.
- **Datos:** solo ficticios (`@example.com`, nombres inventados).
- **Ventanas:** cuatro de cmd. Tres quedan ocupadas con los procesos (API, servicio de IA y frontend); la cuarta es para los comandos.
- **Dónde escribe:** en la base de **desarrollo** (`cuaderno`) y en la db 0 de Redis, porque la demostración la haces tú. Las pruebas y las mutaciones usan siempre la base `cuaderno_test` y la db 1. Para no tocar tu base de desarrollo, sigue el [apéndice](#apéndice-base-y-redis-aparte).

**Contenido**

1. [Prerrequisitos](#1-prerrequisitos)
2. [Clonar](#2-clonar)
3. [Base y migraciones](#3-base-y-migraciones)
4. [API y servicio de IA de prueba](#4-api-y-servicio-de-ia-de-prueba)
5. [Frontend](#5-frontend)
6. [Primera cuenta por invitación](#6-primera-cuenta-por-invitación)
7. [Más personas y sus tokens](#7-más-personas-y-sus-tokens)
8. [Recorrido por tema](#8-recorrido-por-tema): [A](#bloque-a-migraciones-y-pruebas-sql) · [B](#bloque-b-cuenta-pendiente-sin-sesiones) · [C](#bloque-c-historial-y-aislamiento-en-la-base) · [D](#bloque-d-esqueleto-del-backend) · [E](#bloque-e-invitaciones-y-sesión) · [F](#bloque-f-mfa-recuperación-y-auditoría) · [G](#bloque-g-perfil-sesiones-y-datos) · [H1–J](#bloques-h1-a-j-interfaz-de-identidad) · [K1](#bloque-k1-espacios-documentos-y-permisos) · [K2](#bloque-k2-tiempo-real) · [L](#bloque-l-editor-y-presencia) · [M](#bloque-m-convergencia-y-sin-conexión) · [N](#bloque-n-versiones-y-comentarios) · [O](#bloque-o-vista-renderizada-y-comandos) · [P1](#bloque-p1-grpc) · [P2](#bloque-p2-búsqueda-inyección-y-topes) · [P3](#bloque-p3-medición-grpc-frente-a-restjson) · [Q](#bloque-q-asistente-de-ia) · [R](#bloque-r-cierre)
9. [Pruebas y CI de los tres repos](#9-pruebas-y-ci-de-los-tres-repos)
10. [Lo no medido o no cubierto](#10-lo-no-medido-o-no-cubierto)
11. [Apéndice: base y Redis aparte](#apéndice-base-y-redis-aparte)
12. [Limpiar](#12-limpiar)

## 1. Prerrequisitos

- **Windows 10 u 11** con `cmd.exe`. `curl` viene con Windows.
- **Node.js 24** o superior (`node -v`).
- **Docker Desktop** con el motor Linux, encendido. PostgreSQL, Redis, gitleaks, las E2E y las réplicas de Linux corren en contenedores. No hace falta instalar `psql`.
- **git**.
- **Chrome o Firefox.** Para las demos con dos personas, dos navegadores (o uno normal y otro en modo privado): cada sesión vive en su propia cookie.
- **Puertos libres:** 5435 (PostgreSQL), 6381 (Redis), 4200 (API), 4210 (servicio de IA) y 5175 (frontend).

## 2. Clonar

Elige una carpeta (puede tener espacios y tildes) y guárdala en `RAIZ`. **Repite el `set RAIZ` en cada ventana nueva.**

```bat
set RAIZ=C:\cuaderno-demo
mkdir "%RAIZ%"
cd /d "%RAIZ%"
git clone https://github.com/Jonar519/editor-ia-database.git
git clone https://github.com/Jonar519/editor-ia-backend.git
git clone https://github.com/Jonar519/editor-ia-frontend.git
```

**Qué debes ver:** tres carpetas, una por repo. Los tres tienen que quedar **juntos** en la misma carpeta: el backend busca el esquema en `..\editor-ia-database`.

## 3. Base y migraciones

```bat
cd /d "%RAIZ%\editor-ia-database"
npm ci
scripts\db-up.bat
scripts\db-migrate.bat dev
scripts\db-migrate.bat dev --estado
```

**Qué debes ver:**

- `db-up` crea `.env` con contraseñas locales aleatorias ("`.env creado con contraseñas locales aleatorias.`"), levanta `cuaderno_postgres` y `cuaderno_redis` y habilita el login del rol de la app ("`Rol cuaderno_app creado con LOGIN.`").
- `db-migrate dev` aplica de `0001_extensiones.sql` a `0023_ia_indexado_y_busqueda.sql` y dice `Base cuaderno: 23 migraciones aplicadas.`
- `--estado`: `Base cuaderno: 23 aplicadas, 0 pendientes.`

**Ojo:** `db-up.bat` usa contenedores con nombre fijo. Si ya existe una instalación de Cuaderno en la máquina, ese comando actúa sobre ella; para una aparte, ver el [apéndice](#apéndice-base-y-redis-aparte).

## 4. API y servicio de IA de prueba

```bat
cd /d "%RAIZ%\editor-ia-backend"
npm ci
npm run prisma:generate
npm run proto:generate
scripts\env-init.bat
scripts\bd-preparar.bat
scripts\dev.bat
```

**Qué debes ver:** `.env creado con secretos aleatorios.`; `bd-preparar` migra la base de **pruebas** (`cuaderno_test`), que necesitan las pruebas y las mutaciones del backend; y después el log `Cuaderno API escuchando` en el puerto 4200. Deja esta ventana abierta.

`env-init` genera `MFA_ENCRYPTION_KEY`, `ACCESS_TOKEN_SECRET`, `METRICS_TOKEN` e `IA_SERVICE_TOKEN`. Además arma `DATABASE_URL` con la contraseña de `cuaderno_app` que creó `db-up`. Ya trae los valores que el frontend necesita: `APP_URL=http://127.0.0.1:5175` y `COOKIE_SECURE=true`.

**Segunda ventana:** el servicio de IA (gRPC, proveedor **simulado**; no hay IA real en el proyecto).

```bat
set RAIZ=C:\cuaderno-demo
cd /d "%RAIZ%\editor-ia-backend"
scripts\ia.bat
```

**Qué debes ver:** `Cuaderno IA escuchando (gRPC)` con `"puerto":4210` y `"proveedor":"mock"`.

**Cuarta ventana** (la de los comandos), para comprobar los dos procesos:

```bat
set RAIZ=C:\cuaderno-demo
cd /d "%RAIZ%\editor-ia-backend"
curl -s http://127.0.0.1:4200/health
curl -s http://127.0.0.1:4200/ready
curl -s -o NUL -w "%{http_code}\n" http://127.0.0.1:4200/metrics
```

**Qué debes ver:**

1. `{"estado":"ok"}`
2. `{"estado":"listo","comprobaciones":{"bd":"ok","esquema":"ok","redis":"ok","ia":"ok"}}`
3. `401`: `/metrics` exige el `METRICS_TOKEN` que generó `env-init`. Cómo leerlo, en el [bloque D](#bloque-d-esqueleto-del-backend).

## 5. Frontend

**Tercera ventana:**

```bat
set RAIZ=C:\cuaderno-demo
cd /d "%RAIZ%\editor-ia-frontend"
npm ci
scripts\dev.bat
```

**Qué debes ver:** `VITE ... ready` y `Local: http://127.0.0.1:5175/`. Abre esa dirección: el hero de Cuaderno con un solo botón, **Entrar**. Usa siempre `127.0.0.1`, no `localhost`: el API compara el `Origin` con `APP_URL`.

Las llamadas a `/api` van por el proxy de Vite al API: mismo origen, sin CORS. Para ver la CSP del build (bloque R2), en lugar de `dev.bat` usa `npm run build` y `npm run preview`, que sirven en el mismo puerto.

## 6. Primera cuenta por invitación

No hay registro abierto: la primera cuenta la invita el operador con la CLI. Será **Marta, administradora**, y por eso con verificación en dos pasos obligatoria.

```bat
cd /d "%RAIZ%\editor-ia-backend"
scripts\invitar.bat --correo marta.demo@example.com --nombre "Marta Ficticia" --rol admin
scripts\buzon.bat marta.demo@example.com
```

**Qué debes ver:**

- `invitar`: `Invitación creada para marta.demo@example.com (admin). Vence: ...` y `El enlace se envió a su correo. Aquí no se muestra.`
- `buzon` (el buzón simulado, solo en desarrollo): el correo con el enlace `http://127.0.0.1:5175/#/invitacion/<token>`.

Abre el enlace en el navegador.

**Qué debes ver:**

1. La barra de direcciones queda en `#/invitacion`: el token **se borró de la URL** al leerlo.
2. "Hola, Marta Ficticia. Te invitaron con permisos de administración."
3. El secreto de la verificación en dos pasos, en grupos de 4.

Elige una contraseña de 12 caracteres o más (una frase). Agrega el secreto a tu app autenticadora o, sin app, saca el código con:

```bat
scripts\totp.bat <secreto sin espacios>
```

Escribe el código (dura 30 s; `totp` dice cuántos segundos le quedan) y presiona **Crear la cuenta**.

**Qué debes ver:**

- **Guarda tus códigos de respaldo**: 10 códigos, que se muestran solo esta vez. Guarda uno para el bloque F.
- **Continuar** se habilita al marcar "Ya los guardé en un lugar seguro".

Marca la casilla, presiona **Continuar** y recarga la página (F5).

**Qué debes ver:** sigues en **Documentos**, con sesión, y arriba aparece **Administración**. La sesión se recuperó con la cookie de refresco (httpOnly): en F12 → Aplicación, el almacenamiento local y el de sesión están **vacíos**.

## 7. Más personas y sus tokens

Para los permisos y el tiempo real hacen falta más cuentas: **Bruno** (editor) y **Carla** (lectora).

**Desde la interfaz:** Marta abre **Administración** (`#/admin`) e invita a cada una con su nombre, su correo y sus permisos. **El enlace nunca aparece en esa pantalla**: llega solo al buzón.

**O con la CLI:**

```bat
scripts\invitar.bat --correo bruno.demo@example.com --nombre "Bruno Ficticio" --rol editor
scripts\invitar.bat --correo carla.demo@example.com --nombre "Carla Ficticia" --rol lector
```

Cada una lee su buzón (`scripts\buzon.bat <correo>`) y completa la cuenta. Puede hacerlo en otro navegador abriendo el enlace, o por el API, copiando el token del enlace (los 43 caracteres después de `#/invitacion/`):

```bat
set TOKEN=pega-aqui-el-token-de-bruno
curl -s -X POST http://127.0.0.1:4200/api/invitaciones/completar -H "content-type: application/json" -d "{\"token\":\"%TOKEN%\",\"contrasena\":\"una frase larga para bruno\"}"
set TOKEN=pega-aqui-el-token-de-carla
curl -s -X POST http://127.0.0.1:4200/api/invitaciones/completar -H "content-type: application/json" -d "{\"token\":\"%TOKEN%\",\"contrasena\":\"una frase larga para carla\"}"
```

**Qué debes ver:** cada respuesta trae `accessToken`, `expiraEn` y `usuario` (con su `id`).

**Tokens para los comandos.** El access token vive 15 minutos; si un comando responde `no_autenticado`, vuelve a entrar.

```bat
curl -s -X POST http://127.0.0.1:4200/api/auth/sesion -H "content-type: application/json" -d "{\"correo\":\"bruno.demo@example.com\",\"contrasena\":\"una frase larga para bruno\"}"
set BRUNO=pega-el-accessToken
curl -s -X POST http://127.0.0.1:4200/api/auth/sesion -H "content-type: application/json" -d "{\"correo\":\"carla.demo@example.com\",\"contrasena\":\"una frase larga para carla\"}"
set CARLA=pega-el-accessToken
```

Marta tiene MFA, así que su login es en dos pasos: primero un `desafio` (202), después el código.

```bat
curl -s -X POST http://127.0.0.1:4200/api/auth/sesion -H "content-type: application/json" -d "{\"correo\":\"marta.demo@example.com\",\"contrasena\":\"<su contraseña>\"}"
set DESAFIO=pega-el-desafio
scripts\totp.bat <secreto sin espacios>
curl -s -X POST http://127.0.0.1:4200/api/auth/mfa -H "content-type: application/json" -d "{\"desafio\":\"%DESAFIO%\",\"codigo\":\"<código de 6 dígitos>\"}"
set MARTA=pega-el-accessToken
```

**Qué debes ver:** el primer comando responde `202` con `"mfaRequerido":true`; el segundo, `201` con el `accessToken`.

## 8. Recorrido por tema

Cada bloque dice qué hacer, qué debes ver y qué prueba o mutación lo respalda. Las mutaciones se corren en el repo indicado con `scripts\mutar.bat <id>...`. Cada una rompe la regla a propósito, y tiene que salir `DETECTADA` con la prueba que falló como evidencia.

**Mutaciones y servidores abiertos:** una mutación cambia un archivo de `src/` mientras corren sus pruebas y después lo restaura (verificado por hash). Con `dev.bat` abierto en el mismo repo, el API o la página se recargan con cada mutación. Corre las mutaciones **después** de la parte en el navegador, o recarga la página al terminar.

### Bloque A: migraciones y pruebas SQL

```bat
cd /d "%RAIZ%\editor-ia-database"
scripts\db-test.bat
scripts\mutar.bat A14 A17
```

**Qué debes ver:** las pruebas Vitest y `Pruebas SQL: ... OK, 0 fallidas (base cuaderno_test)`. Las dos mutaciones salen `DETECTADA`: cada caso SQL termina en `ROLLBACK`, y `afirmar_error` exige el SQLSTATE exacto.

**Una migración aplicada no se edita,** y la guarda impide que las pruebas toquen tu base: pasos 3 y 5 de [demo-A](https://github.com/Jonar519/editor-ia-database/blob/main/docs/demo-A.md).

### Bloque B: cuenta pendiente sin sesiones

La base impide que una cuenta pendiente tenga sesiones o tokens, con un CHECK y una clave foránea compuesta (migraciones 0003–0006).

```bat
cd /d "%RAIZ%\editor-ia-database"
scripts\mutar.bat B01 B02 B03
```

**Qué debes ver:** las tres `DETECTADA`. Para verlo en psql: [demo-B](https://github.com/Jonar519/editor-ia-database/blob/main/docs/demo-B.md), paso 4.

### Bloque C: historial y aislamiento en la base

```bat
cd /d "%RAIZ%\editor-ia-database"
scripts\mutar.bat C01 C19
```

**Qué debes ver:** `DETECTADA` las dos: las versiones de solo inserción y el aislamiento de los fragmentos de la IA. Manipular el historial a mano está en el [bloque R](#bloque-r-cierre) (R1), con la interfaz.

### Bloque D: esqueleto del backend

```bat
cd /d "%RAIZ%\editor-ia-backend"
for /f "tokens=1,* delims==" %a in ('findstr /b "METRICS_TOKEN=" .env') do @curl -s http://127.0.0.1:4200/metrics -H "authorization: Bearer %b" | findstr /b "cuaderno_http_duracion_segundos_count"
```

**Qué debes ver:** una línea por ruta, método y estado, como `cuaderno_http_duracion_segundos_count{metodo="GET",ruta="/health",estado="200"} 1`. La etiqueta `ruta` es el **patrón** (`/api/documentos/:documentoId`), nunca la URL con el id.

**Redis caído** (la ventana del API sigue abierta):

```bat
docker stop cuaderno_redis
curl -s -w " %{http_code}\n" http://127.0.0.1:4200/ready
curl -s -w " %{http_code}\n" http://127.0.0.1:4200/health
docker start cuaderno_redis
```

**Qué debes ver:** `/ready` responde `503` con `"redis":"falla"`, y `/health` sigue en `200`: solo dice que el proceso vive. Con Redis de vuelta, `/ready` vuelve a `200`.

**SIGTERM real y las negativas de producción**, en el contenedor de Linux contra la base de pruebas:

```bat
scripts\bd-preparar.bat
npm run build
scripts\demo-linux.bat sigterm
scripts\demo-linux.bat produccion
```

**Qué debes ver:** el apagado ordenado (`/ready` en 503 apenas empieza, y los recursos cerrados una vez), y producción negándose a arrancar con proveedores `mock` y con el usuario dueño de las tablas. Detalle en [demo-D](demo-D.md), pasos 6 y 7.

```bat
scripts\mutar.bat S05 S08 S18 S24
```

### Bloque E: invitaciones y sesión

El refresh rotativo y su reutilización, con Bruno. Entra y guarda la cookie de refresco: es el valor de `cuaderno_refresco` en `Set-Cookie`, hasta antes del primer `;`.

```bat
curl -s -i -X POST http://127.0.0.1:4200/api/auth/sesion -H "content-type: application/json" -d "{\"correo\":\"bruno.demo@example.com\",\"contrasena\":\"una frase larga para bruno\"}"
set ACCESO=pega-el-accessToken
set REFRESCO1=pega-el-valor-de-la-cookie
curl -s -i -X POST http://127.0.0.1:4200/api/auth/refresco -H "cookie: cuaderno_refresco=%REFRESCO1%"
set REFRESCO2=pega-el-valor-nuevo
curl -s -X POST http://127.0.0.1:4200/api/auth/refresco -H "cookie: cuaderno_refresco=%REFRESCO1%"
curl -s -X POST http://127.0.0.1:4200/api/auth/refresco -H "cookie: cuaderno_refresco=%REFRESCO2%"
curl -s http://127.0.0.1:4200/api/auth/yo -H "authorization: Bearer %ACCESO%"
curl -s -X POST http://127.0.0.1:4200/api/auth/refresco -H "origin: http://otro-sitio.example.com" -H "cookie: cuaderno_refresco=x"
```

**Qué debes ver:**

1. El refresco da `200`, otro `accessToken` y un `cuaderno_refresco` **distinto**. La cookie es `HttpOnly; Secure; SameSite=Strict` y solo viaja a `/api/auth`.
2. Reutilizar el viejo: `refresco_reutilizado`.
3. El nuevo también falla (`refresco_invalido`): se revocó la familia entera.
4. El access token ya no sirve: `no_autenticado`. La sesión se verifica viva en cada pedido.
5. Un refresco desde otro sitio: `origen_no_permitido`. El navegador manda el `Origin`; `curl` sin él no lo manda, y por eso los anteriores pasan.

**Bloqueo sin enumeración de cuentas:** 5 contraseñas incorrectas y después la correcta; y lo mismo con un correo que no existe.

```bat
for /l %i in (1,1,5) do @curl -s -o NUL -w "%{http_code} " -X POST http://127.0.0.1:4200/api/auth/sesion -H "content-type: application/json" -d "{\"correo\":\"bruno.demo@example.com\",\"contrasena\":\"incorrecta-123456\"}"
curl -s -i -X POST http://127.0.0.1:4200/api/auth/sesion -H "content-type: application/json" -d "{\"correo\":\"bruno.demo@example.com\",\"contrasena\":\"una frase larga para bruno\"}"
for /l %i in (1,1,6) do @curl -s -o NUL -w "%{http_code} " -X POST http://127.0.0.1:4200/api/auth/sesion -H "content-type: application/json" -d "{\"correo\":\"nadie.demo@example.com\",\"contrasena\":\"incorrecta-123456\"}"
```

**Qué debes ver:** `401 401 401 401 401` y luego `429` con `Retry-After` y `cuenta_bloqueada`, **aunque la contraseña sea correcta**. Con el correo inexistente, lo mismo: `401 401 401 401 401 429`. El bloqueo de Bruno dura unos 60 s.

```bat
scripts\mutar.bat E07 E08 E13 E15 E16
```

Detalle completo, con la consulta de la invitación y la contraseña débil: [demo-E](demo-E.md).

### Bloque F: MFA, recuperación y auditoría

- **Login en dos pasos:** ya está en el paso 7 (Marta).
- **Código de respaldo de un solo uso:** en la interfaz, **Salir**, entra como Marta y en el segundo paso elige "Usar un código de respaldo". Repite con el **mismo** código: "El código no es válido...".
- **El MFA de un admin no se desactiva:** en `#/cuenta/dos-pasos` no está la opción. Por el API:

```bat
curl -s -X DELETE http://127.0.0.1:4200/api/cuenta/mfa -H "authorization: Bearer %MARTA%" -H "content-type: application/json" -d "{\"codigo\":\"000000\"}"
```

**Qué debes ver:** `409` `mfa_obligatorio`.

- **Recuperación sin enumeración:** en Entrar, "¿Olvidaste tu contraseña?" con `carla.demo@example.com` y con `nadie.demo@example.com`: **el mismo mensaje**. `scripts\buzon.bat carla.demo@example.com` muestra el enlace `#/recuperar/...`; al abrirlo, el token se borra de la URL.
- **Auditoría** (`eventos_seguridad`: tipo, cuenta e IP truncada; nunca un token):

```bat
docker exec cuaderno_postgres psql -U cuaderno -d cuaderno -c "SELECT tipo, ip_red, creado_en FROM eventos_seguridad ORDER BY id DESC LIMIT 8"
```

```bat
cd /d "%RAIZ%\editor-ia-backend"
scripts\mutar.bat G05 G06 G07 G01 G02
```

G05 y G06 son el anti-replay, G07 el secreto cifrado y ligado a la cuenta, y G01 y G02 que ningún token quede en los logs ni en la base. Detalle: [demo-F](demo-F.md).

### Bloque G: perfil, sesiones y datos

En la interfaz, como Bruno, en otro navegador:

- **`#/cuenta/foto`:** sube un JPEG con datos de GPS (cualquier foto de teléfono). Se recorta en el navegador y el servidor la limpia igual.
- **`#/cuenta/sesiones`:** con Bruno abierto en dos navegadores, cierra la otra sesión desde uno. En el otro, el siguiente pedido lleva a **Entrar**.
- **`#/cuenta/correo`:** cambiar el correo manda el enlace al correo **nuevo** y un aviso al anterior (`scripts\buzon.bat` con cada dirección).
- **`#/cuenta/datos`:** **Descargar los datos** da un JSON sin secretos. **Eliminar la cuenta** con propiedad compartida responde con qué hay que transferir (lo muestra el [bloque K1](#bloque-k1-espacios-documentos-y-permisos)).

```bat
cd /d "%RAIZ%\editor-ia-backend"
scripts\mutar.bat U01 U12 U26 U28 U32
```

Detalle, con `curl` y el avatar: [demo-G](demo-G.md). La retención (job diario de BullMQ): [data-retention.md](data-retention.md).

### Bloques H1 a J: interfaz de identidad

```bat
cd /d "%RAIZ%\editor-ia-frontend"
scripts\revisar.bat
scripts\mutar.bat H42 H26 H35
```

**Qué debes ver:** `revisar` pasa la auditoría de significado de color (R1–R7), el contraste AA de cada par en los dos temas y los presupuestos de peso por rol. Las mutaciones salen `DETECTADA`: el token fuera de la URL (H42), un solo refresco a la vez (H26) y el Service Worker que nunca cachea `/api` (H35).

En el navegador:

- **Tema:** cambia Windows a modo oscuro (Configuración → Personalización → Colores). Cuaderno cambia de tema solo.
- **Sin red:** con el build (`npm run build` y `npm run preview`), F12 → Red → "Sin conexión" y recarga. Carga el armazón desde la caché; `/api` nunca sale de la caché.
- **Teclado:** Tab desde el principio. El primer foco es "Saltar al contenido", y el foco se ve siempre.

Detalle: [demo-H1](https://github.com/Jonar519/editor-ia-frontend/blob/main/docs/demo-H1.md), [H2](https://github.com/Jonar519/editor-ia-frontend/blob/main/docs/demo-H2.md), [I](https://github.com/Jonar519/editor-ia-frontend/blob/main/docs/demo-I.md) y [J](https://github.com/Jonar519/editor-ia-frontend/blob/main/docs/demo-J.md).

### Bloque K1: espacios, documentos y permisos

Marta crea un espacio en `#/documentos` ("Equipo de demo"). Copia su id del API:

```bat
curl -s http://127.0.0.1:4200/api/espacios -H "authorization: Bearer %MARTA%"
set ESP=pega-el-id-del-espacio
curl -s -X POST http://127.0.0.1:4200/api/espacios/%ESP%/miembros -H "authorization: Bearer %MARTA%" -H "content-type: application/json" -d "{\"correo\":\"BRUNO.DEMO@example.com\",\"rol\":\"editor\"}"
curl -s -X POST http://127.0.0.1:4200/api/espacios/%ESP%/miembros -H "authorization: Bearer %MARTA%" -H "content-type: application/json" -d "{\"correo\":\"carla.demo@example.com\",\"rol\":\"editor\"}"
curl -s -X POST http://127.0.0.1:4200/api/espacios/%ESP%/miembros -H "authorization: Bearer %MARTA%" -H "content-type: application/json" -d "{\"correo\":\"carla.demo@example.com\",\"rol\":\"lector\"}"
curl -s -X POST http://127.0.0.1:4200/api/espacios/%ESP%/miembros -H "authorization: Bearer %MARTA%" -H "content-type: application/json" -d "{\"correo\":\"nadie.demo@example.com\",\"rol\":\"lector\"}"
```

**Qué debes ver:**

1. El espacio con `"rol":"propietario"`.
2. Bruno agregado como editor (las mayúsculas del correo dan igual).
3. Carla como editora: `409` `rol_excede_cuenta` (es una cuenta de solo lectura).
4. Carla como lectora: agregada.
5. Un correo sin cuenta: `404` `cuenta_no_encontrada`, igual que una cuenta pendiente o eliminada.

Bruno crea un documento; Carla no puede:

```bat
curl -s -X POST http://127.0.0.1:4200/api/espacios/%ESP%/documentos -H "authorization: Bearer %BRUNO%" -H "content-type: application/json" -d "{\"titulo\":\"Plan de despliegue\"}"
set DOC=pega-el-id-del-documento
curl -s -o NUL -w "%{http_code}\n" -X POST http://127.0.0.1:4200/api/espacios/%ESP%/documentos -H "authorization: Bearer %CARLA%" -H "content-type: application/json" -d "{\"titulo\":\"No\"}"
curl -s http://127.0.0.1:4200/api/documentos/%DOC% -H "authorization: Bearer %MARTA%"
```

**Qué debes ver:** el documento de Bruno con `"rol":"propietario"`; Carla, `403`; y para Marta, `"rol":"editor"`: ser propietaria del **espacio** no da la propiedad del documento.

**Sin acceso, 404; sin el rol, 403.** La transferencia y el `409 propiedad_documentos` están en [demo-K1](demo-K1.md), paso 4.

```bat
cd /d "%RAIZ%\editor-ia-backend"
scripts\mutar.bat W06 W11 W17
cd /d "%RAIZ%\editor-ia-database"
scripts\mutar.bat K01 K11
```

### Bloque K2: tiempo real

Protocolo completo en [protocolo-tiempo-real.md](protocolo-tiempo-real.md).

**El ticket** (un solo uso, 30 s; en Redis solo su hash):

```bat
curl -s -X POST http://127.0.0.1:4200/api/tiempo-real/tickets -H "authorization: Bearer %BRUNO%" -H "content-type: application/json" -d "{\"documentoId\":\"%DOC%\"}"
```

**Qué debes ver:** `201` con `{"ticket":"...","expiraEnSegundos":30}`. Viaja en `Sec-WebSocket-Protocol`, nunca en la URL.

**Un sitio ajeno no abre el WebSocket** (secuestro de WebSocket entre sitios):

```bat
curl -s -o NUL -w "%{http_code}\n" -H "Origin: http://otro-sitio.example.com" ws://127.0.0.1:4200/api/tiempo-real
```

**Qué debes ver:** `403`, antes de mirar el ticket. El `curl` de Windows abre WebSocket (`ws://`) y arma él mismo la cabecera del handshake. Como la respuesta es un error, sale con código 22.

**Revocación en vivo, con dos navegadores.** En uno entra Marta y en el otro Bruno. Los dos abren el mismo documento: Bruno en el editor, Marta en la lectura. Marta quita a Bruno del espacio:

```bat
curl -s http://127.0.0.1:4200/api/auth/yo -H "authorization: Bearer %BRUNO%"
curl -s -o NUL -w "%{http_code}\n" -X DELETE http://127.0.0.1:4200/api/espacios/%ESP%/miembros/<id de Bruno> -H "authorization: Bearer %MARTA%"
```

**Qué debes ver:** `409 propiedad_documentos`, porque Bruno posee el documento. Antes, Bruno lo transfiere a Marta:

```bat
curl -s -X POST http://127.0.0.1:4200/api/documentos/%DOC%/propiedad -H "authorization: Bearer %BRUNO%" -H "content-type: application/json" -d "{\"usuarioId\":\"<id de Marta>\"}"
curl -s -o NUL -w "%{http_code}\n" -X DELETE http://127.0.0.1:4200/api/espacios/%ESP%/miembros/<id de Bruno> -H "authorization: Bearer %MARTA%"
```

**Qué debes ver:** `204`, y en el navegador de Bruno, **en el acto**, «Conexión: Ya no tienes acceso a este documento.»: el servidor cortó su WebSocket. La base avisa con `NOTIFY`, Redis lo reenvía y el servidor corta la conexión (medido: 8–19 ms). Para seguir con los bloques siguientes, Marta vuelve a agregar a Bruno como editor (el `POST .../miembros` de K1).

```bat
cd /d "%RAIZ%\editor-ia-backend"
npx vitest run tests/integracion/tiempo-real.test.ts
scripts\mutar.bat T01 T02 T03 T06 T08
```

**Qué debes ver:** la prueba de integración con sockets reales: ticket, Origin, guardia, revocación y la ventana de R-01 medida. Las mutaciones salen `DETECTADA`: T01 y T08 son el guardia, que descarta lo de un lector y lo cierra con 4403 a la tercera; T02 el ticket de un solo uso; T03 el Origin; T06 el puente de avisos.

### Bloque L: editor y presencia

Con dos navegadores, Marta y Bruno abren el mismo documento en el **editor** (`Editar`).

**Qué debes ver:**

- Lo que escribe uno aparece en el otro al instante. "Conexión: Conectado" siempre a la vista, con texto.
- **Aquí ahora:** los dos nombres, cada uno con su color. El cursor y la selección del otro llevan su **nombre**, que sale de la cuenta que autenticó el servidor y no de lo que manda el cliente.
- **Ctrl+Z** deshace solo lo propio.
- **Tab** sale del editor al siguiente control; **Ctrl+]** y **Ctrl+[** cambian la sangría.

```bat
cd /d "%RAIZ%\editor-ia-backend"
scripts\mutar.bat T07 T09
cd /d "%RAIZ%\editor-ia-frontend"
scripts\mutar.bat L01 L02 L03
```

### Bloque M: convergencia y sin conexión

En el navegador de Bruno, con el editor abierto: F12 → Red → "Sin conexión". Escribe una línea.

**Qué debes ver:** "Conexión: Sin conexión" y debajo, que los cambios están guardados en el dispositivo. Cierra la pestaña, vuelve a abrir el documento, quita "Sin conexión" y espera la reconexión. Lo escrito llega a Marta **una sola vez**.

```bat
cd /d "%RAIZ%\editor-ia-backend"
npx vitest run tests/integracion/convergencia.test.ts
scripts\mutar.bat M01
cd /d "%RAIZ%\editor-ia-frontend"
scripts\mutar.bat M01 M02 M03 M04
```

**Qué debes ver:** la prueba de convergencia con semilla contra el servidor y la base reales (réplicas, cortes, duplicados y compactación), y cada mutación `DETECTADA`. La M01 del backend es el fallo que encontró esta prueba: se perdía en la base lo que llegaba durante un `INSERT`.

### Bloque N: versiones y comentarios

En el editor, Bruno selecciona un tramo y escribe un comentario en **Comentar la selección**. Después escribe texto **antes** del tramo comentado.

**Qué debes ver:** el comentario sigue marcando el mismo tramo, porque el ancla son dos posiciones relativas de Yjs. En el navegador de Marta aparece sin recargar.

En **Historial de versiones**:

1. **Guardar una versión ahora** («Listo: Guardaste la versión 1.»).
2. Cambia el texto en el editor y guarda la versión 2.
3. **Comparar** la 1 con el texto actual. La diferencia por líneas se calcula en un Web Worker y se muestra con + / − y con texto, no solo con color.
4. **Restaurar** la versión 1: es un **cambio nuevo**. Llega al editor de Marta y el historial suma una versión «restauración», sin reescribir nada.

```bat
cd /d "%RAIZ%\editor-ia-backend"
scripts\mutar.bat N01 N05 N09
cd /d "%RAIZ%\editor-ia-frontend"
scripts\mutar.bat N01 N02
```

### Bloque O: vista renderizada y comandos

En el editor:

- **Ctrl+K** abre la paleta de comandos; con las flechas se elige un comando y Enter lo aplica. **/** al principio de una línea abre el menú de bloques. **Ctrl+B** pone negrita.
- Escribe `$E = mc^2$` y un bloque de código con ` ```js `. Presiona **Vista previa**: la fórmula con KaTeX y el código resaltado. Los dos se descargan **solo** al aparecer (F12 → Red).
- Escribe `<img src=x onerror=alert(1)>` y `[enlace](javascript:alert(1))`. En la vista previa, el HTML se ve **como texto** y el enlace no lleva a `javascript:`.
- En la vista previa, selecciona un trozo y comenta: el comentario queda anclado al Markdown fuente.

```bat
cd /d "%RAIZ%\editor-ia-frontend"
scripts\mutar.bat O01 O02 O03 O04 O06
```

### Bloque P1: gRPC

El API y el servicio de IA hablan por **gRPC**: el navegador nunca lo ve. Contrato: `proto/cuaderno/ia/v1/ia.proto`.

| Tipo de llamada | Método | Dónde se ve |
|---|---|---|
| Unaria | `Explicar` | IA → Explicar la selección |
| Del servidor (streaming) | `Resumir`, `Mejorar` | IA → Resumir, Mejorar: el texto llega por partes |
| Del cliente (streaming) | `IndexarDocumento` | IA → Actualizar índice de búsqueda |
| Bidireccional | `Autocompletar` | Sugerencias de la IA mientras escribes |

**La IA caída no tumba el API:** cierra la ventana de `ia.bat` (Ctrl+C).

```bat
curl -s -w " %{http_code}\n" http://127.0.0.1:4200/ready
```

**Qué debes ver:** `200` con `"ia":"falla"`: es informativa. En la interfaz, la IA responde "no disponible". Vuelve a abrir `scripts\ia.bat`: se recupera sin reiniciar el API.

```bat
cd /d "%RAIZ%\editor-ia-backend"
npm run proto:check
npx vitest run tests/integracion/ia-grpc.test.ts
scripts\mutar.bat P01 P03 P04 P13 P27
```

**Qué debes ver:** `buf lint` y `buf breaking` contra `main` sin errores; las pruebas con gRPC real; y las mutaciones `DETECTADA`:

| Mutación | Qué rompe |
|---|---|
| P01 y P03 | Sin token o con uno equivocado, `UNAUTHENTICATED` (comparado en tiempo constante) |
| P04 | Cancelar o vencer el deadline corta al proveedor |
| P13 | `RESOURCE_EXHAUSTED` → 429 con `Retry-After` |
| P27 | `buf breaking` detecta un cambio incompatible |

### Bloque P2: búsqueda, inyección y topes

En el editor de Bruno, **IA → Actualizar índice de búsqueda**. En `#/documentos`, escribe en **Buscar por significado** una palabra del documento.

**Qué debes ver:** los fragmentos del documento, como texto. La búsqueda es **solo** del espacio pedido y de los documentos con acceso hoy: Carla no ve los de un espacio donde no está, y buscar en un espacio ajeno da 404.

```bat
curl -s http://127.0.0.1:4200/api/ia/uso -H "authorization: Bearer %BRUNO%"
cd /d "%RAIZ%\editor-ia-backend"
npx vitest run tests/unitarias/ia-prompt.test.ts tests/integracion/ia-p2.test.ts
scripts\mutar.bat P19 P28 P29 P16 P37
cd /d "%RAIZ%\editor-ia-database"
scripts\mutar.bat P04
```

**Qué debes ver:** el uso de hoy con sus topes (300 pedidos y 300 000 tokens por día). La batería de inyección: el contenido del documento va escapado dentro de un bloque con nonce y las instrucciones van aparte (P28–P29). P16 es el tope diario atómico, P37 el presupuesto del espacio, y P19 y la P04 de la base son el aislamiento de la búsqueda.

### Bloque P3: medición gRPC frente a REST/JSON

```bat
cd /d "%RAIZ%\editor-ia-backend"
scripts\medir.bat --rapido
```

**Qué debes ver:** la misma operación por gRPC y por REST/JSON (HTTP/1.1 y h2c). Se escriben `docs/medicion-p3.json` y `docs/medicion-p3.md`, que abre con **lo que la medición no permite concluir**. Si la CPU ya está ocupada (más del 10 %), no mide y lo dice: cierra otros programas. `--rapido` es solo para ver que funciona; la medición publicada es la completa, en [medicion-p3.md](medicion-p3.md). Restaura el informe publicado con `git checkout docs/medicion-p3.json docs/medicion-p3.md`.

### Bloque Q: asistente de IA

En el editor, como Bruno, botón **IA**:

- **Explicar la selección** y **Resumir el documento**: la respuesta llega por partes (SSE). **Detener** la corta, y el servicio deja de generar.
- **Mejorar la selección**: es una **propuesta**, con Reemplazar selección, Insertar debajo o Descartar. Nunca se aplica sola.
- **Sugerencias de la IA mientras escribes**: desactivadas al abrir. Al activarlas, aparece texto fantasma: **Tab** lo acepta y **Escape** lo descarta.
- "Hoy: N de 300 pedidos de IA."
- Todo lo de la IA es violeta; un error de la IA va en rojo.

Como Carla (lectora), en la lectura del documento: **IA** tiene Explicar y Resumir, pero **no** Mejorar, ni las sugerencias, ni el índice.

```bat
cd /d "%RAIZ%\editor-ia-frontend"
scripts\mutar.bat Q01 Q02 Q04 Q08 Q17
cd /d "%RAIZ%\editor-ia-backend"
npx vitest run tests/integracion/ia-autocompletado.test.ts
```

### Bloque R: cierre

**R1: verificar la cadena de versiones desde la interfaz.** En **Historial de versiones**, presiona **Verificar la cadena**: «La cadena está íntegra». Después manipula una versión como lo haría alguien con acceso a la base:

```bat
docker exec cuaderno_postgres psql -U cuaderno -d cuaderno -c "SET ROLE cuaderno_app; UPDATE versiones SET contenido_texto='x' WHERE documento_id='%DOC%';"
docker exec cuaderno_postgres psql -U cuaderno -d cuaderno -c "UPDATE versiones SET contenido_texto='x' WHERE documento_id='%DOC%';"
docker exec cuaderno_postgres psql -U cuaderno -d cuaderno -c "BEGIN; ALTER TABLE versiones DISABLE TRIGGER versiones_solo_insercion; UPDATE versiones SET contenido_texto='manipulado' WHERE documento_id='%DOC%' AND numero=1; ALTER TABLE versiones ENABLE TRIGGER versiones_solo_insercion; COMMIT;"
```

**Qué debes ver:**

1. La app no puede: `permission denied for table versiones`.
2. Ni el dueño, con el trigger puesto: `El historial de versiones es de solo inserción (UPDATE prohibido)`.
3. Solo el dueño, desactivando el trigger, logra cambiarla. Ahora **Verificar la cadena** dice «Error: La cadena está alterada desde la versión 1».

**R2: CSP.** Con el build (`npm run build` y `npm run preview` en el frontend), F12 → Consola:

```js
const s = document.createElement('script'); s.textContent = 'window.inyectado = 1'; document.body.append(s); window.inyectado
```

**Qué debes ver:** `undefined` y el aviso de la CSP: un script en línea no corre (`script-src 'self'`). En `dev.bat` no hay CSP, porque Vite mete estilos en línea.

**R3: carga.** Usa la base `cuaderno_carga_test`, que recrea, y la db 2 de Redis, que vacía; nunca la de desarrollo.

```bat
cd /d "%RAIZ%\editor-ia-backend"
npm run build
scripts\carga.bat --rapido
scripts\almacenamiento.bat --rapido
```

**Qué debes ver:** HTTP (H1–H4) y WebSocket (W1–W2) contra el API real; las dos corridas abren con lo que **no** permiten concluir. Los informes publicados son las corridas completas, en Windows y en Linux: [carga-r.md](carga-r.md) y [almacenamiento-r.md](almacenamiento-r.md). Restáuralos con `git checkout docs/`.

**R4: modelo de amenazas.** [modelo-amenazas.md](modelo-amenazas.md): el diagrama de flujo de datos, STRIDE por elemento y los riesgos residuales R-01 a R-07, cada uno con su evidencia.

**R4: límite general de 600 pedidos por minuto y cuenta.** Para verlo sin hacer 600 pedidos, bájalo un momento: en el `.env` del backend pon `LIMITE_PEDIDOS_MINUTO=5`, reinicia `dev.bat` y vuelve a entrar como Bruno (`set BRUNO=...`).

```bat
for /l %i in (1,1,6) do @curl -s -o NUL -w "%{http_code} " http://127.0.0.1:4200/api/espacios -H "authorization: Bearer %BRUNO%"
curl -s -i http://127.0.0.1:4200/api/espacios -H "authorization: Bearer %BRUNO%" | findstr /i "HTTP/ Retry-After demasiados"
curl -s -w " %{http_code}\n" http://127.0.0.1:4200/health
```

**Qué debes ver:** algunos `200` (hasta cinco) y después `429`, con `Retry-After` y `demasiados_intentos`, mientras `/health` sigue en `200`. Si Bruno tiene además un navegador abierto, esos pedidos también cuentan en su minuto y el `429` llega antes. **Deja `LIMITE_PEDIDOS_MINUTO=600`** y reinicia `dev.bat`.

```bat
npx vitest run tests/integracion/limite-general.test.ts
scripts\mutar.bat R08 R09 R10
```

**R4: un cuerpo comprimido no se descomprime** (GHSA-27r3-jxmh-p828):

```bat
curl -s -w " %{http_code}\n" -X POST http://127.0.0.1:4200/api/auth/sesion -H "content-type: application/json" -H "content-encoding: gzip" --data-binary "x"
```

**Qué debes ver:** `415` con `codificacion_no_admitida`.

**R5: modelo de dominio.** El [modelo de dominio](https://github.com/Jonar519/editor-ia-database/blob/main/docs/modelo-dominio.md) del repo de base: cada regla con dónde se aplica, su prueba y su mutación. Elige una fila y corre su mutación.

**R6: ADRs.** [ADR 0001 a 0008](adr/): cada uno separa lo verificado de lo implementado sin prueba propia.

**R7: OpenAPI y protocolo.**

```bat
cd /d "%RAIZ%\editor-ia-backend"
npm run openapi:check
npx vitest run tests/unitarias/openapi.test.ts
scripts\mutar.bat R11 R12 R13
```

**Qué debes ver:** `openapi.json` al día, y la prueba de que toda ruta de Express está documentada, con 429, `Retry-After` y 503 en todo `/api`. El protocolo del WebSocket: [protocolo-tiempo-real.md](protocolo-tiempo-real.md).

## 9. Pruebas y CI de los tres repos

Los mismos pasos que el CI, con el código de salida real de cada uno. Las mutaciones tardan varios minutos.

```bat
cd /d "%RAIZ%\editor-ia-database"
scripts\ci.bat
cd /d "%RAIZ%\editor-ia-backend"
scripts\bd-preparar.bat
scripts\ci.bat
cd /d "%RAIZ%\editor-ia-frontend"
scripts\ci.bat
```

**Qué debes ver:** `RESULTADO: OK` en los tres. El del frontend incluye las E2E (Playwright + axe, Chromium y Firefox) en el contenedor oficial de Linux.

`npm audit` muestra en el backend un aviso **moderado** de `fast-uri`, solo de desarrollo: su versión corregida cumple 14 días el 2-11-2026 ([ADR 0008](adr/0008-dependencias.md)). El CI pasa porque su umbral es `high`.

## 10. Lo no medido o no cubierto

Todo lo declarado en los bloques, reunido. Ninguna de estas cosas se demuestra en esta guía.

### No medido

| Qué | Por qué | Dónde está declarado |
|---|---|---|
| El recorte del avatar con fotos reales de cámara en **Firefox** | La E2E usa un PNG generado; la prueba en vivo con JPEG fue en Chrome | [Lista de revisión](https://github.com/Jonar519/editor-ia-frontend/blob/main/docs/revision-bloque-R.md) del frontend |
| **Safari** | Las E2E corren en Chromium y Firefox | Lista de revisión; ADR [0004](adr/0004-motor-de-edicion.md), [0005](adr/0005-frontend-sin-framework.md) y [0007](adr/0007-sin-conexion.md) |
| **Demo J, pasos 8 y 9:** el foco en las confirmaciones (cancelar una invitación, eliminar la cuenta) y olvidar la sesión después de eliminar la cuenta | Los cubre solo la E2E, sin mutación | Lista de revisión |
| Un lector de pantalla real, IME y teclados de móvil | No se probaron con personas ni dispositivos | ADR 0004 y 0005 |
| Una suspensión real del equipo sin conexión | La E2E corta la red con `setOffline`; no suspende | ADR 0007 |
| **Windows en P3:** un piso de 2–3 ms por llamada en gRPC y REST HTTP/1.1 con mensajes chicos, que no aparece en Linux | Su causa no se investigó (decisión escrita): corregirlo exige cambiar la configuración TCP del sistema. La corrida de Windows no sirve para comparar transportes; la referencia es la de Linux | [medicion-p3.md](medicion-p3.md) |
| La capacidad en producción, otra máquina, red real, TLS, una base grande y los efectos de largo plazo | La carga corre en una sola máquina, por loopback, 30 s por corrida | [carga-r.md](carga-r.md), «Lo que esta medición NO permite concluir» |

### No cubierto por pruebas automáticas (implementado)

| Qué | Dónde está declarado |
|---|---|
| **K2:** el latido (4408), la cola de envío de 4 MiB (1013), el cierre al vencer la sesión con la conexión abierta (4401), Redis caído al entrar (503), revalidar todo al reconectar, el apagado ordenado (1001) y el mensaje de más de 1 MiB (1009) | [ADR 0002](adr/0002-comunicacion.md) |
| **M:** vaciar la copia local si entra otra cuenta, borrarla al eliminar la cuenta o restablecer la contraseña, al perder el acceso, juntarla cada 100 filas, seguir en memoria si IndexedDB falla, y la reconexión según cada código de cierre | [ADR 0007](adr/0007-sin-conexion.md) |
| **N:** el disparo real de la versión automática por BullMQ, y los límites de tasa de versiones y comentarios | [README general](README-general.md) |
| **P1 y P2:** TLS mutuo, el apagado del servicio con SIGTERM (en Windows no se puede mandar a un proceso hijo), `Health.Watch`, la contrapresión, los reintentos del indexado, la caché de `Describir`, que el indexado pospuesto corra al día siguiente y `reindexar.bat` | [ADR 0002](adr/0002-comunicacion.md) |
| **Q**, en lo que toca al asistente: <ul><li>el latido SSE cada 15 s (se prueba la cabecera `X-Accel-Buffering`, no el latido);</li><li>que una sugerencia vieja que llega tarde no se responda en el servidor, y que la corriente del autocompletado se reabra si se corta;</li><li>el límite de 30 pedidos de IA por minuto;</li><li>que la lectura no descargue CodeMirror entero: lo asegura el tope de 140 KiB del rol lector, y la prueba directa existe solo para el panel (front Q17);</li><li>la calidad de las respuestas: todo corre con el proveedor **simulado**, sin IA real.</li></ul> | ADR [0002](adr/0002-comunicacion.md) (tabla de P1) y [0004](adr/0004-motor-de-edicion.md) |
| El `FOR UPDATE` sobre los espacios en `eliminar_cuenta()`: es una carrera entre dos conexiones, y las pruebas SQL corren en una sola | [Modelo de dominio](https://github.com/Jonar519/editor-ia-database/blob/main/docs/modelo-dominio.md) |

### Riesgos que siguen abiertos hasta el despliegue

| Riesgo | Qué falta |
|---|---|
| **R-03:** tráfico entre el API y la IA con `IA_RED_PRIVADA=true` | Con esa opción, el token y el contenido viajan en texto plano; nada comprueba que la red sea de verdad privada. Se elige entre TLS mutuo y una red privada concreta al desplegar. |
| **R-04:** inyección de prompts desde un documento compartido | La batería prueba la estructura del prompt contra un modelo «ingenuo»; **no se corrió contra un modelo real**, porque no hay IA real. Se corre al elegir el proveedor. |
| **R-06:** la CSP en el despliegue | La CSP va como `<meta>`, con `'unsafe-inline'` solo en `style-src-elem` y `style-src-attr`. Falta `frame-ancestors 'none'` **por cabecera** (no funciona en `<meta>`) y un nonce por respuesta (`EditorView.cspNonce`). |
| **R-02** y **R-07** | Aceptados: la alerta sobre el tamaño de `versiones` y el límite por IP en el proxy inverso. Ver «Antes del despliegue» en el [README general](README-general.md). |

### Problema conocido

**El crash nativo del trabajador de Vitest en Windows** (`0xC0000409`). Ocurre solo con la CPU saturada, alrededor de 1 vez cada 400 corridas; no tiene causa raíz conocida y nunca se vio en Linux. Si una corrida de pruebas termina con «Worker exited unexpectedly with exit code 3221226505» y sin ninguna línea FAIL, se repite. Detalle en el [README del backend](../README.md#problema-conocido-el-trabajador-de-vitest-muere-en-windows-con-la-cpu-saturada).

## Apéndice: base y Redis aparte

Para demostrar **sin tocar tu base de desarrollo ni tu Redis**, por ejemplo en un equipo que ya tiene Cuaderno. Así se verificó esta guía.

`db-up.bat` usa contenedores con nombre fijo (`cuaderno_postgres` y `cuaderno_redis`). Por eso, en un clon aparte se levantan otros contenedores en otros puertos, y se reemplaza solo `db-up.bat`:

1. En el clon de la base, `npm ci` y `scripts\env-init.bat`. En el `.env` que se creó, cambia `PGPORT=5435` por `PGPORT=5445` y `REDIS_PORT=6381` por `REDIS_PORT=6391`.
2. Levanta los contenedores con la contraseña de ese `.env`:

```bat
cd /d "%RAIZ%\editor-ia-database"
for /f "tokens=1,* delims==" %a in ('findstr /b "PGPASSWORD=" .env') do set PGPW=%b
docker run -d --name guia_postgres -e POSTGRES_USER=cuaderno -e POSTGRES_PASSWORD=%PGPW% -e POSTGRES_DB=cuaderno -e "POSTGRES_INITDB_ARGS=--encoding=UTF8 --locale=C.UTF-8" -e TZ=UTC -e PGTZ=UTC -p 127.0.0.1:5445:5432 pgvector/pgvector:pg16
docker run -d --name guia_redis -p 127.0.0.1:6391:6379 redis:7-alpine redis-server --appendonly yes
set PGPW=
node --env-file=.env scripts\usuario-app.mjs
scripts\db-migrate.bat dev
```

3. En el backend, `scripts\env-init.bat` arma `DATABASE_URL` con el puerto 5445. **`REDIS_URL` y `TEST_REDIS_URL` quedan en 6381**: cámbialos a mano a `redis://127.0.0.1:6391/0` y `redis://127.0.0.1:6391/1`.
4. Desde ahí, todo igual. En los comandos de `psql`, usa `guia_postgres` en lugar de `cuaderno_postgres`.

Al terminar: `docker rm -f guia_postgres guia_redis`.

## 12. Limpiar

- **Detener los procesos:** Ctrl+C en las ventanas del API, de la IA y del frontend.
- **Apagar los servicios:** `scripts\db-down.bat` en la base. Los datos se conservan.
- **Borrar las cuentas de demostración:** cada una puede eliminarse desde `#/cuenta/datos`. Una cuenta que es propietaria de algo compartido primero lo transfiere.
- **Empezar de cero:** `docker compose down -v` en `editor-ia-database` **borra todos los datos locales** de la base y de Redis.
