@echo off
rem Mine World: start the Earth multiplayer server (port 8787 unless PORT is set).
chcp 65001 >nul
cd /d "%~dp0"
if "%PORT%"=="" set PORT=8787
if not exist node_modules (
  echo Installing dependencies...
  call npm install || goto :fail
)
echo Starting Mine World server on port %PORT%  (Ctrl+C to stop)
call npm run server
if errorlevel 1 goto :fail
goto :eof

:fail
echo.
echo Server stopped with an error.
pause
