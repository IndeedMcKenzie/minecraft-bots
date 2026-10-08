# 🤖 Bots autónomos de Minecraft

[English](README.md) · **Español**

Siete bots hechos con **[Mineflayer](https://github.com/PrismarineJS/mineflayer)** (Node.js) que trabajan solos
en un servidor Paper y se controlan desde un **panel web en una sola ventana**:

| Bot | Usuario | Qué hace |
|---|---|---|
| 🪓 Leñador | `Bot_Lenador` | Explora, tala árboles, replanta y guarda la madera |
| ⛏️ Minero | `Bot_Minero` | Busca y extrae minerales por valor, guarda lo minado |
| 🌾 Granjero | `Bot_Granjero` | Cosecha, replanta, siembra y amplía su granja junto al agua |
| 🎣 Pescador | `Bot_Pescador` | Pesca sin parar en agua abierta cerca de su casa |
| 🗂️ Organizador | `Bot_Organizador` | Recoge lo que guardan los demás y lo ordena en un almacén central con carteles |
| 🐄 Ganadero | `Bot_Ganadero` | Construye un corral, cría vacas y sacrifica las sobrantes al pasar del máximo |
| 🛠️ Artesano | `Bot_Artesano` | Funde minerales, cocina comida y fabrica herramientas de repuesto para los demás bots |

**Destacado:** cada bot tiene casa y cofres propios y vuelve a guardar cuando se le llena el inventario ·
amplía sus cofres solo · se rescata solo si se atasca en una cueva · un organizador lleva todo a un almacén
ordenado por categorías · panel con estado en vivo, botones y estadísticas.

---

## 🚀 Instalación e inicio rápido

**Requisitos:** [Node.js](https://nodejs.org/) 22 o superior y un servidor Paper en el que los bots puedan
entrar. Los bots usan cuentas *offline* (`online-mode=false`). Están probados en Paper 26.2 con
ViaVersion/ViaBackwards (los bots hablan el protocolo 1.21.4).

1. **Descarga e instala dependencias:**
   ```
   git clone https://github.com/IndeedMcKenzie/minecraft-bots.git
   cd minecraft-bots
   npm install
   ```
2. **Configura** `config.js` → `server` (host, puerto, versión).
3. **Da OP a los bots** en la consola del servidor. Lo necesitan para `/tp`, `/give`, `/summon` y el ajuste de físicas:
   ```
   op Bot_Lenador
   op Bot_Minero
   op Bot_Granjero
   op Bot_Pescador
   op Bot_Organizador
   op Bot_Ganadero
   op Bot_Artesano
   ```
4. **Arranca el panel:** en Windows, doble clic en **`abrir_panel.bat`**. En cualquier sistema:
   `npm start` y abre `http://127.0.0.1:3000`.
5. **Casas:** cada bot adopta como casa el cofre más cercano al aparecer. Para elegirla tú, hazle TP junto
   a un cofre y escribe `!casa <bot>` en el chat (o pulsa **🏠 Fijar casa** en el panel).
   El **Organizador**, el **Ganadero** y el **Artesano** no adoptan ninguna: su casa (el almacén, el centro del corral o el taller) la eliges tú.

> ⚠️ **Seguridad:** con el servidor en modo *offline*, cualquiera que entre con el nombre de un bot tendrá
> sus permisos de OP. Úsalo en servidores privados o protege esos nombres (ver «Cosas a saber»).

---

## 🖥️ Panel de control

`abrir_panel.bat` (o `npm start`) ejecuta los 7 bots en **un solo proceso** (`panel.js`, menos RAM) y abre
la interfaz en `http://127.0.0.1:3000`.

- **Desde otro equipo de tu red:** pon en `config.js` → `panel.host: '0.0.0.0'` y añade su IP a
  `panel.allowedIps`; luego abre `http://<IP de este PC>:3000`. El panel **no tiene contraseña**: cualquier
  IP que no esté en la lista recibe "Acceso denegado". En Windows hay que permitir el puerto 3000 en el
  firewall para esa IP. Con `panel.host: '127.0.0.1'` solo se puede abrir desde el propio PC.

- Si el panel ya está corriendo, el `.bat` solo vuelve a abrir la ventana.
- **Cerrar la ventana NO detiene los bots.** Siguen en un proceso minimizado.
- **⏻ Apagar** (con confirmación) detiene todos los bots y el panel.
- Si cambias código o `config.js`, hay que **apagar y volver a abrir** el panel. Si solo cambia `panel/index.html`, basta con **F5**.

### Cada tarjeta de bot muestra
- Estado (Activo / Conectando / Reconectando / Detenido), actividad actual y avisos en rojo.
- ❤️ Vida, 🍗 hambre, 📍 posición, 🎒 huecos libres y 🏠 casa (con `N/15 cofres`).
- **Inventario completo:** las fichas con 🔒 son la **reserva** que se queda a propósito al guardar
  (herramienta, semillas…). `cobblestone ×39 (🔒32)` significa que se queda 32 y guardará 7.
- `📦 N por guardar · último guardado hace X`.
- **Alertas** (ver abajo); el borde de la tarjeta se pone amarillo o rojo si tiene alguna.

### Botones de cada bot
| Botón | Qué hace |
|---|---|
| ▶ Iniciar / ■ Detener / ↻ Reiniciar | Conecta o desconecta ese bot (detenido no se reconecta solo) |
| 🏠 Fijar casa | El cofre más cercano al bot (≤ 8 bloques) pasa a ser su casa |
| 🏡 Volver a casa | Deja lo que hace, va a casa (caminando o con `/tp`), guarda y sigue trabajando |
| 🎁 Dar herramienta | Se da con `/give` lo configurado en `config.js` → `give` (diamante, caña, semillas…) |
| 🆘 Rescatar | Rescate manual si está atascado (pulsado 2 veces en 10 min → `/tp` directo) |
| 🗂️ Organizar ahora | Solo en el Organizador: hace una ronda de recogida y ordenación |

El **registro** de abajo se filtra por bot con las pestañas.

### 🚨 Alertas
El panel vigila cada bot y avisa en su tarjeta (y en la cabecera: `⚠️ N alertas`; al pulsarlo te lleva al bot):

| Alerta | Cuándo |
|---|---|
| 🚨 Sin conexión | Lleva más de 2 min sin conectar estando encendido |
| ⚠️ Produce poco | 0 árboles / minerales en 20 min, 0 capturas en 10, 0 cosechas en 30, 0 fundidos en 45, ninguna ronda del Organizador en el doble de su intervalo |
| ⚠️ Atascos | 3 o más en 30 min |
| ⚠️ Ha muerto | En los últimos 15 min |
| ⚠️ Cofres de casa llenos | No le cabe nada más en casa |
| Avisos del bot | Sin pico / hacha / caña, sin combustible para los hornos, no pudo dar una herramienta de repuesto, almacén sin sitio para una categoría… |

Se quitan solas cuando se resuelven. Cada alerta que aparece o se resuelve queda también en el registro del bot.

### 📦 Pestaña Almacén
Lo que hay en el almacén del Organizador (o abre `http://127.0.0.1:3000/#almacen`):
- **Buscador** (también en español: "diamante", "hierro", "madera"…) y filtro por categoría.
- Se actualiza cada vez que un bot abre un cofre del almacén, y con una **revisión completa** cada 2 h
  o al pulsar **🔄 Revisar almacén** (útil si sacas o metes cosas a mano).
- **Pedir:** eliges cantidad y jugador, y el **Organizador** lo saca del almacén, se teletransporta a tu lado
  y te lo suelta. Tienes que estar conectado al servidor. Si está en mitad de una ronda, la interrumpe y la
  retoma después.

Se guarda en `data/almacen_inventario.json`.

### 📊 Pestaña Estadísticas
Arriba del panel cambias entre **🤖 Bots** y **📊 Estadísticas** (o abre `http://127.0.0.1:3000/#stats`).
Puedes ver **«Esta sesión»** o **«Desde siempre»**:
- **Cifras clave:** árboles talados, minerales (y diamantes), cultivos cosechados, capturas de pesca,
  terneros nacidos, objetos guardados y objetos ordenados por el organizador.
- **Gráfico por horas** de objetos guardados en casa (últimas 24 h); al pasar el ratón desglosa por bot.
- **Tabla por bot:** tiempo conectado, objetos guardados, viajes a casa, teletransportes, atascos,
  cofres creados, muertes y expulsiones.
- **Desgloses:** minerales por tipo, pesca por tipo y almacén por categoría.

Se guardan en `data/stats.json` (cada minuto y al apagar). Borra ese archivo para empezar de cero.

### 🗺️ Pestaña Mapa
Muestra la web de **BlueMap** dentro del panel (o abre `http://127.0.0.1:3000/#mapa`), y cada tarjeta de bot
tiene un botón **🗺️ Ver en el mapa** que la abre centrada en el bot. Solo se carga mientras la pestaña está
abierta. Se configura en `config.js` → `panel.bluemapUrl` (`null` = sin pestaña).

### 🖥️ Pestaña Consola
Necesita el plugin **BotHelper** (ver abajo). Ejecuta comandos del servidor como la consola (con todos los
permisos) y muestra la respuesta; ↑/↓ repiten los anteriores. Cada comando queda en el registro del panel.

## 🔌 Plugin del servidor: BotHelper

Plugin de Paper (carpeta `server-plugin/`) que ayuda a los bots desde dentro del servidor:

| | |
|---|---|
| ⚡ Rendimiento | Los bots **no hacen aparecer criaturas** a su alrededor y **no cuentan para dormir** |
| 🎣 Pesca | Lo que pesca un bot **aparece a sus pies** en vez de volar hacia él (desde algunas orillas chocaba con el borde, caía al agua y se perdía) |
| 🛡️ Protección | Sin daño de **monstruos** (golpes, flechas, creepers, brujas, veneno) ni de **caídas**; los monstruos no los persiguen. Las herramientas **sí se gastan** |
| 🔌 Panel | **Estado del servidor** en la cabecera (TPS, ms por tick, RAM, entidades, jugadores) y alerta si va lento; **almacén en vivo** (lee los cofres directamente, también lo que muevas a mano); **consola** |

Solo escucha en el propio PC (`127.0.0.1:8200`) y pide una clave que genera al arrancar
(`plugins/BotHelper/token.txt`, de donde la lee el panel). **Sin el plugin, el panel funciona igual que antes.**

**Instalar** (requiere el JDK, que ya trae el Java del servidor; no hace falta Gradle ni Maven):
```
powershell -ExecutionPolicy Bypass -File server-plugin\build.ps1 -Install
```
Compila con las librerías del propio servidor (`C:\Server` por defecto; otra carpeta con `-ServerDir`), copia
`BotHelper.jar` a `plugins/` y hay que **reiniciar el servidor**. Ajustes en `plugins/BotHelper/config.yml`
(nombres de los bots, qué protecciones usar…) y `/bothelper` / `/bothelper reload` en el juego. En `config.js` →
`serverPlugin` va la dirección del plugin y la ruta de `token.txt`.

Los murciélagos y demás criaturas que ya existían no desaparecen solos: `kill @e[type=minecraft:bat]` en la consola.

---

## 🧠 Cómo trabajan los bots

### 🏠 Casa y almacenamiento (todos)
- La **casa** es un cofre (o barril) más los cofres que haya **a 6 bloques** de él.
- Prioridad para elegirla: `bots.<bot>.home` en config → `chest.position` → `data/home_<bot>.json` → cofre más cercano al aparecer.
- Solo usan **sus** cofres, nunca cofres ajenos que encuentren por el camino.
- **Vuelta a casa:** leñador y minero vuelven con el inventario casi lleno (≤ 2 huecos). Granjero y pescador
  vuelven cuando juntan 16 objetos. Viajan por tramos de 48 bloques aunque estén a cientos de bloques.
  **Si en 3 minutos no llegan caminando, usan `/tp`.** Tras guardar, vuelven al sitio donde estaban trabajando.
- **Cofres automáticos:** si todos los cofres de casa están llenos, el bot se da uno con `/give` y lo coloca
  al lado, hasta **15 por casa**.
- **Reserva que se quedan al guardar:**

| Bot | Reserva |
|---|---|
| Leñador | 1 hacha y 8 brotes de cada tipo |
| Minero | 1 pico y 32 adoquines + 32 de pizarra profunda (para pilares de rescate) |
| Granjero | 1 azada, 32 semillas de trigo, 16 zanahorias / patatas / semillas de remolacha |
| Pescador | 1 caña |
| Ganadero | 1 espada, 64 de trigo, vallas y tierra para reparar el corral |

### 🪓 Leñador
- Busca la base de un árbol (radio 96), lo tala de abajo arriba y replanta el brote.
  Si el servidor tiene un plugin tipo *Timber* (el árbol cae entero), el registro dirá «Talados 1 troncos».
- Sin hacha, tala con las manos. Si pasa cerca de casa sin hacha, busca una en los cofres.
- Sin árboles cerca, **explora** manteniendo un rumbo.

### ⛏️ Minero
- Elige el **mineral más valioso** a la vista (radio 64): diamante > esmeralda > oro > hierro > carbón > cobre > lapislázuli > redstone.
- Ignora los que su pico no puede extraer (p. ej. diamante con pico de piedra).
- Sin pico, **va a casa a buscar uno**. Si no hay, espera (usa 🎁 Dar herramienta).
- Con el inventario lleno, primero tira relleno (grava, arena, tierra…) pero conserva su reserva de bloques para pilares.

### 🌾 Granjero
- Trabaja **anclado a su casa**: todo lo busca en un radio de 48 alrededor de ella. Si se aleja, vuelve.
- Cosecha trigo, zanahorias, patatas y remolachas maduras y replanta al momento.
- Siembra la tierra arada vacía y, con azada, **ara tierra nueva junto al agua**.
- Sin semillas, rompe hierba para conseguirlas.
- Si no hay nada que hacer, revisa cada 20 s en vez de cada 4 (ahorra CPU).

### 🎣 Pescador
- Busca **agua abierta** (≥ 9 bloques de agua en 5×5) a 32 bloques de su casa y una orilla firme.
  Ignora canales de 1 bloque para no pisar cultivos.
- Lanza y espera la picada. Si no pica en 45 s, recoge y vuelve a lanzar. Tras 3 fallos seguidos cambia de sitio.
- Guarda cada 16 capturas. Si se rompe la caña, saca otra del cofre (deja repuestos ahí).

### 🗂️ Organizador (almacén central)
- Cada **20 minutos** (o con 🗂️ Organizar ahora) hace una ronda:
  1. Se da 4 cofres y 4 carteles con `/give` (material para ampliar el almacén).
  2. Se teletransporta a la casa de cada bot y **saca todo menos sus herramientas de repuesto**
     (picos, hachas, azadas, palas, espadas, cañas y tijeras). Espera si ese bot está guardando en ese momento.
  3. Vuelve al almacén y reparte cada objeto **en el cofre de su categoría**. Comprueba cada depósito y lo reintenta si el servidor lo rechaza.
  4. Si una categoría no tiene cofre o está llena, **coloca uno nuevo con un cartel encima** con su nombre.
- Los cofres van **en cuadrícula con pasillos** y nunca pegados (así no se unen en cofres dobles mezclando categorías).
- **Almacén ilimitado** (`maxChests: 0`): cuando no queda hueco, la cuadrícula **crece en anillos** hasta
  `maxWarehouseRadius` (112 bloques). Nunca pone cofres junto a las casas de otros bots ni en el corral.
  Si una categoría no cabe, deja esos objetos en las casas y sigue con el resto.
- Si el servidor rechaza un depósito (pasa con objetos que ViaVersion marca, como huevos), lo reintenta en huecos vacíos.
- **Categorías:** Madera, Minerales, Piedra, Cultivos, Pesca, Comida, Mobs y Varios (todo lo demás).
  Se editan en `config.js` → `organizer.categories` (admite comodines: `*_log` = todos los troncos).
- **Puedes ordenar a mano:** un cofre con un cartel (encima o en un lado) que diga el nombre de una categoría
  se usará para esa categoría. No importan mayúsculas ni tildes. Los cofres **sin cartel no se tocan**.
- **Buzón (opcional, apagado):** con `organizer.inbox: true`, el cofre de su casa se vacía y ordena en cada
  ronda (útil para dejarle cosas). ¡Si ese cofre tiene cosas tuyas, las moverá!

### 🐄 Ganadero (vacas)
- Su casa es un cofre en el **centro del corral**: pon el cofre en un sitio **llano de al menos 13×13**,
  hazle TP al lado y usa `!casa ganadero`.
- **Construye el corral** solo: un cuadrado de vallas a 6 bloques del cofre, con una **puerta en el lado sur**
  para que entres tú. En terreno irregular **nivela con tierra** para que las vacas no salten las vallas.
  Repara huecos cada 5 minutos y, si le cambias la casa, retira el corral anterior.
- Si hay menos de 2 vacas adultas, **invoca las que falten con `/summon`** (solo con el corral cerrado).
- **Cría**: alimenta con trigo a parejas de adultas (cada vaca, una vez cada 5 min) sin pasarse del máximo.
  Las crías tardan unos 20 min en crecer.
- **Sacrifica solo si hay más de 10** vacas (adultas + crías): mata adultas sobrantes con espada, dejando
  siempre al menos 2, y guarda carne y cuero en su cofre (el organizador lo lleva al almacén).
- Vallas, tierra, trigo y espada los consigue con `/give` si le faltan. Se ajusta en `config.js` → `rancher`.
- ⚠️ Plugins que apilan mobs (p. ej. **StackMob**) hacen que cuente mal las vacas y críe o sacrifique de más.

### 🛠️ Artesano (taller: hornos + herramientas)
- Su casa es un cofre en el **taller, cerca del almacén** (fuera de su cuadrícula), con unos 7 bloques llanos
  libres al norte para los hornos y algo de sitio a los lados para la mesa de trabajo: `!casa artesano`.
- **Herramientas (primero):** cada 10 min revisa que cada bot tenga **1 herramienta de repuesto** en su casa:
  hacha (leñador), pico (minero), azada (granjero), caña (pescador) y espada (ganadero). Si falta alguna,
  saca materiales del almacén (**diamante**; si no hay, hierro o piedra; palos o madera para hacerlos; cuerda
  para las cañas), la **fabrica en una mesa de trabajo** y **la deja en el cofre de ese bot** con `/tp`.
- **Hornos:** coloca **4 hornos** junto a su cofre. Cuando hay hornos libres, saca del almacén **hierro, oro y
  cobre en bruto**, **carne y pescado crudos** y **patatas**, con **carbón** como combustible (o madera si no
  hay), y mete lotes de 64. Los hornos trabajan solos mientras él fabrica herramientas.
- Guarda lo producido (lingotes, comida cocinada) y los materiales sobrantes en su cofre; **el organizador lo
  lleva al almacén**.
- Se ajusta en `config.js` → `smelter` (hornos) y `smith` (herramientas).

### 🆘 Rescate de atascos (leñador y minero)
- Si pasan **90 s fuera de casa sin alejarse más de 3 bloques**, se consideran atascados:
  1. Suben a la superficie: escaleras o torre con el pathfinder y, si no, **pilar manual** (pican encima y se
     ponen bloques bajo los pies). Abortan si hay lava o agua encima. Luego vuelven a casa caminando.
  2. Si no lo consiguen, o si se atascan otra vez en menos de 10 min: **`/tp` a casa**.
- La zona del atasco (10 bloques) y el objetivo que perseguían quedan **prohibidos 30 minutos**, para no repetir.
- Al terminar guardan el inventario y siguen trabajando.

---

## 💬 Comandos de chat

| Comando | Efecto |
|---|---|
| `!casa <bot>` | Ese bot adopta como casa el cofre más cercano a él (≤ 8 bloques) |
| `!casa todos` | Lo mismo para todos los bots (cada uno busca cerca de sí mismo) |

`<bot>` puede ser el rol (`minero`, `leñador`/`lenador`, `granjero`, `pescador`, `organizador`, `ganadero`, `artesano`),
la clave (`miner`, `woodcutter`, `rancher`…) o el usuario (`Bot_Minero`).

---

## ⚙️ Configuración (`config.js`)

| Sección | Opciones principales |
|---|---|
| `server` | `host`, `port`, `version` (protocolo que usa Mineflayer; ViaBackwards traduce), `viewDistance` (`short` por defecto) |
| `performance` | `pathfinderTickMs` (20): CPU máxima por tick para calcular rutas. Minero y leñador usan 40 (`bots.<bot>.pathfinderTickMs`): con menos calculan rutas a trozos y se quedan «dudando» ante desniveles |
| `panel` | `port` (3000), `autoStart` (iniciar bots al abrir el panel) |
| `reconnect` | `enabled`, `delayMs` |
| `search` | Radios: `woodRadius` 96, `mineRadius` 64, `farmRadius` 48, `chestRadius` 48 |
| `chest` | `enabled`, `position` (casa común para todos) |
| `home` | `returnWhenFreeSlots` 2, `returnToWorkSpot`, `maxTravelMinutes` 3, `chestRadius` 6, `autoChests`, `maxChests` 15 |
| `farm` | `autoCreate` (arar junto al agua), `searchWaterRadius` |
| `stuck` | `detectSeconds` 90, `allowTeleport`, `repeatMinutes` 10 |
| `organizer` | `intervalMinutes` 20, `warehouseRadius` 12, `maxWarehouseRadius` 112, `maxChests` 0 (ilimitado), `inbox`, `protect`, `categories` |
| `fishing` | `searchRadius` 32 |
| `rancher` | `penRadius` 6, `maxCows` 10, `minBreeders` 2, `breedCooldownMinutes` 5, `cycleSeconds` 15 |
| `smelter` (Artesano, hornos) | `furnaces` 4, `cycleSeconds` 30, `batchPerFurnace` 64, `smelt` (qué funde/cocina), `fuels` |
| `smith` (Artesano, herramientas) | `checkMinutes` 10, `sparesPerBot` 1, `tools` (herramienta de cada bot), `tiers` (diamante > hierro > piedra) |
| `starterCommands` | Comandos al conectarse (ajuste de escala para las físicas de salto en 1.21+, requiere OP) |
| `bots.<bot>` | `username`, `home` (`{x,y,z}` fija), `stuckWatch`, `give` (lo que entrega 🎁), `viewDistance`, `autoHome`, `pathfinderTickMs` |

---

## 📌 Cosas a saber

- **Sin hambre:** cada vez que un bot aparece (también al reaparecer tras morir) se da **Saturación** infinita
  (`config.js` → `starterCommands`), así que nunca necesita comer. Con `keepInventory` activado, morir no le quita nada.
- **OP y modo offline:** los bots necesitan OP para `/tp`, `/give`, `/summon` y las físicas. En modo offline,
  cualquiera que use el nombre de un bot hereda su OP. En servidores con más gente, usa un plugin de login
  (contraseña) o cambia los nombres de los bots en `config.js`.
- **No ejecutes un bot suelto** (`node bots/<bot>.js`) con el panel abierto: entrarían dos con el mismo nombre
  y se expulsarían entre sí en bucle.
- **Recursos:** con los 7 bots, el proceso usa unos **500–550 MB de RAM** y en torno a **medio núcleo de CPU**
  cuando todos están activos. Lo que más gasta es el cálculo de rutas (`performance.pathfinderTickMs`).
  Cada animal del corral también es trabajo para el servidor: no subas mucho `rancher.maxCows`.
- **Si un bot muere**, pierde lo que llevaba y reaparece en el spawn o en su cama; luego vuelve a trabajar.
- **Cambiar la casa de un bot:** `!casa <bot>` / 🏠 Fijar casa, o borrar `data/home_<bot>.json`.
- **Cofre de casa roto:** el bot olvida esa casa y adopta otra (excepto organizador y ganadero).
- **Avisos en rojo** en el registro: la mayoría se explican solos («¿Es OP?», «cofres llenos», «no llego al
  cofre…»). Si un bot hace algo raro, el registro filtrado por ese bot suele decir por qué.

---

## 📁 Estructura del proyecto

```
abrir_panel.bat        Abre el panel en Windows (recomendado)
panel.js               Gestor de los 7 bots + servidor del panel (127.0.0.1:3000)
panel/index.html       Interfaz del panel
panel/alerts.js        Alertas de los bots
panel/serverlink.js    Conexión con el plugin BotHelper
config.js              Toda la configuración
bots/common.js         Lógica compartida: casa, viajes, cofres, rescate, órdenes del panel, /give, /tp
bots/stats.js          Contadores de estadísticas
bots/inventory.js      Inventario del almacén (lo que hay en cada cofre)
bots/woodcutter.js     Leñador
bots/miner.js          Minero
bots/farmer.js         Granjero
bots/fisher.js         Pescador
bots/organizer.js      Organizador
bots/rancher.js        Ganadero
bots/artisan.js        Artesano (hornos + herramientas)
bots/warehouse.js      Acceso al almacén (lo usan el Artesano y los pedidos)
server-plugin/         Plugin BotHelper para Paper (código y build.ps1)
data/                  Datos de tu mundo (se crea solo, no se sube a git):
  home_<bot>.json        casa de cada bot
  almacen.json           categoría de cada cofre del organizador (respaldo de los carteles)
  corral.json            corrales construidos por el ganadero
  stats.json             estadísticas acumuladas
  almacen_inventario.json  contenido de cada cofre del almacén
```

Ejecutar un bot suelto (sin panel): `node bots/miner.js` (igual con los demás).

---

## 📄 Licencia

Publicado bajo la licencia [MIT](LICENSE): puedes usar, copiar, modificar y distribuir este código
libremente, siempre que mantengas el aviso de copyright y la licencia.
