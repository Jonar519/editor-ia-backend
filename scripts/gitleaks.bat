@echo off
rem Busca secretos en TODO el historial de git con gitleaks (imagen Docker fijada; no requiere instalarlo).
setlocal
pushd "%~dp0.."
docker run --rm -v "%CD%:/repo" -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=* zricethezav/gitleaks:v8.21.2 git /repo --no-banner --redact -v
set "CODIGO=%ERRORLEVEL%"
popd
exit /b %CODIGO%
