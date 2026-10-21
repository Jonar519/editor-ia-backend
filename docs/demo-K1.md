# Demo · Bloque K1: espacios, documentos y permisos

**Terminal:** `cmd.exe`.

**Ojo:** esta demo **escribe en tu base de desarrollo** porque la haces tú. Aplica la migración 0021 y crea un espacio, documentos y permisos. Al final borras el espacio.

**Datos:** solo ficticios (`@example.com`).

**Personas:** tres cuentas activas, creadas con la demo E (pasos 2 a 4):

| Persona | Correo | Rol de cuenta |
|---|---|---|
| Ana | `ana.k1@example.com` | editor |
| Bruno | `bruno.k1@example.com` | editor |
| Carla | `carla.k1@example.com` | lector |

## 1. Preparar

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

En **otra** ventana, entra con las tres y guarda sus tokens:

```bat
curl -s -X POST http://127.0.0.1:4200/api/auth/sesion -H "content-type: application/json" -d "{\"correo\":\"ana.k1@example.com\",\"contrasena\":\"<su contraseña>\"}"
set ANA=pega-el-accessToken-de-ana
```

Repite para Bruno (`set BRUNO=...`) y Carla (`set CARLA=...`). El token vive 15 minutos; si ves `no_autenticado`, vuelve a entrar.

## 2. Un espacio y sus miembros

```bat
curl -s -X POST http://127.0.0.1:4200/api/espacios -H "authorization: Bearer %ANA%" -H "content-type: application/json" -d "{\"nombre\":\"Equipo de demo\"}"
set ESP=pega-el-id-del-espacio
curl -s -X POST http://127.0.0.1:4200/api/espacios/%ESP%/miembros -H "authorization: Bearer %ANA%" -H "content-type: application/json" -d "{\"correo\":\"BRUNO.K1@example.com\",\"rol\":\"editor\"}"
curl -s -X POST http://127.0.0.1:4200/api/espacios/%ESP%/miembros -H "authorization: Bearer %ANA%" -H "content-type: application/json" -d "{\"correo\":\"carla.k1@example.com\",\"rol\":\"editor\"}"
curl -s -X POST http://127.0.0.1:4200/api/espacios/%ESP%/miembros -H "authorization: Bearer %ANA%" -H "content-type: application/json" -d "{\"correo\":\"carla.k1@example.com\",\"rol\":\"lector\"}"
curl -s -X POST http://127.0.0.1:4200/api/espacios/%ESP%/miembros -H "authorization: Bearer %ANA%" -H "content-type: application/json" -d "{\"correo\":\"nadie.k1@example.com\",\"rol\":\"lector\"}"
```

**Qué debes ver:**

1. El espacio con `"rol":"propietario"`.
2. Bruno agregado como editor (el correo en mayúsculas da igual).
3. Carla como editora: **409 `rol_excede_cuenta`** (es una cuenta de solo lectura).
4. Carla como lectora: agregada.
5. Un correo sin cuenta: **404 `cuenta_no_encontrada`**. Es la misma respuesta para una cuenta pendiente o eliminada.

## 3. Documentos y roles efectivos

```bat
curl -s -X POST http://127.0.0.1:4200/api/espacios/%ESP%/documentos -H "authorization: Bearer %BRUNO%" -H "content-type: application/json" -d "{\"titulo\":\"Guía de despliegue\"}"
set DOC=pega-el-id-del-documento
curl -s -X POST http://127.0.0.1:4200/api/espacios/%ESP%/documentos -H "authorization: Bearer %CARLA%" -H "content-type: application/json" -d "{\"titulo\":\"No\"}"
curl -s http://127.0.0.1:4200/api/espacios/%ESP%/documentos -H "authorization: Bearer %ANA%"
curl -s http://127.0.0.1:4200/api/documentos/%DOC% -H "authorization: Bearer %CARLA%"
```

**Qué debes ver:**

1. El documento de Bruno, con `"rol":"propietario"`.
2. Carla (lectora) **no** crea: **403**.
3. Para Ana, el documento con `"rol":"editor"`: ser propietaria del **espacio** no da la propiedad del documento.
4. Para Carla, `"rol":"lector"`.

## 4. Permiso propio y transferencia

```bat
curl -s -X PUT http://127.0.0.1:4200/api/documentos/%DOC%/permisos/<id de Carla> -H "authorization: Bearer %BRUNO%" -H "content-type: application/json" -d "{\"rol\":\"editor\"}"
```

**Qué debes ver:** **409 `rol_excede_cuenta`**: Carla es una cuenta de solo lectura y nunca pasa de lectora, aunque se le dé permiso en el documento.

Ahora Ana intenta sacar a Bruno, que posee un documento:

```bat
curl -s -X DELETE http://127.0.0.1:4200/api/espacios/%ESP%/miembros/<id de Bruno> -H "authorization: Bearer %ANA%"
```

**Qué debes ver:** **409 `propiedad_documentos`** con la lista: `[{"tipo":"documento","id":"...","nombre":"Guía de despliegue"}]`.

Bruno transfiere el documento a Ana y entonces sí se lo puede sacar:

```bat
curl -s -X POST http://127.0.0.1:4200/api/documentos/%DOC%/propiedad -H "authorization: Bearer %BRUNO%" -H "content-type: application/json" -d "{\"usuarioId\":\"<id de Ana>\"}"
curl -s -X DELETE http://127.0.0.1:4200/api/espacios/%ESP%/miembros/<id de Bruno> -H "authorization: Bearer %ANA%"
curl -s http://127.0.0.1:4200/api/documentos/%DOC% -H "authorization: Bearer %BRUNO%"
```

**Qué debes ver:** la transferencia muestra a Ana como `propietario` y a Bruno como `editor`. Después, `204`. Por último, para Bruno, **404 `documento_no_encontrado`**: ya no es miembro, y la respuesta es la misma que si el documento no existiera.

## 5. La base: compactación (0021)

En psql contra **tu** base (`cuaderno`):

```sql
SET ROLE cuaderno_app;
DELETE FROM actualizaciones_documento WHERE false;
RESET ROLE;
SELECT has_function_privilege('cuaderno_app', 'compactar_documento(uuid,bigint,bytea)', 'EXECUTE');
```

**Qué debes ver:** el `DELETE` falla con **permiso denegado** aunque no borre nada: la app ya no borra el log por su cuenta. La función sí la puede ejecutar (`t`).

## 6. Limpiar

Ana saca a Carla y borra el espacio:

```bat
curl -s -X DELETE http://127.0.0.1:4200/api/espacios/%ESP% -H "authorization: Bearer %ANA%"
curl -s -X DELETE http://127.0.0.1:4200/api/espacios/%ESP%/miembros/<id de Carla> -H "authorization: Bearer %ANA%"
curl -s -X DELETE http://127.0.0.1:4200/api/espacios/%ESP% -H "authorization: Bearer %ANA%"
```

**Qué debes ver:** primero **409 `espacio_compartido`** (Carla sigue). Después de sacarla, `{"documentosBorrados":1}`.

## 7. Pruebas

```bat
cd /d "...\editor-ia\editor-ia-database"
scripts\mutar.bat K01 K06 K11 K12
cd /d "...\editor-ia\editor-ia-backend"
scripts\test.bat
scripts\mutar.bat W06 W11 W15 W17
scripts\ci.bat
```

**Qué debes ver:** cada mutación `DETECTADA`.

| Mutación | Qué rompe |
|---|---|
| K01 | La app vuelve a poder borrar el log |
| K06 | `hasta_id` deja de exigir una fila vigente |
| K11 | Se quita el bloqueo previo: una compactación vieja pisa a una nueva |
| K12 | El bloqueo deja de ser `NO KEY`: bloquearía las inserciones |
| W06 | Quien no es miembro recibe 403 en vez de 404 |
| W11 | Se deja quitar a quien posee documentos |
| W15 | Se quita el bloqueo del espacio: altas simultáneas dan 500 |
| W17 | Una cuenta de solo lectura recibe "editor" |

`ci.bat` termina con `RESULTADO: OK`.
