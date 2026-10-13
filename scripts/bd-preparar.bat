@echo off
rem Deja la base de PRUEBAS migrada con el esquema del repo editor-ia-database (sin tocar la de desarrollo).
setlocal
pushd "%~dp0..\..\editor-ia-database"
call npm run -s migrate -- test
set "CODIGO=%ERRORLEVEL%"
popd
exit /b %CODIGO%
