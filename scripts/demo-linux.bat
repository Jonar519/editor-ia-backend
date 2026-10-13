@echo off
rem Demostraciones en Linux (contenedor de Playwright) contra la base de PRUEBAS.
rem Uso: scripts\demo-linux.bat sigterm   o   scripts\demo-linux.bat produccion
setlocal
pushd "%~dp0.."
node scripts\demo-linux.mjs %*
set "CODIGO=%ERRORLEVEL%"
popd
exit /b %CODIGO%
