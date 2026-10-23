@echo off
rem CLI de operador: encola el reindexado de TODOS los documentos (por ejemplo, al cambiar el modelo de
rem embeddings). Lo procesa el API, contra el presupuesto diario de cada espacio.
rem Uso: scripts\reindexar.bat
setlocal
pushd "%~dp0.."
call npm run -s reindexar
set "CODIGO=%ERRORLEVEL%"
popd
exit /b %CODIGO%
