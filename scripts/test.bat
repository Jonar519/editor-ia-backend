@echo off
rem Pruebas (Vitest + Supertest) contra la base de PRUEBAS y Redis db 1.
setlocal
pushd "%~dp0.."
call npm run -s test -- %*
set "CODIGO=%ERRORLEVEL%"
popd
exit /b %CODIGO%
