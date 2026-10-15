# Demo · Bloque G: perfil, sesiones y datos

**Terminal:** `cmd.exe`, en la carpeta `editor-ia-backend`.

**Persona:** con rol **editor**, ya activa. Si no tienes una, crea una con la demo E (pasos 2 a 4) usando `luis.demo@example.com`.

**Ojo:** esta demo **escribe en tu base de desarrollo** porque la haces tú. Al final **elimina** la cuenta de la demo.

**Datos:** solo ficticios (`@example.com`).

## 1. Preparar

Las migraciones 0017–0019 deben estar aplicadas: el backend exige el esquema 19.

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

**Qué debes ver:** `Cuaderno API escuchando` y después `retención diaria agendada` con `"patron":"15 3 * * *"`. Usa **otra** ventana de cmd para lo que sigue.

## 2. Entrar y ver el perfil

```bat
curl -s -X POST http://127.0.0.1:4200/api/auth/sesion -H "content-type: application/json" -H "user-agent: Mozilla/5.0 (Windows NT 10.0) Firefox/140.0" -d "{\"correo\":\"luis.demo@example.com\",\"contrasena\":\"una frase larga para la demo\"}"
set ACCESO=pega-el-accessToken
curl -s http://127.0.0.1:4200/api/cuenta -H "authorization: Bearer %ACCESO%"
curl -s -X PATCH http://127.0.0.1:4200/api/cuenta -H "authorization: Bearer %ACCESO%" -H "content-type: application/json" -d "{\"telefono\":\"+525512345678\"}"
```

**Qué debes ver:** el perfil sin ningún hash ni secreto. Después, el mismo perfil con el teléfono.

## 3. Sesiones activas y cierre remoto

Abre una segunda sesión como si fuera otro dispositivo:

```bat
curl -s -X POST http://127.0.0.1:4200/api/auth/sesion -H "content-type: application/json" -H "user-agent: Mozilla/5.0 (Linux; Android 14) Chrome/140.0 Mobile" -d "{\"correo\":\"luis.demo@example.com\",\"contrasena\":\"una frase larga para la demo\"}"
set OTRO=pega-el-accessToken-del-telefono
curl -s http://127.0.0.1:4200/api/cuenta/sesiones -H "authorization: Bearer %ACCESO%"
```

**Qué debes ver:** dos sesiones con:

- `"ipRed":"127.0.0.0/24"` (truncada);
- `"ubicacion":"Red local"`;
- `"userAgent":"Firefox · Windows"` y `"Chrome · Android"`;
- `"actual":true` en una sola.

Cierra la del teléfono desde la de Windows:

```bat
curl -s -X POST http://127.0.0.1:4200/api/cuenta/sesiones/cerrar-otras -H "authorization: Bearer %ACCESO%"
curl -s http://127.0.0.1:4200/api/auth/yo -H "authorization: Bearer %OTRO%"
```

**Qué debes ver:** `{"cerradas":1}` y después `"codigo":"no_autenticado"`. El teléfono quedó fuera en la petición siguiente.

## 4. Cambio de correo con re-verificación

```bat
curl -s -X POST http://127.0.0.1:4200/api/cuenta/correo -H "authorization: Bearer %ACCESO%" -H "content-type: application/json" -d "{\"correoNuevo\":\"luis.nuevo@example.com\",\"contrasena\":\"una frase larga para la demo\"}"
scripts\buzon.bat luis.nuevo@example.com
scripts\buzon.bat luis.demo@example.com
```

**Qué debes ver:**

1. `202` con un mensaje fijo. Es el mismo aunque la dirección ya tenga cuenta: prueba con la de otra cuenta y verás el mismo texto y ningún correo.
2. En el buzón **nuevo**, el enlace `http://127.0.0.1:5175/#/correo/<token>`.
3. En el buzón **anterior**, el aviso `Se pidió cambiar el correo...` con la dirección **oculta** (`lu***@example.com`) y sin enlaces.

Confirma con los 43 caracteres del enlace:

```bat
set CTOKEN=pega-los-43-caracteres
curl -s -i -X POST http://127.0.0.1:4200/api/cuenta/correo/confirmar -H "content-type: application/json" -d "{\"token\":\"%CTOKEN%\"}"
curl -s -X POST http://127.0.0.1:4200/api/cuenta/correo/confirmar -H "content-type: application/json" -d "{\"token\":\"%CTOKEN%\"}"
scripts\buzon.bat luis.demo@example.com
```

**Qué debes ver:**

1. `204`.
2. `"codigo":"enlace_invalido"`: el enlace es de un solo uso.
3. En el buzón anterior, el aviso `El correo de tu cuenta de Cuaderno cambió`.

## 5. Cambio de contraseña: cierra las demás sesiones

Abre otra sesión con el correo **nuevo**, cambia la contraseña desde la primera y prueba la otra:

```bat
curl -s -X POST http://127.0.0.1:4200/api/auth/sesion -H "content-type: application/json" -d "{\"correo\":\"luis.nuevo@example.com\",\"contrasena\":\"una frase larga para la demo\"}"
set OTRO=pega-el-accessToken
curl -s -X POST http://127.0.0.1:4200/api/cuenta/contrasena -H "authorization: Bearer %ACCESO%" -H "content-type: application/json" -d "{\"actual\":\"una frase larga para la demo\",\"nueva\":\"otra frase larga para la demo G\"}"
curl -s http://127.0.0.1:4200/api/auth/yo -H "authorization: Bearer %OTRO%"
curl -s http://127.0.0.1:4200/api/auth/yo -H "authorization: Bearer %ACCESO%"
```

**Qué debes ver:**

1. `{"cerradas":1}`.
2. `no_autenticado`: la otra sesión se cerró.
3. Tu cuenta: la sesión actual sigue.

En el buzón llega `Tu contraseña de Cuaderno cambió`.

## 6. Avatar sin metadatos

Usa una foto tuya tomada con el teléfono (JPEG con EXIF y GPS), de 1 MiB como máximo. Revisa antes sus metadatos: en el Explorador, clic derecho → Propiedades → Detalles. Ahí ves la ubicación GPS.

```bat
curl -s -X PUT http://127.0.0.1:4200/api/cuenta/avatar -H "authorization: Bearer %ACCESO%" -H "content-type: image/jpeg" --data-binary "@C:\ruta\a\tu\foto.jpg"
curl -s http://127.0.0.1:4200/api/cuenta -H "authorization: Bearer %ACCESO%"
```

Descarga lo que quedó guardado y revisa sus metadatos con el Explorador:

```bat
curl -s -o "%TEMP%\avatar-limpio.jpg" http://127.0.0.1:4200/api/usuarios/pega-tu-id/avatar -H "authorization: Bearer %ACCESO%"
```

**Qué debes ver:** `"tipo":"image/jpeg"` con ancho y alto. En Propiedades → Detalles del archivo descargado **no** aparece ubicación GPS, cámara, fecha ni autor.

Ahora un archivo que no es una imagen:

```bat
curl -s -X PUT http://127.0.0.1:4200/api/cuenta/avatar -H "authorization: Bearer %ACCESO%" -H "content-type: image/jpeg" --data-binary "@package.json"
```

**Qué debes ver:** `422` con `"codigo":"imagen_no_valida"`. Tu avatar anterior sigue igual.

> **Límite conocido:** al quitar EXIF también se pierde la orientación. Una foto vertical del teléfono puede verse girada. El frontend la normalizará al recortarla (tramo 2).

## 7. Exportar los datos

```bat
curl -s -X POST http://127.0.0.1:4200/api/cuenta/exportacion -H "authorization: Bearer %ACCESO%" -H "content-type: application/json" -d "{\"contrasena\":\"otra frase larga para la demo G\"}" -o "%TEMP%\cuaderno-datos.json"
findstr /c:"scrypt" /c:"token_hash" /c:"secreto" "%TEMP%\cuaderno-datos.json"
type "%TEMP%\cuaderno-datos.json"
```

**Qué debes ver:** `findstr` no encuentra nada. El JSON trae:

- perfil, sesiones, espacios y eventos de seguridad (`correo_cambiado`, `contrasena_cambiada`, `avatar_actualizado`...);
- el avatar en base64.

## 8. Eliminar la cuenta

```bat
curl -s -i -X DELETE http://127.0.0.1:4200/api/cuenta -H "authorization: Bearer %ACCESO%" -H "content-type: application/json" -d "{\"contrasena\":\"otra frase larga para la demo G\"}"
curl -s http://127.0.0.1:4200/api/auth/yo -H "authorization: Bearer %ACCESO%"
curl -s -X POST http://127.0.0.1:4200/api/auth/sesion -H "content-type: application/json" -d "{\"correo\":\"luis.nuevo@example.com\",\"contrasena\":\"otra frase larga para la demo G\"}"
```

**Qué debes ver:**

1. `200` con `{"espaciosBorrados":0,"documentosBorrados":0}` y un `Set-Cookie` que borra `cuaderno_refresco`.
2. `no_autenticado`.
3. `credenciales_invalidas`.

En la base, la cuenta es una lápida (solo lectura):

```bat
cd /d "...\editor-ia\editor-ia-database"
docker compose exec -T postgres psql -U cuaderno -d cuaderno -c "SELECT estado, correo, nombre, eliminada_en IS NOT NULL AS eliminada FROM usuarios WHERE estado = 'eliminada';"
```

> El 409 por propiedad compartida necesita espacios y documentos, que el API todavía no crea (llegan en el bloque H). Lo demuestran las pruebas: `datos.test.ts` y `0018_eliminar_cuenta.test.sql`.

## 9. Pruebas y mutaciones

```bat
cd /d "...\editor-ia\editor-ia-backend"
scripts\test.bat
scripts\mutar.bat U01 U09 U13 U19 U26 U30 U32
```

**Qué debes ver:**

- Todo `passed`.
- Cada mutación `DETECTADA` con su evidencia: limpieza de EXIF, avatar limpio guardado, dirección en uso sin correo, cierre de las demás sesiones, exportación sin secretos, carrera en la eliminación y agenda diaria.

## 10. Todo lo que corre el CI

```bat
scripts\bd-preparar.bat
scripts\ci.bat
```

**Qué debes ver:** `RESULTADO: OK`.
