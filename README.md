# 🤖 Bots autónomos de Minecraft (Paper 26.2)

Seis bots hechos con **Mineflayer** (Node.js) que trabajan solos en tu servidor Paper y se controlan desde
un **panel en una sola ventana**:

| Bot | Usuario | Qué hace |
|---|---|---|
| 🪓 Leñador | `Bot_Lenador` | Explora, tala árboles, replanta y guarda la madera |
| ⛏️ Minero | `Bot_Minero` | Busca y extrae minerales por valor, guarda lo minado |
| 🌾 Granjero | `Bot_Granjero` | Cosecha, replanta, siembra y amplía su granja junto al agua |
| 🎣 Pescador | `Bot_Pescador` | Pesca sin parar en agua abierta cerca de su casa |
| 🗂️ Organizador | `Bot_Organizador` | Recoge lo que guardan los demás y lo ordena en un almacén central con carteles |
| 🐄 Ganadero | `Bot_Ganadero` | Construye un corral, cría vacas y sacrifica las sobrantes al pasar del máximo |

---

## 🚀 Inicio rápido

1. **Requisitos:** Node.js instalado en `C:\Program Files\nodejs\` y el servidor encendido en `localhost:25565`.
2. **Dar OP a los bots** (en la consola del servidor). Lo necesitan para `/tp`, `/give` y el ajuste de físicas:
   ```
   op Bot_Lenador
   op Bot_Minero
   op Bot_Granjero
   op Bot_Pescador
   op Bot_Organizador
   op Bot_Ganadero
   ```
3. Doble clic en **`abrir_panel.bat`**. Los bots se conectan solos y se abre el panel.
4. **Casas:** cada bot adopta como casa el cofre más cercano al aparecer. Para elegirla tú, hazle TP junto
   a un cofre y escribe `!casa <bot>` en el chat (o pulsa **🏠 Fijar casa** en el panel).
   El **Organizador** y el **Ganadero** no adoptan ninguna: su casa (el almacén / el centro del corral) la eliges tú.

> ⚠️ **Seguridad:** el servidor está en modo *offline*. Cualquiera que entre con el nombre de un bot tendrá
> sus permisos de OP. Si el servidor no es solo para ti en tu red local, ten cuidado (ver «Cosas a saber»).

---

## 🖥️ Panel de control

`abrir_panel.bat` ejecuta los 5 bots en **un solo proceso** (`panel.js`, menos RAM) y abre una ventana de
Edge en modo app con la interfaz en `http://127.0.0.1:3000`. Solo se puede abrir desde tu propio PC.

- Si el panel ya está corriendo, el `.bat` solo vuelve a abrir la ventana.
- **Cerrar la ventana NO detiene los bots.** Siguen en un proceso minimizado («Panel Bots Minecraft» o `node`).
- **⏻ Apagar** (con confirmación) detiene todos los bots y el panel.
- Si cambias código o `config.js`, hay que **apagar y volver a abrir** el panel. Si solo cambia `panel/index.html`, basta con **F5**.

### Cada tarjeta de bot muestra
- Estado (Activo / Conectando / Reconectando / Detenido), actividad actual y avisos en rojo.
- ❤️ Vida, 🍗 hambre, 📍 posición, 🎒 huecos libres y 🏠 casa (con `N/15 cofres`).
- **Inventario completo:** las fichas con 🔒 son la **reserva** que se queda a propósito al guardar
  (herramienta, comida, semillas…). `cobblestone ×39 (🔒32)` significa que se queda 32 y guardará 7.
- `📦 N por guardar · último guardado hace X`.
- Aviso **📦 Cofres de casa llenos** cuando no le cabe nada más.

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
| Leñador | 1 hacha, 8 brotes de cada tipo, hasta 16 de cada comida |
| Minero | 1 pico, 32 adoquines + 32 de pizarra profunda (para pilares de rescate), hasta 16 de cada comida |
| Granjero | 1 azada, 32 semillas de trigo, 16 zanahorias / patatas / semillas de remolacha |
| Pescador | 1 caña |

### 🪓 Leñador
- Busca la base de un árbol (radio 96), lo tala y replanta el brote. En tu servidor, al romper la base cae
  el árbol entero (parece un plugin tipo *Timber*), por eso el registro suele decir «Talados 1 troncos».
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
- Los cofres van **en cuadrícula con pasillos** y nunca pegados (así no se unen en cofres dobles mezclando categorías). Máximo 40.
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
  para que entres tú. Las vallas las consigue con `/give`. Repara huecos cada 5 minutos.
- Si hay menos de 2 vacas adultas, **invoca las que falten con `/summon`** (solo con el corral cerrado).
- **Cría**: alimenta con trigo a parejas de adultas (cada vaca, una vez cada 5 min) sin pasarse del máximo.
  Las crías tardan unos 20 min en crecer.
- **Sacrifica solo si hay más de 10** vacas (adultas + crías): mata adultas sobrantes con espada, dejando
  siempre al menos 2, y guarda carne y cuero en su cofre (el organizador lo lleva al almacén).
- Trigo y espada los consigue con `/give` si le faltan. Se ajusta en `config.js` → `rancher`.

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

`<bot>` puede ser el rol (`minero`, `leñador`/`lenador`, `granjero`, `pescador`, `organizador`), la clave
(`miner`, `woodcutter`…) o el usuario (`Bot_Minero`).

---

## ⚙️ Configuración (`config.js`)

| Sección | Opciones principales |
|---|---|
| `server` | `host`, `port`, `version` (protocolo que usa Mineflayer; ViaBackwards traduce), `viewDistance` (`short` por defecto) |
| `performance` | `pathfinderTickMs` (20): CPU máxima por tick para calcular rutas; menos = menos CPU |
| `panel` | `port` (3000), `autoStart` (iniciar bots al abrir el panel) |
| `reconnect` | `enabled`, `delayMs` |
| `search` | Radios: `woodRadius` 96, `mineRadius` 64, `farmRadius` 48, `chestRadius` 48 |
| `chest` | `enabled`, `position` (casa común para todos) |
| `home` | `returnWhenFreeSlots` 2, `returnToWorkSpot`, `maxTravelMinutes` 3, `chestRadius` 6, `autoChests`, `maxChests` 15 |
| `farm` | `autoCreate` (arar junto al agua), `searchWaterRadius` |
| `stuck` | `detectSeconds` 90, `allowTeleport`, `repeatMinutes` 10 |
| `organizer` | `intervalMinutes` 20, `warehouseRadius` 12, `maxChests` 40, `inbox`, `protect`, `categories` |
| `fishing` | `searchRadius` 32 |
| `rancher` | `penRadius` 6, `maxCows` 10, `minBreeders` 2, `breedCooldownMinutes` 5, `cycleSeconds` 15 |
| `starterCommands` | Comandos al conectarse (ajuste de escala para las físicas de salto en 1.21+, requiere OP) |
| `bots.<bot>` | `username`, `home` (`{x,y,z}` fija), `stuckWatch`, `give` (lo que entrega 🎁), `viewDistance`, `autoHome` |

---

## 📌 Cosas a saber

- **OP y modo offline:** los bots necesitan OP para `/tp`, `/give` y las físicas. En modo offline, cualquiera
  que use el nombre de un bot hereda su OP. Si abres el servidor a otras personas, considera un plugin de
  login (contraseña) o mover `/give` y `/tp` a RCON.
- **No mezcles** el panel con `iniciar_bots.bat` / `index.js`: los bots se expulsarían entre sí por login
  duplicado. Además, esos lanzadores clásicos solo arrancan 3 bots (sin pescador ni organizador).
- **Recursos:** con 5–6 bots, el proceso usa unos **450–550 MB de RAM** y en torno a **medio núcleo de CPU**
  cuando todos están activos. Cada animal del corral también es trabajo para el servidor: no subas mucho `rancher.maxCows`. Lo que más gasta es el cálculo de rutas; se ajusta con `performance.pathfinderTickMs`.
- **Si un bot muere**, pierde lo que llevaba y reaparece en el spawn o en su cama; luego vuelve a trabajar.
- **Cambiar la casa de un bot:** `!casa <bot>` / 🏠 Fijar casa, o borrar `data/home_<bot>.json`.
- **Cofre de casa roto:** el bot olvida esa casa y adopta otra (excepto el organizador).
- **Avisos en rojo** en el registro: la mayoría se explican solos («¿Es OP?», «cofres llenos», «no llego al
  cofre…»). Si un bot hace algo raro, el registro filtrado por ese bot suele decir por qué.

---

## 📁 Estructura del proyecto

```
abrir_panel.bat        Abre el panel (recomendado)
panel.js               Gestor de los 5 bots + servidor del panel (127.0.0.1:3000)
panel/index.html       Interfaz del panel
config.js              Toda la configuración
bots/common.js         Lógica compartida: casa, viajes, cofres, rescate, órdenes del panel, /give, /tp
bots/woodcutter.js     Leñador
bots/miner.js          Minero
bots/farmer.js         Granjero
bots/fisher.js         Pescador
bots/organizer.js      Organizador
bots/rancher.js        Ganadero
data/home_<bot>.json   Casa guardada de cada bot
data/almacen.json      Categoría de cada cofre que creó el organizador (respaldo de los carteles)
data/stats.json        Estadísticas acumuladas (pestaña 📊 del panel)
bots/stats.js          Contadores de estadísticas
iniciar_bots.bat, detener_bots.bat, index.js   Lanzadores clásicos (3 bots, una ventana cada uno)
```

Ejecutar un bot suelto (sin panel): `node bots/miner.js` (igual con los demás).

---

## 📄 Licencia

Publicado bajo la licencia [MIT](LICENSE): puedes usar, copiar, modificar y distribuir este código
libremente, siempre que mantengas el aviso de copyright y la licencia.
