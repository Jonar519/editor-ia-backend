@echo off
rem Codigo TOTP vigente de un secreto base32 (como una app autenticadora; solo para la demo).
rem Uso: scripts\totp.bat JBSWY3DPEHPK3PXP
setlocal
pushd "%~dp0.."
call npm run -s totp -- %*
set "CODIGO=%ERRORLEVEL%"
popd
exit /b %CODIGO%
