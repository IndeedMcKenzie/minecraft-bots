# ============================================================
#  build.ps1 — Compila el plugin BotHelper sin Gradle ni Maven
#  Usa el JDK instalado y las librerías del propio servidor Paper.
#  Uso:  powershell -ExecutionPolicy Bypass -File server-plugin\build.ps1 [-ServerDir C:\Server] [-Install]
#  -Install copia el .jar a la carpeta plugins del servidor (hay que reiniciarlo).
# ============================================================
param(
    [string]$ServerDir = "C:\Server",
    [switch]$Install
)
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$out = Join-Path $root "build"
$classes = Join-Path $out "classes"

$libs = Get-ChildItem (Join-Path $ServerDir "libraries") -Recurse -Filter *.jar | ForEach-Object { $_.FullName }
if (-not $libs) { throw "No encontré las librerías del servidor en $ServerDir\libraries (arranca el servidor una vez)" }

Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $classes | Out-Null

# Lista de archivos y classpath en un archivo de argumentos (la línea de comandos de Windows es corta)
$sources = Get-ChildItem (Join-Path $root "src\main\java") -Recurse -Filter *.java | ForEach-Object { '"' + ($_.FullName -replace '\\', '/') + '"' }
$argFile = Join-Path $out "javac.args"
@(
    "-encoding", "UTF-8",
    "--release", "25",
    "-d", ('"' + ($classes -replace '\\', '/') + '"'),
    "-cp", ('"' + (($libs | ForEach-Object { $_ -replace '\\', '/' }) -join ';') + '"')
) + $sources | Set-Content -Encoding ascii $argFile

& javac "@$argFile"
if ($LASTEXITCODE -ne 0) { throw "Falló la compilación" }

Copy-Item (Join-Path $root "src\main\resources\*") $classes -Recurse
$jar = Join-Path $out "BotHelper.jar"
& jar --create --file $jar -C $classes .
if ($LASTEXITCODE -ne 0) { throw "Falló al crear el .jar" }
Write-Host "Compilado: $jar"

if ($Install) {
    Copy-Item $jar (Join-Path $ServerDir "plugins\BotHelper.jar") -Force
    Write-Host "Copiado a $ServerDir\plugins. Reinicia el servidor para cargarlo."
}
