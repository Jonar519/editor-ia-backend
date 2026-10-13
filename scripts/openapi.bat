@echo off
rem Regenera docs\openapi.json desde los esquemas zod.
setlocal
pushd "%~dp0.."
call npm run -s openapi
set "CODIGO=%ERRORLEVEL%"
popd
exit /b %CODIGO%
