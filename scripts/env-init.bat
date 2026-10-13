@echo off
rem Crea o completa .env (secretos aleatorios y URL de base con la clave de cuaderno_app).
setlocal
pushd "%~dp0.."
node scripts\env-init.mjs
set "CODIGO=%ERRORLEVEL%"
popd
exit /b %CODIGO%
