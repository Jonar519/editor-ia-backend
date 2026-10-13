@echo off
rem Pruebas de mutacion del catalogo mutations\catalogo.json. Uso: scripts\mutar.bat [id ...]
setlocal
pushd "%~dp0.."
call npm run -s mutate -- %*
set "CODIGO=%ERRORLEVEL%"
popd
exit /b %CODIGO%
