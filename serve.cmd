@echo off
rem Serves this folder over http:// so YouTube links work.
rem YouTube refuses to embed into a file:// page, so opening video-notes.html
rem by double-clicking it gives "error 153". Run this instead.

cd /d "%~dp0"
set "PORT=8000"
set "PY="

where python >nul 2>nul && set "PY=python"
if not defined PY where py >nul 2>nul && set "PY=py"
if not defined PY goto nopython

echo.
echo   Video Notes  -  http://localhost:%PORT%/video-notes.html
echo   Serving: %cd%
echo.
echo   Leave this window open while you work.
echo   Press Ctrl+C (or close the window) to stop the server.
echo.

rem Open the browser a moment later, once the server is actually listening.
start "" /b powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:%PORT%/video-notes.html'"

%PY% -m http.server %PORT% --bind 127.0.0.1
goto done

:nopython
echo.
echo   Python was not found on your PATH, so this launcher cannot start a server.
echo.
echo   Either install Python from https://www.python.org/downloads/
echo   (tick "Add python.exe to PATH" during setup), or serve this folder with
echo   any other static server, for example:
echo.
echo       npx http-server -p %PORT%
echo.
echo   Then open http://localhost:%PORT%/video-notes.html
echo.
pause

:done
