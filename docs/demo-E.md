# Demo · Bloque E: invitaciones y sesión

**Terminal:** `cmd.exe`, en la carpeta `editor-ia-backend`.

**Roles:**
- **Operador:** tú con la CLI. Invita a la primera cuenta sin necesitar un admin.
- **Persona invitada:** con rol **editor**. Lee su buzón simulado y completa la cuenta.

**Ojo:** esta demo **escribe en tu base de desarrollo** (crea una invitación y una cuenta) porque la haces tú.

**Datos:** solo ficticios (`@example.com`).

> **Límite conocido:** completar la invitación de un **admin** responde `409 mfa_requerido`, y el login de una cuenta con MFA responde `403 mfa_requerido`. El desafío TOTP llega en el bloque F. Por eso esta demo usa un editor.

## 1. Preparar

```bat
cd /d "...\editor-ia\editor-ia-database"
scripts\db-up.bat
cd /d "...\editor-ia\editor-ia-backend"
git pull
npm ci
npm run prisma:generate
scripts\env-init.bat
scripts\dev.bat
```

**Qué debes ver:** `env-init` dice `.env completado con: ACCESS_TOKEN_SECRET, APP_URL, COOKIE_SECURE, PASSWORD_HASH_COST, EMAIL_FROM, SES_REGION`. Después aparece el log `Cuaderno API escuchando`. Deja esa ventana abierta y usa **otra** ventana de cmd para lo que sigue.

## 2. Invitar (operador): el enlace NO se muestra

```bat
scripts\invitar.bat --correo ana.demo@example.com --nombre "Ana Ficticia" --rol editor
```

**Qué debes ver:**

- `Invitación creada para ana.demo@example.com (editor). Vence: ...`
- `El enlace se envió a su correo. Aquí no se muestra.`
- Ningún enlace ni token en la pantalla.

## 3. El buzón de la persona invitada

```bat
scripts\buzon.bat ana.demo@example.com
```

**Qué debes ver:** el correo con el enlace `http://127.0.0.1:5175/#/invitacion/<token>`. El token va en el **fragmento** (después de `#`): los navegadores nunca lo mandan al servidor.

Copia los 43 caracteres que siguen a `#/invitacion/` y guárdalos en una variable de cmd:

```bat
set TOKEN=pega-aqui-los-43-caracteres
```

## 4. Completar la cuenta

Primero, los datos que mostraría el formulario:

```bat
curl -s -X POST http://127.0.0.1:4200/api/invitaciones/consultar -H "content-type: application/json" -d "{\"token\":\"%TOKEN%\"}"
```

**Qué debes ver:** `{"nombre":"Ana Ficticia","correo":"ana.demo@example.com","rol":"editor","requiereMfa":false,...}`

Ahora, una contraseña débil:

```bat
curl -s -X POST http://127.0.0.1:4200/api/invitaciones/completar -H "content-type: application/json" -d "{\"token\":\"%TOKEN%\",\"contrasena\":\"corta\"}"
```

**Qué debes ver:** `400` con `"codigo":"contrasena_debil"` y `"detalles":["debe tener al menos 12 caracteres"]`.

Y una que cumple la política:

```bat
curl -s -i -X POST http://127.0.0.1:4200/api/invitaciones/completar -H "content-type: application/json" -d "{\"token\":\"%TOKEN%\",\"contrasena\":\"una frase larga para la demo\"}"
```

**Qué debes ver:**

- `HTTP/1.1 201`.
- La cabecera `Set-Cookie: cuaderno_refresco=...; Path=/api/auth; ...; HttpOnly; Secure; SameSite=Strict`.
- Un cuerpo con `accessToken`, `expiraEn` y `usuario`.

El mismo enlace por segunda vez:

```bat
curl -s -X POST http://127.0.0.1:4200/api/invitaciones/completar -H "content-type: application/json" -d "{\"token\":\"%TOKEN%\",\"contrasena\":\"una frase larga para la demo\"}"
```

**Qué debes ver:** `"codigo":"invitacion_invalida"`. El enlace es de un solo uso.

## 5. Iniciar sesión y usar el access token

```bat
curl -s -i -X POST http://127.0.0.1:4200/api/auth/sesion -H "content-type: application/json" -d "{\"correo\":\"ana.demo@example.com\",\"contrasena\":\"una frase larga para la demo\"}"
```

De la respuesta, copia dos valores a variables de cmd:

- el `accessToken` del cuerpo;
- el valor de `cuaderno_refresco` en `Set-Cookie`, hasta antes del primer `;`.

```bat
set ACCESO=pega-el-accessToken
set REFRESCO1=pega-el-valor-de-la-cookie
curl -s http://127.0.0.1:4200/api/auth/yo -H "authorization: Bearer %ACCESO%"
```

**Qué debes ver:** `{"usuario":{...,"rol":"editor"}}`.

## 6. Refresh rotativo y detección de reutilización

```bat
curl -s -i -X POST http://127.0.0.1:4200/api/auth/refresco -H "cookie: cuaderno_refresco=%REFRESCO1%"
```

**Qué debes ver:** `200`, un `accessToken` nuevo y un `Set-Cookie` con un `cuaderno_refresco` **distinto**. Guárdalo:

```bat
set REFRESCO2=pega-el-valor-nuevo
```

Ahora reutiliza el refresh **viejo**, como haría quien lo robó:

```bat
curl -s -X POST http://127.0.0.1:4200/api/auth/refresco -H "cookie: cuaderno_refresco=%REFRESCO1%"
curl -s -X POST http://127.0.0.1:4200/api/auth/refresco -H "cookie: cuaderno_refresco=%REFRESCO2%"
curl -s http://127.0.0.1:4200/api/auth/yo -H "authorization: Bearer %ACCESO%"
```

**Qué debes ver:**

1. `"codigo":"refresco_reutilizado"`
2. El refresh **nuevo** también falla: `"codigo":"refresco_invalido"`. Se revocó la familia completa.
3. El access token ya no sirve: `"codigo":"no_autenticado"`. La sesión se verifica viva en cada petición.

## 7. Bloqueo progresivo

Repite 5 veces un login con contraseña incorrecta y luego uno con la correcta:

```bat
for /l %i in (1,1,5) do @curl -s -o NUL -w "%{http_code} " -X POST http://127.0.0.1:4200/api/auth/sesion -H "content-type: application/json" -d "{\"correo\":\"ana.demo@example.com\",\"contrasena\":\"incorrecta-123456\"}"
curl -s -i -X POST http://127.0.0.1:4200/api/auth/sesion -H "content-type: application/json" -d "{\"correo\":\"ana.demo@example.com\",\"contrasena\":\"una frase larga para la demo\"}"
```

**Qué debes ver:**

- `401 401 401 401 401`.
- Luego `HTTP/1.1 429`, `Retry-After: 60` (aproximadamente) y `"codigo":"cuenta_bloqueada"`, aunque la contraseña sea correcta.

Haz lo mismo con un correo **inexistente** (por ejemplo `nadie.demo@example.com`). Ves exactamente lo mismo: el bloqueo no revela qué correos existen.

## 8. Pruebas y mutaciones

```bat
scripts\test.bat
scripts\mutar.bat E07 E08 E13 E15 E16
```

**Qué debes ver:**

- Las pruebas: todo `passed`.
- Las mutaciones: cada una `DETECTADA`, con la prueba que falló. Son la revocación por reutilización, el Origin, el bloqueo de correos inexistentes y el tiempo uniforme.

## 9. Todo lo que corre el CI

```bat
scripts\bd-preparar.bat
scripts\ci.bat
```

**Qué debes ver:** `RESULTADO: OK`.
