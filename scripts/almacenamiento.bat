@echo off
rem Almacenamiento de versiones (riesgo R-02, bloque R). Escribe docs\almacenamiento-r.json y docs\almacenamiento-r.md.
rem Necesita el build del API (npm run build), PostgreSQL en 5435 y Redis en 6381 (usa la base de PRUEBAS
rem cuaderno_carga_test, que recrea, y la db 2 de Redis, que vacia). Nunca toca la base de desarrollo.
rem Uso: scripts\almacenamiento.bat [--rapido] [--umbral 10]
setlocal
pushd "%~dp0.."
call npm run -s almacenamiento -- %*
set "CODIGO=%ERRORLEVEL%"
popd
exit /b %CODIGO%
