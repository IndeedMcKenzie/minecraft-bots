@echo off
title Sistema de Bots - Minecraft
color 0A
echo.
echo  ========================================
echo    INICIANDO BOTS DE MINECRAFT
echo  ========================================
echo.

:: Verificar que Node.js existe
if not exist "C:\Program Files\nodejs\node.exe" (
    echo  [ERROR] Node.js no encontrado en C:\Program Files\nodejs\
    echo  Instala Node.js desde https://nodejs.org/
    pause
    exit /b 1
)

echo  [1/3] Iniciando Bot_Lenador  (talador de arboles)...
start "Bot_Lenador"  cmd /k ""C:\Program Files\nodejs\node.exe" bots/woodcutter.js"

timeout /t 2 /nobreak >nul

echo  [2/3] Iniciando Bot_Minero   (mineria)...
start "Bot_Minero"   cmd /k ""C:\Program Files\nodejs\node.exe" bots/miner.js"

timeout /t 2 /nobreak >nul

echo  [3/3] Iniciando Bot_Granjero (granja)...
start "Bot_Granjero" cmd /k ""C:\Program Files\nodejs\node.exe" bots/farmer.js"

echo.
echo  ========================================
echo    Los 3 bots estan corriendo!
echo    Cada bot tiene su propia ventana.
echo    Cierra este script o usa detener_bots.bat
echo  ========================================
echo.
pause
