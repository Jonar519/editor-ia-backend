@echo off
rem Buzon simulado (solo desarrollo, proveedor mock): correos recibidos por una direccion.
rem Uso: scripts\buzon.bat ana@example.com
setlocal
pushd "%~dp0.."
call npm run -s buzon -- %*
set "CODIGO=%ERRORLEVEL%"
popd
exit /b %CODIGO%
