@echo off
rem Medicion P3: gRPC frente a REST/JSON (ADR 0002). Escribe docs\medicion-p3.json y docs\medicion-p3.md.
rem Cierra antes los demas programas: si la carga de CPU pasa del umbral (10 %), no mide.
rem Uso: scripts\medir.bat [--rapido] [--umbral 10] [--forzar]
setlocal
pushd "%~dp0.."
call npm run -s medir -- %*
set "CODIGO=%ERRORLEVEL%"
popd
exit /b %CODIGO%
