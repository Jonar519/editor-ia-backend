@echo off
rem Pruebas de carga del bloque R en Linux (contenedor de Playwright en la red Docker de Cuaderno), contra
rem la base de PRUEBAS cuaderno_carga_test y la db 2 de Redis. Junta sus datos con los de Windows en docs\.
rem Uso: scripts\carga-linux.bat [--rapido]
setlocal
pushd "%~dp0.."
node scripts\carga-linux.mjs %*
set "CODIGO=%ERRORLEVEL%"
popd
exit /b %CODIGO%
