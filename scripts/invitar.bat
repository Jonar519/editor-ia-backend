@echo off
rem CLI de operador: invita una cuenta (por ejemplo, el primer admin). El enlace va SOLO al correo.
rem Uso: scripts\invitar.bat --correo ana@example.com --nombre "Ana Ficticia" --rol editor
setlocal
pushd "%~dp0.."
call npm run -s invitar -- %*
set "CODIGO=%ERRORLEVEL%"
popd
exit /b %CODIGO%
