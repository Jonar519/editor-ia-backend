@echo off
rem Servicio de IA (gRPC, 127.0.0.1:4210) con recarga, en su propia ventana de terminal. El API lo usa
rem si IA_SERVICE_TOKEN esta en .env (scripts\env-init.bat lo genera); sin el, el API arranca sin IA.
setlocal
pushd "%~dp0.."
call npm run -s ia:dev
set "CODIGO=%ERRORLEVEL%"
popd
exit /b %CODIGO%
