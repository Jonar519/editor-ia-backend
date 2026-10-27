@echo off
rem Pruebas de carga del bloque R (HTTP con autocannon y WebSocket). Escribe docs\carga-r.json y docs\carga-r.md.
rem Necesita el build del API (npm run build), PostgreSQL en 5435 y Redis en 6381 (usa la base de PRUEBAS
rem cuaderno_carga_test, que recrea, y la db 2 de Redis, que vacia). Nunca toca la base de desarrollo.
rem Cierra antes los demas programas: si la carga de CPU pasa del umbral (10 %), no mide.
rem Uso: scripts\carga.bat [--rapido] [--umbral 10] [--forzar] [--escenarios H1,H2,H3,H4,W1,W2]
setlocal
pushd "%~dp0.."
call npm run -s carga -- %*
set "CODIGO=%ERRORLEVEL%"
popd
exit /b %CODIGO%
