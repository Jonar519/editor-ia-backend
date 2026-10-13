@echo off
rem Deja lista la base de PRUEBAS: la crea si falta, la migra con editor-ia-database y habilita cuaderno_app.
rem Nunca toca la base de desarrollo.
setlocal
pushd "%~dp0.."
node scripts\bd-preparar.mjs
set "CODIGO=%ERRORLEVEL%"
popd
exit /b %CODIGO%
