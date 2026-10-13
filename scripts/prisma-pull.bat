@echo off
rem Regenera prisma\schema.prisma desde la base de PRUEBAS y el cliente de Prisma.
setlocal
pushd "%~dp0.."
call npm run -s prisma:pull
if errorlevel 1 goto :fin
call npm run -s prisma:generate
:fin
set "CODIGO=%ERRORLEVEL%"
popd
exit /b %CODIGO%
