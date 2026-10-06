@echo off
title Detener Bots - Minecraft
color 0C
echo.
echo  ========================================
echo    DETENIENDO BOTS DE MINECRAFT
echo  ========================================
echo.

:: Cerrar las ventanas de los bots por su titulo
echo  Cerrando ventanas de los bots...

taskkill /FI "WINDOWTITLE eq Bot_Lenador"  /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Bot_Minero"   /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Bot_Granjero" /T /F >nul 2>&1

:: Tambien matar cualquier proceso node.exe que ejecute nuestros bots
echo  Terminando procesos node.exe de los bots...

for /f "tokens=2" %%i in ('wmic process where "name='node.exe' and CommandLine like '%%woodcutter%%'" get ProcessId /format:list 2^>nul ^| find "="') do (
    taskkill /PID %%i /F >nul 2>&1
    echo  - Proceso woodcutter.js detenido [PID: %%i]
)

for /f "tokens=2" %%i in ('wmic process where "name='node.exe' and CommandLine like '%%miner%%'" get ProcessId /format:list 2^>nul ^| find "="') do (
    taskkill /PID %%i /F >nul 2>&1
    echo  - Proceso miner.js detenido [PID: %%i]
)

for /f "tokens=2" %%i in ('wmic process where "name='node.exe' and CommandLine like '%%farmer%%'" get ProcessId /format:list 2^>nul ^| find "="') do (
    taskkill /PID %%i /F >nul 2>&1
    echo  - Proceso farmer.js detenido [PID: %%i]
)

echo.
echo  ========================================
echo    Todos los bots han sido detenidos.
echo  ========================================
echo.
pause
