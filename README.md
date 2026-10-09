# 🤖 Autonomous Minecraft Bots

**English** · [Español](README.es.md)

Seven bots built with **[Mineflayer](https://github.com/PrismarineJS/mineflayer)** (Node.js) that work on their own
on a Paper server and are controlled from a **single-window web panel**:

| Bot | Username | What it does |
|---|---|---|
| 🪓 Woodcutter | `Bot_Lenador` | Explores, chops trees, replants saplings and stores the wood |
| ⛏️ Miner | `Bot_Minero` | Finds ores by value, mines them and stores the loot |
| 🌾 Farmer | `Bot_Granjero` | Harvests, replants, sows and expands its farm next to water |
| 🎣 Fisher | `Bot_Pescador` | Fishes non-stop in open water near its home |
| 🗂️ Organizer | `Bot_Organizador` | Collects what the others store and sorts it into a central warehouse with labeled chests |
| 🛠️ Artisan | `Bot_Artesano` | Smelts ores, cooks food and crafts spare tools for the other bots |
| 🏹 Hunter | `Bot_Cazador` | Hunts monsters with sword and bow: follows and protects you, or explores on its own |

**Highlights:** every bot has its own home and chests and returns to store items when its inventory fills
up · adds chests automatically · rescues itself when stuck in a cave · an organizer moves everything into
a warehouse sorted by category · a hunter whose bow accounts for arrow drop · live web panel with status, action
buttons and statistics.

> 🇪🇸 The bots were written for a Spanish-speaking server: **the panel, logs and in-game chat commands are in
> Spanish** (e.g. `!casa`). The code is commented in Spanish too. Everything is explained below.

---

## 🚀 Install & quick start

**Requirements:** [Node.js](https://nodejs.org/) 22+ and a Paper server the bots can join. The bots use
*offline* accounts (`online-mode=false`). Tested on Paper 26.2 with ViaVersion/ViaBackwards (the bots speak
the 1.21.4 protocol).

1. **Download and install dependencies:**
   ```
   git clone https://github.com/IndeedMcKenzie/minecraft-bots.git
   cd minecraft-bots
   npm install
   ```
2. **Configure** `config.js` → `server` (host, port, version).
3. **Give the bots OP** from the server console. They need it for `/tp`, `/give`, `/summon` and a physics fix:
   ```
   op Bot_Lenador
   op Bot_Minero
   op Bot_Granjero
   op Bot_Pescador
   op Bot_Organizador
   op Bot_Artesano
   op Bot_Cazador
   ```
4. **Start the panel:** on Windows, double-click **`abrir_panel.bat`**. On any OS: `npm start` and open
   `http://127.0.0.1:3000`.
5. **Homes:** each bot adopts the nearest chest as its home when it spawns. To choose it yourself, teleport the
   bot next to a chest and type `!casa <bot>` in chat (or press **🏠 Fijar casa** in the panel).
   The **Organizer**, the **Artisan** and the **Hunter** never pick one on their own: you choose their home (the
   warehouse / the workshop / the chest where it drops its loot).

> ⚠️ **Security:** in *offline* mode, anyone who joins with a bot's name gets its OP permissions. Use this on
> private servers or protect those names (see "Good to know").

---

## 🖥️ Control panel

`abrir_panel.bat` (or `npm start`) runs all 7 bots in **a single process** (`panel.js`, less RAM) and serves the
UI at `http://127.0.0.1:3000`.

- **From another computer on your network:** set `panel.host: '0.0.0.0'` in `config.js` and add its IP to
  `panel.allowedIps`, then open `http://<this PC's IP>:3000`. The panel **has no password**: any IP not on the
  list gets "access denied". On Windows, allow port 3000 for that IP in the firewall. With
  `panel.host: '127.0.0.1'` it only opens on this PC.

- If the panel is already running, the `.bat` just reopens the window.
- **Closing the window does NOT stop the bots.** They keep running in a minimized process.
- **⏻ Apagar** (Shut down, with confirmation) stops every bot and the panel.
- After changing code or `config.js`, **shut down and reopen** the panel. Changes to `panel/index.html` only need **F5**.

### Each bot card shows
- Status (online / connecting / reconnecting / stopped), current activity and red warnings.
- ❤️ health, 📍 position, 🎒 free slots and 🏠 home (with `N/15` chests).
- **Full inventory:** chips with 🔒 are the **reserve** the bot keeps on purpose when storing (tool,
  seeds…). `cobblestone ×39 (🔒32)` means it keeps 32 and will store 7.
- `📦 N to store · last stored X ago`.
- **Alerts** (see below); the card border turns yellow or red when it has any.
- 🏹 The **Hunter** also has a selector for what it does (**Automático**, **Seguir** / follow or **Explorar** /
  explore) and shows what it's doing right now.

### Per-bot buttons
| Button | What it does |
|---|---|
| ▶ Iniciar / ■ Detener / ↻ Reiniciar | Start / stop / restart that bot (a stopped bot does not reconnect) |
| 🏠 Fijar casa | The chest nearest to the bot (≤ 8 blocks) becomes its home |
| 🏡 Volver a casa | Drop the current task, go home (walking or `/tp`), store everything and keep working |
| 🎁 Dar herramienta | `/give` the bot what is configured in `config.js` → `give` (diamond tools, rod, seeds…) |
| 🆘 Rescatar | Manual rescue when stuck (press twice within 10 min → straight `/tp`) |
| 🗂️ Organizar ahora | Organizer only: run a collect-and-sort round now |

The **log** at the bottom can be filtered per bot.

### 🚨 Alerts
The panel watches every bot and warns on its card (and in the header: `⚠️ N alertas`; clicking it takes you to the bot):

| Alert | When |
|---|---|
| 🚨 Offline | Not connected for over 2 min while enabled |
| ⚠️ Low output | 0 trees / ores in 20 min, 0 catches in 10, 0 harvests in 30, 0 smelted in 45, no organizer round within twice its interval |
| ⚠️ Stuck | 3 or more times in 30 min |
| ⚠️ Died | Within the last 15 min |
| ⚠️ Home chests full | Nothing else fits at home |
| Bot reports | No pickaxe / axe / rod, no fuel for the furnaces, couldn't deliver a spare tool, no room in the warehouse for a category… |

They clear themselves once solved. Every alert that appears or clears is also written to that bot's log.

### 📦 Warehouse tab
What's stored in the organizer's warehouse (or open `http://127.0.0.1:3000/#almacen`):
- **Search** (Spanish words work too: "diamante", "hierro", "madera"…) and a category filter.
- Updated whenever a bot opens a warehouse chest, plus a **full check** every 2 h or when you press
  **🔄 Revisar almacén** (handy if you take or add things by hand).
- **Pedir (order):** pick an amount and a player; the **organizer** takes it from the warehouse, teleports
  next to you and drops it. You must be online. If it's mid-round, the round is paused and resumed later.

Saved to `data/almacen_inventario.json`.

### 📊 Statistics tab
Switch between **🤖 Bots** and **📊 Estadísticas** at the top (or open `http://127.0.0.1:3000/#stats`),
for **this session** or **all time**:
- **Key figures:** trees chopped, ores mined (and diamonds), crops harvested, fish caught, items smelted, tools
  crafted, items stored, items sorted by the organizer and monsters hunted (with arrows shot and hit rate).
- **Hourly chart** of items stored at home (last 24 h); hover for a per-bot breakdown.
- **Per-bot output per hour:** one chart per bot with its main job (trees, ores, crops, catches, items sorted,
  items smelted, monsters hunted) over the last 24 h; it warns if the last hour was far below the bot's average.
- **Per-bot table:** time online, items stored, trips home, teleports, times stuck, chests placed,
  deaths and kicks.
- **Breakdowns:** ores by type, catches by type, warehouse by category and hunted monsters by type.

Saved to `data/stats.json` (every minute and on shutdown). Delete that file to start over.

### 🗺️ Map tab
Shows the **BlueMap** website inside the panel (or open `http://127.0.0.1:3000/#mapa`), and each bot card has a
**🗺️ Ver en el mapa** button that opens it centred on the bot. It only loads while the tab is open. Set it in
`config.js` → `panel.bluemapUrl` (`null` = no tab). The panel serves BlueMap from its own address
(`/bluemap/`), so other computers don't need BlueMap's port.

- **🎯 Work zone:** pick the woodcutter, miner, farmer or hunter and a radius, move the map until the **centre
  cross** is over the spot and press **«Fijar en la cruz»**. The woodcutter and miner then only work inside that
  circle (if they're outside, they go there by /tp onto the ground or on foot), the farmer uses it as its farm and the
  hunter, when exploring, hunts inside it. They still
  store at home. «Quitar zona» brings them back to normal. Saved in `data/zones.json`.
- **Trails, homes and zones on the map** (with the BotHelper 1.4 plugin): each bot's path over the **last hour**
  (a line in its colour), its home and its zone. They can be hidden in BlueMap's layer menu.

### ⚙️ Settings tab
Change without restarting anything the woodcutter's, miner's and farmer's search radii, **which ores the miner
looks for and in what order**, whether the farmer expands its farm and uses the composter, from what distance they go
home by /tp, the organizer's interval, how many free slots
the bots keep before going home, **what the hunter does** (auto, follow or explore), who it follows, how far it guards and
explores and whether it uses the bow, the server rescue and the Discord alerts. Changes are saved in
`data/settings.json` and applied on top of `config.js`; «Restablecer» goes back to its value.

### 🖥️ Console tab
Needs the **BotHelper** plugin (below). Runs server commands as the console (full permissions) and shows the
reply; ↑/↓ recall previous ones. Every command is written to the panel log.

Below it is **🔬 Diagnóstico**: when enabled, the plugin records what the server sees the bots doing (block
clicks, opened windows, inventory clicks, crafting, item pickups, fishing, teleports, damage), filterable per bot.
It's for bugs like "the bot says it stored items but it didn't": if an action doesn't show up here, the server
never received it. Memory only (last 3,000 events); also toggled with `/bothelper debug on` / `off`. Anything the
server cancelled is shown in red.

## 🔌 Server plugin: BotHelper

A Paper plugin (`server-plugin/` folder) that helps the bots from inside the server:

| | |
|---|---|
| ⚡ Performance | Bots **don't spawn mobs** around them (except the hunter) and **don't count for sleeping** |
| 🎣 Fishing | Whatever a bot catches **appears at its feet** instead of flying towards it (from some shores it hit the edge, fell into the water and was lost) |
| 🛡️ Protection | No damage from **monsters** (hits, arrows, creepers, witches, poison) or **falling**; monsters don't chase them. Tools **still wear out**. The **hunter** is the exception: monsters (creepers too) do attack and hurt it (`protection.hunters-fight`); falls don't hurt it either |
| 🧱 Chests | Bots **can't place solid blocks on top of a chest** (a covered chest won't open; for a double chest one half is enough) |
| 🌀 Teleport | Bots teleport **through the plugin**: no `/tp` and no "[Bot_X: Teleported…]" in your chat or the console. Without the plugin they fall back to `/tp` |
| 🆘 Rescue | The server knows if a bot is in **lava, fire, suffocating or drowning**, or how long it has been **still** even across reconnects; the panel brings it home (`config.js` → `serverRescue`: miner and woodcutter, 4 min still away from home) |
| 🔇 Silence | No **join, leave, death or advancement** messages for bots in chat |
| 🧲 Magnet | Whatever a block broken by a bot drops **appears at its feet** |
| 🏹 Hunter | For mob spawning it **counts as a player** (monsters spawn around it; otherwise it would find none while exploring). Drops and XP from a monster killed by a bot **go straight into its inventory**. When following a player, teleports **never take it to another world** (Nether, End). `hunters` list in `config.yml` |
| 🗺️ Map | Draws on **BlueMap** (if installed) each bot's path over the last hour, its home and its work zone |
| ⚡ Chunks | The server loads around each bot **only the distance it asks for** (`viewDistance` in `config.js`), not `server.properties`' `view-distance`: with 6 bots, from ~3,000 loaded chunks to ~1,000 |
| 🧹 Mobs | On Paper 26.2 hundreds of mobs per minute spawned around the bots and, since bots don't count for despawning, they piled up by the thousands. Natural spawns of monsters, bats and fish far from real players are now prevented, and every minute **disposable** monsters, bats and fish (unnamed, unleashed, not persistent, not from a bucket) more than 128 blocks from any real player are removed. Animals, villagers, bosses and anything near you are never touched |
| 🤫 No commands | The bots' scale and saturation on spawn, and the items they give themselves (chests, furnaces, tools…), are applied by the plugin: nothing shows up in your OP chat. Without the plugin the bots use `/attribute`, `/effect` and `/give` |
| 🔍 Searches | The **server** finds ores, logs and ripe crops for the miner, woodcutter and farmer (on another thread, without loading chunks, at most 2 ms per tick). The panel used to do it and froze for seconds; without the plugin each bot searches as before |
| 🔌 Panel | **Server status** in the header (TPS, ms per tick, RAM, entities, players) with an alert when it lags; **live warehouse** (reads the chests directly, including what you move by hand); **console**; **diagnostic log** of what the bots do |

It only listens on this PC (`127.0.0.1:8200`) and requires a key it creates on startup
(`plugins/BotHelper/token.txt`, which the panel reads). **Without the plugin the panel works as before.**

**Install** (needs the JDK, which the server's Java already includes; no Gradle or Maven):
```
powershell -ExecutionPolicy Bypass -File server-plugin\build.ps1 -Install
```
It compiles against the server's own libraries (`C:\Server` by default; another folder with `-ServerDir`), copies
`BotHelper.jar` to `plugins/`, and then you **restart the server**. Settings live in `plugins/BotHelper/config.yml`
(bot names, which protections to use…), plus `/bothelper` / `/bothelper reload` in game. `config.js` →
`serverPlugin` holds the plugin address and the path to `token.txt`.

Mobs that already existed don't vanish on their own: run `kill @e[type=minecraft:bat]` in the console.

**Discord alerts:** with **DiscordSRV**, new alerts (red and yellow) are posted to its main channel via `discord broadcast`
(`config.js` → `notifications`: `discord`, `discordMaxPerHour`; the same alert isn't repeated within 30 min).

Each plugin option can be turned off in `plugins/BotHelper/config.yml` (`protection.no-blocks-on-chests`,
`chat.silence-bots`, `magnet.enabled`…) and applied with `/bothelper reload`.

---

## 🧠 How the bots work

### 🏠 Home & storage (all bots)
- A **home** is a chest (or barrel) plus every chest **within 6 blocks** of it.
- How it is chosen: `bots.<bot>.home` in config → `chest.position` → `data/home_<bot>.json` → nearest chest on spawn.
- Bots only use **their own** chests, never random chests they come across.
- **Going home:** woodcutter, miner and hunter return when their inventory is almost full (≤ 2 free slots); the
  farmer once it has 128 harvested items and the fisher every 16 catches. They travel in 48-block legs.
  **More than 150 blocks away (or underground) they go home and back with `/tp`** directly (`config.js` →
  `home.teleportDistance`, or the ⚙️ Settings tab); closer, they walk, and if they can't make it within 3 minutes they
  use `/tp`. After storing, they go back to exactly where they were working.
- **Automatic chests:** when every home chest is full, the bot `/give`s itself a chest and places it next to
  the others, up to **15 per home**.
- **What each bot keeps when storing:**

| Bot | Reserve |
|---|---|
| Woodcutter | 1 axe and 8 saplings of each type |
| Miner | 1 pickaxe and 32 cobblestone + 32 cobbled deepslate (for rescue pillars) |
| Farmer | 1 hoe, 32 wheat seeds, 16 carrots / potatoes / beetroot seeds |
| Fisher | 1 fishing rod |
| Hunter | 1 sword of each type, the bow, 192 arrows and its diamond armor |

### 🪓 Woodcutter
- Finds the base of a tree (radius 96), chops it bottom-up and replants the sapling. The log says how many logs it
  gained (with a *Veinminer*- or *Timber*-style plugin the whole tree falls when it breaks the base).
- Without an axe it chops by hand; when it passes near home without one, it checks the chests.
- With no trees around it **explores**, keeping a heading.

### ⛏️ Miner
- Picks the **most valuable ore** in sight (radius 64): diamond > emerald > gold > iron > coal > copper > lapis > redstone.
- Skips ores its pickaxe can't harvest (e.g. diamond with a stone pickaxe).
- Without a pickaxe it **goes home to get one**; if there is none, it waits (use 🎁 Dar herramienta).
- When full, it first drops filler blocks (gravel, sand, dirt…) but keeps its stack of blocks for rescue pillars.

### 🌾 Farmer
- **Anchored to its home:** it looks for everything within 48 blocks of it, and walks back if it wanders off.
- Harvests ripe wheat, carrots, potatoes and beetroots and replants immediately.
- Sows empty farmland and, with a hoe, **tills new land next to water**.
- With no seeds, breaks grass to get some.
- When there's nothing to do it checks every 20 s instead of every 4 s (saves CPU).
- **Composter:** it places one next to its home and fills it with its spare seeds (wheat and beetroot, beyond what it
  keeps for replanting); when it runs out it fetches a batch from the warehouse. The bone meal it gets makes young
  crops grow instantly, and seeds no longer fill the warehouse (`config.js` → `farm.compost`, or the ⚙️ Settings tab).

### 🎣 Fisher
- Looks for **open water** (≥ 9 water blocks in a 5×5 area) within 32 blocks of home and a solid shore.
  It ignores 1-block channels so it won't trample crops.
- Casts and waits for a bite; after 45 s without one it reels in and casts again from the same spot (fish never run
  out); it only looks for another shore if it can't reach its own.
- Stores every 16 catches. When the rod breaks it takes a spare from the chest (leave some there).

### 🗂️ Organizer (central warehouse)
- Every **20 minutes** (or with 🗂️ Organizar ahora) it runs a round:
  1. `/give`s itself 4 chests and 4 signs (material to expand the warehouse).
  2. Teleports to each bot's home and **takes everything except their spare tools**
     (pickaxes, axes, hoes, shovels, swords, bows, rods, shears). It waits if that bot is storing at that moment.
  3. Returns to the warehouse and puts each item **in its category chest**. Every deposit is verified and retried if the server rejects it.
  4. If a category has no chest or it's full, it **places a new chest with a sign on top** naming the category.
- Chests are laid out **on a grid with aisles** and never touch (so they don't merge into double chests mixing categories).
- **Unlimited warehouse** (`maxChests: 0`): when it runs out of room, the grid **grows in rings** up to
  `maxWarehouseRadius` (112 blocks). It never places chests next to other bots' homes.
  If a category doesn't fit, those items stay in the bots' homes and the rest keeps being sorted.
- If the server rejects a deposit (happens with items ViaVersion tags, like eggs), it retries into empty slots.
- **Categories:** Madera (wood), Minerales (ores), Piedra (stone), Cultivos (crops), Pesca (fish),
  Comida (food), Mobs and Varios (everything else). Edit them in `config.js` → `organizer.categories`
  (wildcards allowed: `*_log` = every log).
- **You can sort by hand:** a chest with a sign (on top or on a side) naming a category will be used for it.
  Case and accents don't matter. Chests **without a sign are never touched**.
- **Inbox (optional, off):** with `organizer.inbox: true`, its home chest is emptied and sorted every round
  (handy for dropping things off). If that chest holds your stuff, it will be moved!

### 🛠️ Artisan (workshop: furnaces + tools)
- Its home is a chest in the **workshop, near the warehouse** (outside its grid), with ~7 flat free blocks to
  the north for the furnaces and some room on the sides for the crafting table: `!casa artesano`.
- **Tools (first):** every 10 min it checks that each bot has **1 spare tool** at home: axe (woodcutter),
  pickaxe (miner), hoe (farmer), fishing rod (fisher) and sword and bow (hunter). If one is missing it takes
  materials from the warehouse (**diamond**; else iron or stone; sticks or wood to make them; string for rods and
  bows, which the hunter brings back from spiders),
  **crafts it at a crafting table** and **drops it into that bot's chest** via `/tp`.
- **Only goes to the warehouse when what it needs is there:** with the BotHelper plugin it knows what each chest
  holds (read every 30 s), so with nothing to smelt it doesn't travel, and otherwise it only opens those chests.
- **Furnaces:** places **4 furnaces** next to its chest. When furnaces are free it takes **raw iron, gold and
  copper**, **raw meat and fish** and **potatoes** from the warehouse, with **coal** as fuel (or wood if there's
  no coal), and loads 64 at a time. The furnaces keep working while it crafts tools.
- It stores the results (ingots, cooked food) and leftover materials in its chest; **the organizer takes them
  to the warehouse**.
- Tune it in `config.js` → `smelter` (furnaces) and `smith` (tools).

### 🏹 Hunter
- **What it does** (its panel card, the ⚙️ Settings tab or `!cazador` in game):
  - **🛡️ Follow:** goes with a player (`hunter.player`) and hunts the monsters that come near (16 blocks). If you
    get more than 32 blocks away or it loses sight of you, it teleports next to you. It won't follow you to the
    Nether or the End or while you're in spectator mode: then it guards its home.
  - **🧭 Explore:** roams around its home (160 blocks) or its **map zone**, hunting whatever it finds.
  - **🔄 Auto** (default): follows the player while they're online; otherwise it explores.
- **Sword and bow:** melee with the sword (waiting for its cooldown, like a player) and at range (7–40 blocks) with
  the bow: it **computes the arrow drop** and leads moving targets. It **never shoots** when a player, another bot, a
  villager, an animal or a block is in the arrow's path: it walks up and uses the sword instead.
- **Prey:** zombies, skeletons (and variants), spiders, creepers (first, before they blow something up), witches,
  slimes, phantoms, pillagers… It **never attacks** endermen, piglins, wardens or anything with a name tag (pets,
  decorations).
- **Loot:** with the plugin it goes straight into its inventory (without it, it picks it up from the ground). It
  stores it at home when full; the organizer moves it to the Mobs category. Out of arrows, it `/give`s itself 64.
- **It never breaks or places blocks** to get through (`canDig: false`): it can walk around your base safely.
- Without a sword or bow it goes home for the spare the artisan leaves there.
- **Monsters really attack it** (only it: the other bots stay protected), so it works as a shield: they go for it
  instead of you. It wears **diamond armor** (it `/give`s itself any missing or broken piece) and **infinite
  saturation heals it** one heart per second. At **3 hearts or less** it leaves the fight, heals at home and comes back
  at 8. If something it doesn't hunt attacks it (an enderman, a zombified piglin…), it fights back. If it dies, with
  `keepInventory` it loses nothing: it respawns and comes back.
  > With the `mob_griefing` game rule off, creepers exploding next to it don't break blocks.

### 🆘 Getting unstuck (woodcutter & miner)
- If a bot spends **90 s away from home without moving more than 3 blocks**, it's considered stuck:
  1. It climbs to the surface: stairs or towering with the pathfinder and, failing that, a **manual pillar**
     (dig above, jump, place a block underneath). It aborts if there's lava or water above. Then it walks home.
  2. If that fails, or it gets stuck again within 10 min: **`/tp` home**.
- The stuck area (10 blocks) and the target it was chasing are **avoided for 30 minutes** so it doesn't repeat.
- Afterwards it stores its inventory and keeps working.

---

## 💬 Chat commands

| Command | Effect |
|---|---|
| `!casa <bot>` | That bot adopts the chest nearest to it (≤ 8 blocks) as its home |
| `!casa todos` | Same for every bot (each looks near itself) |
| `!cazador sigueme` | The hunter follows and protects you (follow mode) |
| `!cazador explora` | The hunter goes exploring and hunting on its own |
| `!cazador auto` | Follows you while you're online, explores when you're not |
| `!cazador ven` | Teleports next to you now |
| `!cazador casa` | Goes home to store what it carries |

`<bot>` can be the Spanish role name (`minero`, `leñador`/`lenador`, `granjero`, `pescador`, `organizador`,
`artesano`, `cazador`), the key (`miner`, `woodcutter`, `farmer`, `fisher`, `organizer`, `artisan`, `hunter`) or the
username (`Bot_Minero`).

---

## ⚙️ Configuration (`config.js`)

| Section | Main options |
|---|---|
| `server` | `host`, `port`, `version` (protocol Mineflayer uses; ViaBackwards translates), `viewDistance` (`short` by default) |
| `performance` | `pathfinderTickMs` (20): max CPU per tick for path computation. Miner and woodcutter use 40 (`bots.<bot>.pathfinderTickMs`): with less they compute paths in fragments and hesitate at 1-block steps |
| `panel` | `port` (3000), `autoStart` (start the bots when the panel opens) |
| `reconnect` | `enabled`, `delayMs` (after a server restart the bots come back one at a time, 4 s apart) |
| `search` | Radii: `woodRadius` 96, `mineRadius` 64, `farmRadius` 48, `chestRadius` 48 |
| `chest` | `enabled`, `position` (shared home for every bot) |
| `home` | `returnWhenFreeSlots` 2, `returnToWorkSpot`, `maxTravelMinutes` 3, `teleportDistance` 150, `chestRadius` 6, `autoChests`, `maxChests` 15 |
| `farm` | `autoCreate` (till next to water), `searchWaterRadius` |
| `stuck` | `detectSeconds` 90, `allowTeleport`, `repeatMinutes` 10 |
| `organizer` | `intervalMinutes` 20, `warehouseRadius` 12, `maxWarehouseRadius` 112, `maxChests` 0 (unlimited), `inbox`, `protect`, `categories` |
| `fishing` | `searchRadius` 32 |
| `hunter` (Hunter) | `mode` (`auto` / `follow` / `explore`), `player`, `guardRadius` 16, `exploreRadius` 160, `useBow` |
| `smelter` (Artisan, furnaces) | `furnaces` 4, `cycleSeconds` 30, `batchPerFurnace` 64, `smelt` (what to smelt/cook), `fuels` |
| `smith` (Artisan, tools) | `checkMinutes` 10, `sparesPerBot` 1, `tools` (each bot's tool), `tiers` (diamond > iron > stone) |
| `botStart` | On spawn: `scale` 0.9999 (fixes mineflayer's jump physics in 1.21+) and `saturation` (no need to eat). With the plugin, no commands |
| `starterCommands` | Extra commands each bot runs on spawn (they show up in the OP chat) |
| `farm` | `autoCreate` (till next to water), `searchWaterRadius`, `compost` (composter) |
| `bots.<bot>` | `username`, `home` (fixed `{x,y,z}`), `stuckWatch`, `give` (what 🎁 hands out), `viewDistance`, `autoHome`, `pathfinderTickMs`, `canDig` (`false`: never breaks or places blocks while walking) |

---

## 📌 Good to know

- **No hunger:** every time a bot spawns (also after dying) it gives itself infinite **Saturation**
  (`config.js` → `botStart`), so it never needs to eat. With `keepInventory` on, a death costs nothing.
- **OP & offline mode:** the bots need OP for `/tp`, `/give`, `/summon` and the physics fix. In offline mode,
  anyone using a bot's name inherits its OP. On shared servers, use a login (password) plugin or change the
  bot usernames in `config.js`.
- **Don't run a bot on its own** (`node bots/<bot>.js`) while the panel is running: both would log in with the
  same name and kick each other in a loop.
- **Resources:** with all 7 bots the process uses about **400–450 MB of RAM** and around **half a CPU core**
  while everyone is busy. Path computation is the biggest cost (`performance.pathfinderTickMs`).
- **If a bot dies**, it respawns at spawn or its bed and goes back to work (with `keepInventory` it loses nothing).
- **Change a bot's home:** `!casa <bot>` / 🏠 Fijar casa, or delete `data/home_<bot>.json`.
- **Home chest broken:** the bot forgets that home and adopts another (except organizer, artisan and hunter).
- **Red warnings** in the log are mostly self-explanatory ("¿Es OP?" = is it OP?, "cofres llenos" = chests
  full, "no llego al cofre" = can't reach the chest…). Filter the log by bot to see why it's doing something.

---

## 📁 Project structure

```
abrir_panel.bat        Opens the panel on Windows (recommended)
panel.js               Manager for the bots + panel server (127.0.0.1:3000)
panel/index.html       Panel UI
panel/alerts.js        Bot alerts
panel/serverlink.js    Link to the BotHelper plugin
panel/settings.js      Settings changed from the panel (data/settings.json)
config.js              All the configuration
bots/common.js         Shared logic: home, travel, chests, rescue, panel commands, /give, /tp
bots/stats.js          Statistics counters
bots/inventory.js      Warehouse inventory (what each chest holds)
bots/woodcutter.js     Woodcutter
bots/miner.js          Miner
bots/farmer.js         Farmer
bots/fisher.js         Fisher
bots/organizer.js      Organizer
bots/artisan.js        Artisan (furnaces + tools)
bots/hunter.js         Hunter (sword, bow with trajectory computation, follow or explore)
bots/warehouse.js      Warehouse access (used by the artisan and orders)
server-plugin/         BotHelper plugin for Paper (source and build.ps1)
data/                  Your world's data (created automatically, not committed):
  home_<bot>.json        each bot's home
  zones.json             work zones chosen on the map
  settings.json          settings changed from the panel
  almacen.json           category of each organizer chest (backup of the signs)
  stats.json             accumulated statistics
  almacen_inventario.json  contents of each warehouse chest
```

Run a single bot without the panel: `node bots/miner.js` (same for the others).

---

## 📄 License

Released under the [MIT](LICENSE) license: you may use, copy, modify and distribute this code freely,
as long as you keep the copyright notice and the license.
