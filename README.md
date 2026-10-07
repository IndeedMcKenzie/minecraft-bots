# 🤖 Autonomous Minecraft Bots

**English** · [Español](README.es.md)

Six bots built with **[Mineflayer](https://github.com/PrismarineJS/mineflayer)** (Node.js) that work on their own
on a Paper server and are controlled from a **single-window web panel**:

| Bot | Username | What it does |
|---|---|---|
| 🪓 Woodcutter | `Bot_Lenador` | Explores, chops trees, replants saplings and stores the wood |
| ⛏️ Miner | `Bot_Minero` | Finds ores by value, mines them and stores the loot |
| 🌾 Farmer | `Bot_Granjero` | Harvests, replants, sows and expands its farm next to water |
| 🎣 Fisher | `Bot_Pescador` | Fishes non-stop in open water near its home |
| 🗂️ Organizer | `Bot_Organizador` | Collects what the others store and sorts it into a central warehouse with labeled chests |
| 🐄 Rancher | `Bot_Ganadero` | Builds a fenced pen, breeds cows and culls the surplus above a cap |

**Highlights:** every bot has its own home and chests and returns to store items when its inventory fills
up · adds chests automatically · rescues itself when stuck in a cave · an organizer moves everything into
a warehouse sorted by category · live web panel with status, action buttons and statistics.

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
   op Bot_Ganadero
   ```
4. **Start the panel:** on Windows, double-click **`abrir_panel.bat`**. On any OS: `npm start` and open
   `http://127.0.0.1:3000`.
5. **Homes:** each bot adopts the nearest chest as its home when it spawns. To choose it yourself, teleport the
   bot next to a chest and type `!casa <bot>` in chat (or press **🏠 Fijar casa** in the panel).
   The **Organizer** and the **Rancher** never pick one on their own: you choose their home (the warehouse /
   the center of the pen).

> ⚠️ **Security:** in *offline* mode, anyone who joins with a bot's name gets its OP permissions. Use this on
> private servers or protect those names (see "Good to know").

---

## 🖥️ Control panel

`abrir_panel.bat` (or `npm start`) runs all 6 bots in **a single process** (`panel.js`, less RAM) and serves the
UI at `http://127.0.0.1:3000`, reachable only from the same PC.

- If the panel is already running, the `.bat` just reopens the window.
- **Closing the window does NOT stop the bots.** They keep running in a minimized process.
- **⏻ Apagar** (Shut down, with confirmation) stops every bot and the panel.
- After changing code or `config.js`, **shut down and reopen** the panel. Changes to `panel/index.html` only need **F5**.

### Each bot card shows
- Status (online / connecting / reconnecting / stopped), current activity and red warnings.
- ❤️ health, 🍗 food, 📍 position, 🎒 free slots and 🏠 home (with `N/15` chests).
- **Full inventory:** chips with 🔒 are the **reserve** the bot keeps on purpose when storing (tool, food,
  seeds…). `cobblestone ×39 (🔒32)` means it keeps 32 and will store 7.
- `📦 N to store · last stored X ago`.
- A **📦 home chests full** warning when nothing else fits.

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

### 📊 Statistics tab
Switch between **🤖 Bots** and **📊 Estadísticas** at the top (or open `http://127.0.0.1:3000/#stats`),
for **this session** or **all time**:
- **Key figures:** trees chopped, ores mined (and diamonds), crops harvested, fish caught, calves born,
  items stored and items sorted by the organizer.
- **Hourly chart** of items stored at home (last 24 h); hover for a per-bot breakdown.
- **Per-bot table:** time online, items stored, trips home, teleports, times stuck, chests placed,
  deaths and kicks.
- **Breakdowns:** ores by type, catches by type and warehouse by category.

Saved to `data/stats.json` (every minute and on shutdown). Delete that file to start over.

---

## 🧠 How the bots work

### 🏠 Home & storage (all bots)
- A **home** is a chest (or barrel) plus every chest **within 6 blocks** of it.
- How it is chosen: `bots.<bot>.home` in config → `chest.position` → `data/home_<bot>.json` → nearest chest on spawn.
- Bots only use **their own** chests, never random chests they come across.
- **Going home:** woodcutter and miner return when their inventory is almost full (≤ 2 free slots); farmer
  and fisher once they have 16 items. They travel in 48-block legs even from hundreds of blocks away.
  **If they can't walk home within 3 minutes, they use `/tp`.** After storing, they go back to where they were working.
- **Automatic chests:** when every home chest is full, the bot `/give`s itself a chest and places it next to
  the others, up to **15 per home**.
- **What each bot keeps when storing:**

| Bot | Reserve |
|---|---|
| Woodcutter | 1 axe, 8 saplings of each type, up to 16 of each food |
| Miner | 1 pickaxe, 32 cobblestone + 32 cobbled deepslate (for rescue pillars), up to 16 of each food |
| Farmer | 1 hoe, 32 wheat seeds, 16 carrots / potatoes / beetroot seeds |
| Fisher | 1 fishing rod |
| Rancher | 1 sword, 64 wheat, fences and dirt to repair the pen |

### 🪓 Woodcutter
- Finds the base of a tree (radius 96), chops it bottom-up and replants the sapling.
  If your server has a *Timber*-style plugin (the whole tree falls), the log will say "Talados 1 troncos".
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

### 🎣 Fisher
- Looks for **open water** (≥ 9 water blocks in a 5×5 area) within 32 blocks of home and a solid shore.
  It ignores 1-block channels so it won't trample crops.
- Casts and waits for a bite; after 45 s without one it reels in and casts again. After 3 misses in a row it moves.
- Stores every 16 catches. When the rod breaks it takes a spare from the chest (leave some there).

### 🗂️ Organizer (central warehouse)
- Every **20 minutes** (or with 🗂️ Organizar ahora) it runs a round:
  1. `/give`s itself 4 chests and 4 signs (material to expand the warehouse).
  2. Teleports to each bot's home and **takes everything except their spare tools**
     (pickaxes, axes, hoes, shovels, swords, rods, shears). It waits if that bot is storing at that moment.
  3. Returns to the warehouse and puts each item **in its category chest**. Every deposit is verified and retried if the server rejects it.
  4. If a category has no chest or it's full, it **places a new chest with a sign on top** naming the category.
- Chests are laid out **on a grid with aisles** and never touch (so they don't merge into double chests mixing categories). Max 40.
- **Categories:** Madera (wood), Minerales (ores), Piedra (stone), Cultivos (crops), Pesca (fish),
  Comida (food), Mobs and Varios (everything else). Edit them in `config.js` → `organizer.categories`
  (wildcards allowed: `*_log` = every log).
- **You can sort by hand:** a chest with a sign (on top or on a side) naming a category will be used for it.
  Case and accents don't matter. Chests **without a sign are never touched**.
- **Inbox (optional, off):** with `organizer.inbox: true`, its home chest is emptied and sorted every round
  (handy for dropping things off). If that chest holds your stuff, it will be moved!

### 🐄 Rancher (cows)
- Its home is a chest in the **center of the pen**: place the chest on **flat ground of at least 13×13**,
  teleport the bot next to it and use `!casa ganadero`.
- **Builds the pen** by itself: a square of fences 6 blocks from the chest with a **gate on the south side**
  for you. On uneven ground it **levels with dirt** so cows can't hop over the fence. It repairs gaps every
  5 minutes and, if you move its home, removes the old pen.
- With fewer than 2 adult cows it **`/summon`s the missing ones** (only once the pen is closed).
- **Breeds** pairs of adults with wheat (each cow once every 5 min) without exceeding the cap. Calves take ~20 min to grow.
- **Culls only above 10 cows** (adults + calves): it kills surplus adults with a sword, always keeping at least
  2, and stores the beef and leather (the organizer takes them to the warehouse).
- Fences, dirt, wheat and sword come from `/give` when missing. Tune it in `config.js` → `rancher`.
- ⚠️ Mob-stacking plugins (e.g. **StackMob**) make it miscount the cows and breed or cull too many.

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

`<bot>` can be the Spanish role name (`minero`, `leñador`/`lenador`, `granjero`, `pescador`, `organizador`,
`ganadero`), the key (`miner`, `woodcutter`, `farmer`, `fisher`, `organizer`, `rancher`) or the username (`Bot_Minero`).

---

## ⚙️ Configuration (`config.js`)

| Section | Main options |
|---|---|
| `server` | `host`, `port`, `version` (protocol Mineflayer uses; ViaBackwards translates), `viewDistance` (`short` by default) |
| `performance` | `pathfinderTickMs` (20): max CPU per tick for path computation. Miner and woodcutter use 40 (`bots.<bot>.pathfinderTickMs`): with less they compute paths in fragments and hesitate at 1-block steps |
| `panel` | `port` (3000), `autoStart` (start the bots when the panel opens) |
| `reconnect` | `enabled`, `delayMs` |
| `search` | Radii: `woodRadius` 96, `mineRadius` 64, `farmRadius` 48, `chestRadius` 48 |
| `chest` | `enabled`, `position` (shared home for every bot) |
| `home` | `returnWhenFreeSlots` 2, `returnToWorkSpot`, `maxTravelMinutes` 3, `chestRadius` 6, `autoChests`, `maxChests` 15 |
| `farm` | `autoCreate` (till next to water), `searchWaterRadius` |
| `stuck` | `detectSeconds` 90, `allowTeleport`, `repeatMinutes` 10 |
| `organizer` | `intervalMinutes` 20, `warehouseRadius` 12, `maxChests` 40, `inbox`, `protect`, `categories` |
| `fishing` | `searchRadius` 32 |
| `rancher` | `penRadius` 6, `maxCows` 10, `minBreeders` 2, `breedCooldownMinutes` 5, `cycleSeconds` 15 |
| `starterCommands` | Commands run on join (scale tweak for 1.21+ jump physics, needs OP) |
| `bots.<bot>` | `username`, `home` (fixed `{x,y,z}`), `stuckWatch`, `give` (what 🎁 hands out), `viewDistance`, `autoHome`, `pathfinderTickMs` |

---

## 📌 Good to know

- **OP & offline mode:** the bots need OP for `/tp`, `/give`, `/summon` and the physics fix. In offline mode,
  anyone using a bot's name inherits its OP. On shared servers, use a login (password) plugin or change the
  bot usernames in `config.js`.
- **Don't run a bot on its own** (`node bots/<bot>.js`) while the panel is running: both would log in with the
  same name and kick each other in a loop.
- **Resources:** with all 6 bots the process uses about **450–550 MB of RAM** and around **half a CPU core**
  while everyone is busy. Path computation is the biggest cost (`performance.pathfinderTickMs`).
  Every animal in the pen also costs the server: don't raise `rancher.maxCows` too much.
- **If a bot dies**, it loses what it carried and respawns at spawn or its bed, then goes back to work.
- **Change a bot's home:** `!casa <bot>` / 🏠 Fijar casa, or delete `data/home_<bot>.json`.
- **Home chest broken:** the bot forgets that home and adopts another (except organizer and rancher).
- **Red warnings** in the log are mostly self-explanatory ("¿Es OP?" = is it OP?, "cofres llenos" = chests
  full, "no llego al cofre" = can't reach the chest…). Filter the log by bot to see why it's doing something.

---

## 📁 Project structure

```
abrir_panel.bat        Opens the panel on Windows (recommended)
panel.js               Manager for the 6 bots + panel server (127.0.0.1:3000)
panel/index.html       Panel UI
config.js              All the configuration
bots/common.js         Shared logic: home, travel, chests, rescue, panel commands, /give, /tp
bots/stats.js          Statistics counters
bots/woodcutter.js     Woodcutter
bots/miner.js          Miner
bots/farmer.js         Farmer
bots/fisher.js         Fisher
bots/organizer.js      Organizer
bots/rancher.js        Rancher
data/                  Your world's data (created automatically, not committed):
  home_<bot>.json        each bot's home
  almacen.json           category of each organizer chest (backup of the signs)
  corral.json            pens built by the rancher
  stats.json             accumulated statistics
```

Run a single bot without the panel: `node bots/miner.js` (same for the others).

---

## 📄 License

Released under the [MIT](LICENSE) license: you may use, copy, modify and distribute this code freely,
as long as you keep the copyright notice and the license.
