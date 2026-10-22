@echo off
rem Corre localmente los mismos pasos que el CI y muestra el codigo de salida REAL de cada uno.
rem Requiere: editor-ia-database\scripts\db-up.bat y scripts\bd-preparar.bat.
setlocal EnableDelayedExpansion
pushd "%~dp0.."
set "N=0"
set "FALLOS=0"

call :paso "proto:generate"  "npm run -s proto:generate"
call :paso "lint"            "npm run -s lint"
call :paso "typecheck"       "npm run -s typecheck"
call :paso "prisma:check"    "npm run -s prisma:check"
call :paso "openapi:check"   "npm run -s openapi:check"
call :paso "proto:check"     "npm run -s proto:check"
call :paso "test"            "npm run -s test"
call :paso "build"           "npm run -s build"
call :paso "mutaciones"      "npm run -s mutate"
call :paso "npm audit"       "npm audit --audit-level=high"
call :paso "gitleaks"        "scripts\gitleaks.bat"

echo.
echo ===== Resumen CI local =====
for /l %%i in (1,1,!N!) do echo   !R%%i!
popd
if "!FALLOS!"=="0" (
  echo RESULTADO: OK
  exit /b 0
)
echo RESULTADO: FALLO
exit /b 1

:paso
set "NOMBRE=%~1"
echo.
echo ===== !NOMBRE! =====
call %~2
set "CODIGO=!ERRORLEVEL!"
set /a N+=1
set "R!N!=!NOMBRE!: exit !CODIGO!"
if not "!CODIGO!"=="0" set "FALLOS=1"
exit /b 0
