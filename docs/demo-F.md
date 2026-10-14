# Demo · Bloque F: MFA, recuperación y auditoría

**Terminal:** `cmd.exe`, en la carpeta `editor-ia-backend`.

**Roles:**
- **Operador:** tú con la CLI. Invita a la primera cuenta de administración.
- **Persona invitada:** con rol **admin**. Configura MFA al completar la invitación.
- **App autenticadora:** `scripts\totp.bat <secreto>` imprime el código vigente, como lo haría la app del teléfono. Si prefieres el teléfono, usa el `uri` (`otpauth://...`) que devuelve el API.

**Ojo:** esta demo **escribe en tu base de desarrollo** porque la haces tú. Crea una invitación, una cuenta, eventos de seguridad y un token de recuperación.

**Datos:** solo ficticios (`@example.com`).

## 1. Preparar

Las migraciones 0014–0016 del repo de base deben estar aplicadas: el backend exige el esquema 16 y `/ready` responde 503 sin ellas.

```bat
cd /d "...\editor-ia\editor-ia-database"
git checkout main
git pull
scripts\db-up.bat
scripts\db-migrate.bat dev
cd /d "...\editor-ia\editor-ia-backend"
git checkout main
git pull
npm ci
npm run prisma:generate
scripts\dev.bat
```

**Qué debes ver:** `db-migrate` aplica `0014_inscripciones_mfa`, `0015_eventos_seguridad` y `0016_anti_replay_solo_ultimo_paso`. Después aparece el log `Cuaderno API escuchando`. Deja esa ventana abierta y usa **otra** ventana de cmd para lo que sigue.

## 2. Invitar a un admin y leer el buzón

```bat
scripts\invitar.bat --correo rosa.demo@example.com --nombre "Rosa Ficticia" --rol admin
scripts\buzon.bat rosa.demo@example.com
```

Copia los 43 caracteres que siguen a `#/invitacion/`:

```bat
set TOKEN=pega-aqui-los-43-caracteres
```

## 3. Un admin no se activa sin MFA

```bat
curl -s -X POST http://127.0.0.1:4200/api/invitaciones/consultar -H "content-type: application/json" -d "{\"token\":\"%TOKEN%\"}"
curl -s -X POST http://127.0.0.1:4200/api/invitaciones/completar -H "content-type: application/json" -d "{\"token\":\"%TOKEN%\",\"contrasena\":\"una frase larga para la demo\"}"
```

**Qué debes ver:**

1. `"rol":"admin","requiereMfa":true`.
2. `409` con `"codigo":"mfa_requerido"`. La cuenta sigue pendiente.

## 4. Configurar MFA y completar

```bat
curl -s -X POST http://127.0.0.1:4200/api/invitaciones/mfa -H "content-type: application/json" -d "{\"token\":\"%TOKEN%\"}"
```

**Qué debes ver:** `{"secreto":"...","uri":"otpauth://totp/Cuaderno:rosa.demo%40example.com?..."}`. El secreto se guarda **cifrado** (AES-256-GCM) en `inscripciones_mfa` y vence con la invitación. Guárdalo:

```bat
set SECRETO=pega-el-secreto
scripts\totp.bat %SECRETO%
```

Con el código que imprime (6 dígitos), completa antes de que venza:

```bat
curl -s -i -X POST http://127.0.0.1:4200/api/invitaciones/completar -H "content-type: application/json" -d "{\"token\":\"%TOKEN%\",\"contrasena\":\"una frase larga para la demo\",\"codigoTotp\":\"123456\"}"
```

**Qué debes ver:**

- `HTTP/1.1 201`, la cookie `cuaderno_refresco` y el `accessToken`.
- `"codigosRespaldo":[...]` con **10 códigos** `XXXXX-XXXXX`. Se muestran una sola vez: en la base solo queda su HMAC. Copia uno:

```bat
set RESPALDO=pega-un-codigo-de-respaldo
```

## 5. Login en dos pasos

```bat
curl -s -X POST http://127.0.0.1:4200/api/auth/sesion -H "content-type: application/json" -d "{\"correo\":\"rosa.demo@example.com\",\"contrasena\":\"una frase larga para la demo\"}"
```

**Qué debes ver:** `202` con `"mfaRequerido":true`, un `desafio` y `"expiraEnSegundos":300`. **No** hay access token ni cookie: la contraseña sola no abre sesión.

```bat
set DESAFIO=pega-el-desafio
scripts\totp.bat %SECRETO%
```

**Anti-replay:** si el código impreso es el **mismo** que usaste en el paso 4, espera a que cambie (lo indica `vence en ... s`). Un código ya aceptado no se acepta otra vez.

```bat
curl -s -X POST http://127.0.0.1:4200/api/auth/mfa -H "content-type: application/json" -d "{\"desafio\":\"%DESAFIO%\",\"codigo\":\"123456\"}"
```

**Qué debes ver:** `201` con `accessToken`. Si repites **exactamente** el mismo comando, ves `401` con `"codigo":"mfa_invalido"`. El desafío es de un solo uso (en Redis solo se guarda su hash). Un desafío inventado, vencido o ya usado responde **igual** que un código incorrecto.

## 6. Código de respaldo (un solo uso)

Pide otro desafío (repite el login del paso 5) y úsalo con el código de respaldo:

```bat
set DESAFIO=pega-el-desafio-nuevo
curl -s -X POST http://127.0.0.1:4200/api/auth/mfa -H "content-type: application/json" -d "{\"desafio\":\"%DESAFIO%\",\"codigoRespaldo\":\"%RESPALDO%\"}"
```

**Qué debes ver:** `201`. Con un desafío nuevo y el **mismo** código de respaldo: `401 mfa_invalido`.

## 7. El MFA de un admin no se puede desactivar

Con el `accessToken` del paso anterior y un código vigente:

```bat
set ACCESO=pega-el-accessToken
curl -s -X DELETE http://127.0.0.1:4200/api/cuenta/mfa -H "authorization: Bearer %ACCESO%" -H "content-type: application/json" -d "{\"codigo\":\"123456\"}"
```

**Qué debes ver:** `409` con `"codigo":"mfa_obligatorio"`. Para editor y lector el MFA es **opcional**: `POST /api/cuenta/mfa/iniciar`, `/confirmar` y `DELETE /api/cuenta/mfa` (prueba `mfa.test.ts`).

## 8. Recuperación de contraseña

Una cuenta real y una inexistente:

```bat
curl -s -w " %{http_code} %{time_total}s\n" -X POST http://127.0.0.1:4200/api/auth/recuperacion -H "content-type: application/json" -d "{\"correo\":\"rosa.demo@example.com\"}"
curl -s -w " %{http_code} %{time_total}s\n" -X POST http://127.0.0.1:4200/api/auth/recuperacion -H "content-type: application/json" -d "{\"correo\":\"nadie.demo@example.com\"}"
```

**Qué debes ver:** las dos respuestas son **idénticas** (`202` y el mismo mensaje) y tardan lo mismo. El API responde **antes** de buscar la cuenta.

```bat
scripts\buzon.bat rosa.demo@example.com
set RTOKEN=pega-los-43-caracteres-de-#/recuperar/
curl -s -i -X POST http://127.0.0.1:4200/api/auth/recuperacion/completar -H "content-type: application/json" -d "{\"token\":\"%RTOKEN%\",\"contrasena\":\"otra frase larga para la demo\"}"
curl -s -X POST http://127.0.0.1:4200/api/auth/recuperacion/completar -H "content-type: application/json" -d "{\"token\":\"%RTOKEN%\",\"contrasena\":\"otra frase larga para la demo\"}"
curl -s http://127.0.0.1:4200/api/auth/yo -H "authorization: Bearer %ACCESO%"
```

**Qué debes ver:**

1. `204`.
2. `400 enlace_invalido`: el enlace es de un solo uso (vence a los 15 min).
3. `401 no_autenticado`: restablecer **cierra todas las sesiones**.
4. En el buzón aparece además el aviso `Tu contraseña de Cuaderno cambió`.

## 9. Auditoría: `eventos_seguridad`

En el repo de base, con una conexión de solo lectura:

```bat
cd /d "...\editor-ia\editor-ia-database"
docker compose exec -T postgres psql -U cuaderno -d cuaderno -c "SELECT tipo, usuario_id IS NOT NULL AS con_cuenta, ip_red, creado_en FROM eventos_seguridad ORDER BY id DESC LIMIT 15;"
docker compose exec -T postgres psql -U cuaderno -d cuaderno -c "UPDATE eventos_seguridad SET tipo = 'inicio_sesion';"
```

**Qué debes ver:**

1. Los eventos de esta demo: `invitacion_creada`, `mfa_activado`, `invitacion_completada`, `mfa_desafio`, `mfa_correcto`, `mfa_fallido`, `codigo_respaldo_usado`, `recuperacion_solicitada`, `contrasena_restablecida`, etc. La IP va truncada (`/24` o `/48`). No hay columnas de texto libre: un token o una contraseña **no caben** en la tabla.
2. El `UPDATE` falla: la tabla es de **solo inserción** (solo se puede anular `usuario_id` e `ip_red` al anonimizar, y borrar filas de más de 180 días).

## 10. Pruebas y mutaciones

```bat
cd /d "...\editor-ia\editor-ia-backend"
scripts\test.bat
scripts\mutar.bat G01 G02 G06 G09 G18
```

**Qué debes ver:**

- Las pruebas: todo `passed`. `totp.test.ts` valida los vectores del RFC 6238 y del RFC 4226.
- Cada mutación `DETECTADA`, con la prueba que falló:
  - G01–G02: ningún token ni contraseña aparece en los logs (invitar, reenviar, consultar, completar, refrescar);
  - G06: anti-replay bajo carrera (si otra petición ya guardó ese paso, el código se rechaza con 401, nunca 500);
  - G09: el desafío es de un solo uso;
  - G18: la recuperación responde antes de trabajar.

## 11. Todo lo que corre el CI

```bat
scripts\bd-preparar.bat
scripts\ci.bat
```

**Qué debes ver:** `RESULTADO: OK`.
