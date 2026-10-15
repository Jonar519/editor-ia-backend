# ADR 0001 · Sesión: access token en memoria + refresh rotativo en cookie

- **Estado:** aceptada (bloque E)
- **Fecha:** 2026-10-13

## Contexto

Cuaderno es una SPA (JavaScript sin framework) que habla con un API en el mismo origen. Los requisitos son:

- un access token de 15 minutos guardado **solo en memoria**;
- un refresh rotativo en una cookie httpOnly con SameSite=Strict y detección de reutilización;
- verificar en **cada petición** que la sesión siga viva;
- bloqueo progresivo tras logins fallidos;
- límites de intentos con Redis.

## Decisión

### Access token

- Es un JWT compacto con HMAC-SHA256 (`ACCESS_TOKEN_SECRET`), implementado con `node:crypto`, sin librería.
- **La cabecera es fija** (`{"alg":"HS256","typ":"JWT"}`) y se compara byte a byte. Cualquier otra se rechaza (`alg: none`, RS256, campos extra), así que no hay confusión de algoritmo posible.
- Los reclamos son `sub` (cuenta), `sid` (sesión), `iat` y `exp`. El rol **no** viaja en el token.
- Vive **15 minutos**. El cliente lo guarda en una variable, nunca en `localStorage` ni en `sessionStorage`.

### Sesión viva en cada petición

El middleware `requiereSesion` no confía solo en la firma. Además consulta la base: sesión no revocada, sesión no vencida y cuenta activa. Por eso:

- cerrar sesión, revocar por reutilización o anonimizar la cuenta corta el acceso **en la petición siguiente**, aunque al token le falten minutos;
- el rol se lee de la base, así que un cambio de rol rige de inmediato.

Esto cuesta una consulta por petición, indexada por la clave primaria de la sesión. Lo aceptamos a cambio de que la revocación sea inmediata.

### Refresh token

- Son 32 bytes aleatorios opacos. En la base se guarda **solo su SHA-256** (`tokens_refresco.token_hash`).
- Viaja en la cookie `cuaderno_refresco` con `HttpOnly`, `Secure`, `SameSite=Strict` y `Path=/api/auth`, de modo que no viaja al resto del API.
- **Rotación:** cada `POST /api/auth/refresco` marca el token presentado como usado y entrega uno nuevo de la **misma familia** (la sesión). La base garantiza un solo token vigente por sesión.
- **Detección de reutilización:** si llega un token **ya usado**, alguien lo copió. Se revoca la sesión entera (`reutilizacion_refresco`) y con ella su access token y el refresh nuevo. La víctima debe volver a iniciar sesión, pero el atacante tampoco puede seguir.
- **Defensa extra contra CSRF:** las rutas que usan la cookie exigen que el `Origin`, si viene, sea el del frontend (`APP_URL`).
- La sesión dura **7 días** desde el login, como plazo absoluto. El refresh nunca dura más que su sesión.

### Inicio de sesión

| Tema | Decisión |
|---|---|
| Contraseñas | scrypt (`node:crypto`), N = 2^15, r = 8, p = 1, con sal de 16 bytes. Formato `$scrypt$ln=..,r=..,p=..$sal$hash`, que exige un CHECK de la base. La política pide 12 a 128 caracteres y rechaza las comunes, las repetitivas y las que contienen el correo o el nombre. |
| Respuesta uniforme | La respuesta es la misma con contraseña incorrecta, correo inexistente o cuenta pendiente. Cuando no hay cuenta se verifica contra un **hash señuelo** del mismo costo, así que **también tarda lo mismo** (hay una prueba con costo 15). |
| Bloqueo progresivo | 5 fallos bloquean 1 min; cada fallo siguiente duplica, hasta 1 hora. Mientras está bloqueada no se verifica la contraseña. Las cuentas reales cuentan los fallos en la base (`fallos_login`, `bloqueada_hasta`) y los correos inexistentes en Redis, **con la misma política**: bloquearse no revela qué correos existen. |
| Límites de Redis | Hay ventanas fijas atómicas (Lua `INCR` + `PEXPIRE`) para login por IP (20 por 15 min), refresco (60 por min), invitación pública (30 por 15 min) e invitar por admin (50 por hora). Si Redis no responde, **fallan cerrado** con 503. |

### Alternativas descartadas

- **Sesión solo con cookie** (sin access token): obliga a protección CSRF en todo el API y mezcla la sesión con el WebSocket (bloque K).
- **Access token en `localStorage`:** quedaría expuesto a cualquier XSS.
- **Librería JWT:** agrega superficie (algoritmos, claves asimétricas) que no necesitamos. La implementación propia ocupa unas 40 líneas, tiene pruebas y su cabecera es fija.
- **argon2:** necesita compilación nativa en Windows. scrypt viene en Node y es adecuado con N = 2^15.

## Consecuencias

- Recargar la página pierde el access token y el cliente pide uno nuevo con la cookie (`/api/auth/refresco`). El frontend debe hacer **un solo refresco a la vez** (single-flight): dos refrescos simultáneos con la misma cookie cuentan como reutilización y cierran la sesión.
- Cambiar `ACCESS_TOKEN_SECRET` invalida todos los access tokens. Los refresh siguen sirviendo.
- Una cuenta con MFA no obtiene sesión solo con la contraseña.

## Actualización (bloque F): segundo paso MFA

- Con MFA confirmado, `POST /api/auth/sesion` responde **202** con un desafío opaco (32 bytes). En Redis solo se guarda su SHA-256, con 5 minutos de vida, y se consume con `GETDEL` al primer intento, acierte o no.
- `POST /api/auth/mfa` recibe el desafío y un código TOTP o uno de respaldo. Desafío inexistente, vencido, usado o código incorrecto: **la misma** respuesta 401, así que no revela si la cuenta existe.
- TOTP: RFC 6238 (SHA-1, 6 dígitos, 30 s) con tolerancia de ±1 paso. Solo se acepta un paso **mayor** al último aceptado: el código y la base lo exigen (UPDATE condicional y trigger), también bajo carrera.
- Los fallos de MFA suman a `fallos_login` y al bloqueo progresivo. El contador vuelve a cero solo al superar el segundo paso.
- La sesión resultante queda con `mfa_verificada`.
