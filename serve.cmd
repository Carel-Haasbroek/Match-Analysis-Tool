@echo off
rem Launches the Video Notes desktop app.
rem
rem The app runs under Electron, which serves itself over http://127.0.0.1 internally.
rem That is what lets YouTube embed (it refuses a file:// page) and what lets local
rem videos stream with seeking.

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode
where npm >nul 2>nul
if errorlevel 1 goto nonode

rem First run after a fresh copy: no dependencies yet. Installing here beats the
rem "electron not found" error you would otherwise get.
if not exist "node_modules\electron" (
  echo.
  echo   First run - installing dependencies. This takes a minute or two.
  echo.
  call npm install
  if errorlevel 1 goto installfailed
  echo.
)

echo.
echo   Starting Video Notes...
echo   Close the app window to quit. This window can be closed once it opens.
echo.

call npm start
if errorlevel 1 goto runfailed
goto done

:nonode
echo.
echo   Node.js was not found on your PATH, so the desktop app cannot start.
echo.
echo   Install it from https://nodejs.org/ (the LTS build is fine), then run this again.
echo.
echo   Or install the packaged app instead - it needs no Node at all:
echo   https://github.com/Carel-Haasbroek/Match-Analysis-Tool/releases/latest
echo.
pause
goto done

:installfailed
echo.
echo   npm install failed. Check the messages above - usually a network or proxy issue.
echo.
pause
goto done

:runfailed
echo.
echo   The app exited with an error. The messages above should say why.
echo.
pause

:done
