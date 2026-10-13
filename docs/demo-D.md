# Demo · Bloque D: esqueleto del backend

**Rol:** ninguno. Todavía no hay cuentas ni interfaz.
**Terminal:** `cmd.exe`.
**Base:** las pruebas y las demos en Linux usan la base de **pruebas** (`cuaderno_test`). Solo el paso 3 lee tu base de desarrollo, y sin escribir nada en ella.

## 1. Servicios y rol de aplicación (repo de base)

```bat
cd /d "...\editor-ia\editor-ia-database"
git pull
scripts\db-up.bat
scripts\db-migrate.bat dev
```

**Qué debes ver:**

- `.env completado con: CUADERNO_APP_PASSWORD (los valores existentes no se tocaron).` (solo la primera vez)
- `Rol cuaderno_app: LOGIN habilitado y contraseña sincronizada con .env.`
- Las migraciones `0001` a `0013` aplicadas en tu base de desarrollo. **Esta es la primera vez que tu base `cuaderno` recibe el esquema**, y lo haces tú.

Comprueba que el rol del backend no puede saltarse los triggers. En psql, sobre la base de pruebas:

```bat
docker exec -it cuaderno_postgres psql -U cuaderno -d cuaderno_test -c "SET ROLE cuaderno_app; ALTER TABLE versiones DISABLE TRIGGER versiones_solo_insercion;"
```

**Qué debes ver:** `ERROR: must be owner of table versiones`.

## 2. Preparar el backend

```bat
cd /d "...\editor-ia\editor-ia-backend"
npm ci
npm run prisma:generate
scripts\env-init.bat
```

**Qué debes ver:**

- `.env creado con secretos aleatorios.`
- En `.env`, `MFA_ENCRYPTION_KEY` con 44 caracteres (32 bytes en base64) y las URL `postgresql://cuaderno_app:...`.

## 3. Arrancar y revisar salud, disponibilidad y métricas

```bat
scripts\dev.bat
```

**Qué debes ver:**

- Un log JSON con `"msg":"Cuaderno API escuchando"` y `"puerto":4200`.
- Ningún aviso de privilegios, porque te conectas como `cuaderno_app`.

En **otra** ventana de cmd:

```bat
curl -s http://127.0.0.1:4200/health
curl -s http://127.0.0.1:4200/ready
curl -s http://127.0.0.1:4200/metrics | findstr cuaderno_http
curl -s http://127.0.0.1:4200/no-existe
```

**Qué debes ver:**

1. `{"estado":"ok"}`
2. `{"estado":"listo","comprobaciones":{"bd":"ok","esquema":"ok","redis":"ok"}}`
3. Líneas `cuaderno_http_duracion_segundos_...` con `ruta="/health"`
4. `{"error":{"codigo":"no_encontrado","mensaje":"Ruta no encontrada","solicitud":"..."}}`

## 4. Disponibilidad cuando cae Redis

Con el servidor todavía corriendo:

```bat
docker stop cuaderno_redis
curl -s -i http://127.0.0.1:4200/ready
docker start cuaderno_redis
```

**Qué debes ver:** `HTTP/1.1 503` y `"redis":"falla"`. A los pocos segundos de `docker start`, `/ready` vuelve a `200`.

Detén el servidor con `Ctrl+C`. En Windows, Node no recibe un SIGTERM "de verdad"; para eso está el paso 6.

## 5. Pruebas, OpenAPI y mutaciones

```bat
scripts\test.bat
npm run openapi:check
scripts\mutar.bat S01 S02 S03 S24
```

**Qué debes ver:**

- Las pruebas: `Test Files 6 passed` y `Tests 44 passed`.
- `docs/openapi.json está al día.`
- Las mutaciones: cada una `DETECTADA`, con la prueba que falló como evidencia.

## 6. En Linux: SIGTERM real y negativas de producción

```bat
npm run build
scripts\demo-linux.bat sigterm
scripts\demo-linux.bat produccion
```

**Qué debes ver** con `sigterm`:

- `/health` y `/ready` responden.
- `El proceso terminó con código 0`.
- En el log: `apagado ordenado: dejo de aceptar conexiones` y `apagado: recursos cerrados`.

**Qué debes ver** con `produccion`:

1. `Configuración inválida` con los tres proveedores `mock`, `METRICS_TOKEN` y `REDIS_URL`, y código de salida 1.
2. Conectado como dueño: la lista de problemas (superusuario, dueño de tablas, ...) y `usa cuaderno_app`, con código de salida 1.

## 7. Todo lo que corre el CI

```bat
scripts\bd-preparar.bat
scripts\ci.bat
```

**Qué debes ver:** `exit 0` en lint, typecheck, prisma:check, openapi:check, test, build, mutaciones, npm audit y gitleaks, y al final `RESULTADO: OK`.
