@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0\.."

echo === Carnet2Maths - completion codes + durees YouTube ===
echo.

python tools\remplir_durees_youtube.py %*
if errorlevel 1 (
    echo.
    echo [ERREUR] Le script a echoue.
)

echo.
pause
