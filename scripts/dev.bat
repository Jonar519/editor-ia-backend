@echo off
rem Servidor de desarrollo con recarga (127.0.0.1:4200). Requiere editor-ia-database\scripts\db-up.bat.
setlocal
pushd "%~dp0.."
call npm run -s dev
set "CODIGO=%ERRORLEVEL%"
popd
exit /b %CODIGO%
