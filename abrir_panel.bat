@echo off
:: ============================================================
::  abrir_panel.bat — Abre el panel de control de los bots
::  Si el panel no está corriendo lo inicia (minimizado) y abre
::  la ventana. Cerrar la ventana NO detiene los bots: usa el
::  botón "Apagar" del panel para eso.
:: ============================================================
cd /d "%~dp0"
set "PANEL_URL=http://127.0.0.1:3000"
set "NODE=C:\Program Files\nodejs\node.exe"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

if not exist "%NODE%" (
    echo  [ERROR] Node.js no encontrado en C:\Program Files\nodejs\
    pause
    exit /b 1
)

:: ¿Ya está corriendo el panel?
curl -s -o nul "%PANEL_URL%/api/state"
if errorlevel 1 (
    start "Panel Bots Minecraft" /min "%NODE%" panel.js
    rem Esperar a que el panel responda (max. 20 s)
    for /l %%i in (1,1,20) do (
        timeout /t 1 /nobreak >nul
        curl -s -o nul "%PANEL_URL%/api/state" && goto :abrir
    )
)

:abrir
if exist "%EDGE%" (
    start "" "%EDGE%" --app=%PANEL_URL% --window-size=1180,860
) else (
    start "" %PANEL_URL%
)
