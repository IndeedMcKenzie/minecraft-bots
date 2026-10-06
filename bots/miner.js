// ============================================================
//  bots/miner.js — Bot Minero Autónomo
//  1. Si no tiene pico, va a casa a buscar uno en los cofres
//  2. Busca minerales valiosos (carbón, hierro, oro, diamante) explorando
//  3. Descarta bloques de relleno (tierra, grava, adoquín)
//  4. Con el inventario lleno vuelve a casa, guarda todo y regresa
// ============================================================
const mineflayer = require('mineflayer')
const { pathfinder, goals: { GoalNear } } = require('mineflayer-pathfinder')
const { loader: autoEat } = require('mineflayer-auto-eat')
const cfg = require('../config')
const {
  botOptions,
  setupBot,
  safeGoto,
  explore,
  equipBestTool,
  returnHomeAndDeposit,
  runPendingCommand,
  isInventoryFull,
  withdrawToolsFromChest,
  collectNearbyItems,
  markBad,
  isBad,
  inStuckZone,
  SCAFFOLD_ITEMS,
  sleep,
  fmtPos,
} = require('./common')

// Bloques de andamio que conserva para poder subir en pilar si se atasca en una cueva
const SCAFFOLD_RESERVE = 64

const PICKAXES = [
  'netherite_pickaxe',
  'diamond_pickaxe',
  'iron_pickaxe',
  'golden_pickaxe',
  'stone_pickaxe',
  'wooden_pickaxe',
]

const ORE_PRIORITY = [
  'diamond_ore',           'deepslate_diamond_ore',
  'emerald_ore',           'deepslate_emerald_ore',
  'gold_ore',              'deepslate_gold_ore',
  'iron_ore',              'deepslate_iron_ore',
  'coal_ore',              'deepslate_coal_ore',
  'copper_ore',            'deepslate_copper_ore',
  'lapis_ore',             'deepslate_lapis_ore',
  'redstone_ore',          'deepslate_redstone_ore',
]

const FOODS = ['bread', 'cooked_beef', 'cooked_porkchop', 'apple', 'baked_potato']

const JUNK_NAMES = [
  'cobblestone', 'cobbled_deepslate', 'dirt', 'gravel',
  'sand', 'andesite', 'granite', 'diorite', 'tuff',
]

function createBot(ctrl = {}) {
  const bot = mineflayer.createBot(botOptions('miner'))

  bot.loadPlugin(pathfinder)
  bot.loadPlugin(autoEat)

  setupBot(bot, 'Minero', () => createBot(ctrl), 'miner', ctrl)

  bot.once('spawn', () => {
    console.log(`[${cfg.bots.miner.username}] ⛏️ Conectado. Iniciando minería autónoma...`)
    setTimeout(() => workLoop(bot), 3000)
  })

  return bot
}

// Al guardar: 1 pico de cada tipo, una reserva de andamio (adoquín / pizarra profunda) y hasta 16 de cada comida
const KEEP_AMOUNTS = {
  ...Object.fromEntries(PICKAXES.map(p => [p, 1])),
  ...Object.fromEntries(FOODS.map(f => [f, 16])),
  cobblestone: 32,
  cobbled_deepslate: 32,
}

async function workLoop(bot) {
  bot.depositRules = { keep: [], amounts: KEEP_AMOUNTS }

  while (!bot.stopped) {
    try {
      // ── 0. Órdenes del panel (p. ej. volver a casa) ──────────
      if (await runPendingCommand(bot)) continue

      const mcData = require('minecraft-data')(bot.version)

      // ── 1. Sin pico: ir a casa a buscar uno en los cofres ─────
      await withdrawToolsFromChest(bot, PICKAXES, { travel: true })

      // ── 2. Inventario lleno: primero tirar relleno; si sigue lleno, volver a casa a guardar
      if (isInventoryFull(bot)) {
        await discardJunk(bot)
      }
      if (isInventoryFull(bot)) {
        // Se queda 1 pico de cada tipo y la comida; los picos repetidos van al cofre
        await returnHomeAndDeposit(bot, [], KEEP_AMOUNTS)
      }

      // ── 4. Comprobar si tenemos pico disponible ──────────────
      const hasPick = await equipBestTool(bot, PICKAXES)
      if (!hasPick) {
        console.log('[Minero] ⚠️ Sin pico en inventario ni en cofres. Esperando pico...')
        bot.idle = true // espera a propósito: que el detector de atascos no lo confunda
        await sleep(10000)
        continue
      }
      bot.idle = false

      // ── 5. Buscar el mejor mineral que el pico actual pueda extraer ──
      const oreBlock = findBestOre(bot, mcData, bot.heldItem?.type)
      bot.currentTarget = oreBlock ? oreBlock.position : null // si se atasca yendo, se descarta

      if (!oreBlock) {
        console.log('[Minero] 🔍 No hay minerales visibles cerca. Explorando...')
        await explore(bot, 32)
        await sleep(500)
        continue
      }

      console.log(`[Minero] 💎 Encontrado: ${oreBlock.name} en ${fmtPos(oreBlock.position)}`)

      // ── 6. Navegar de forma segura hasta el mineral ──────────
      const reached = await safeGoto(bot, new GoalNear(oreBlock.position.x, oreBlock.position.y, oreBlock.position.z, 2), 15)
      if (!reached) {
        console.log('[Minero] ⚠️ Mineral inalcanzable temporalmente, buscando otro...')
        markBad(bot, oreBlock.position)
        await sleep(2000)
        continue
      }

      // ── 7. Picar mineral con el mejor pico ───────────────────
      await equipBestTool(bot, PICKAXES)
      try {
        await bot.dig(oreBlock)
        console.log(`[Minero] ✅ Minado: ${oreBlock.name}`)
      } catch (err) {
        console.warn(`[Minero] Error al picar mineral: ${err.message}`)
        markBad(bot, oreBlock.position)
      }

      // ── 8. Recoger drops del suelo ───────────────────────────
      await sleep(600)
      // Ignorar el relleno del suelo, salvo el de andamio si le falta reserva para pilares
      const ignore = scaffoldCount(bot) >= SCAFFOLD_RESERVE ? JUNK_NAMES : JUNK_NAMES.filter(n => !SCAFFOLD_ITEMS.includes(n))
      await collectNearbyItems(bot, 8, ignore)

      await sleep(1000)
    } catch (err) {
      console.warn(`[Minero] ⚠️ ${err.message}`)
      await sleep(3000)
    }
  }
}

// ── Encontrar mineral por prioridad ──────────────────────────
// Una sola búsqueda con todos los minerales (antes eran 16, una por tipo: mucha CPU) y luego
// se elige el más valioso, y entre iguales el más cercano. Ignora minerales en lista negra,
// en zonas donde se atascó hace poco y los que el pico no puede extraer.
function findBestOre(bot, mcData, pickType) {
  const priority = new Map()
  ORE_PRIORITY.forEach((name, i) => {
    const b = mcData.blocksByName[name]
    if (b) priority.set(b.id, Math.floor(i / 2)) // cada mineral y su versión deepslate comparten prioridad
  })

  const positions = bot.findBlocks({
    matching: [...priority.keys()],
    maxDistance: cfg.search.mineRadius,
    count: 64,
    useExtraInfo: (b) => !isBad(bot, b.position) && !inStuckZone(bot, b.position) && !!b.canHarvest(pickType),
  })
  if (positions.length === 0) return null

  const here = bot.entity.position
  let best = null
  let bestScore = Infinity
  for (const p of positions) {
    const block = bot.blockAt(p)
    if (!block) continue
    const score = priority.get(block.type) * 1000 + p.distanceTo(here)
    if (score < bestScore) { bestScore = score; best = block }
  }
  return best
}

// ── Tirar adoquín, tierra y grava para liberar espacio ────────
// Tira el relleno pero conserva SCAFFOLD_RESERVE bloques de andamio para los pilares de rescate
async function discardJunk(bot) {
  let reserve = SCAFFOLD_RESERVE
  for (const item of bot.inventory.items().filter(i => JUNK_NAMES.includes(i.name))) {
    let toss = item.count
    if (SCAFFOLD_ITEMS.includes(item.name) && reserve > 0) {
      const keep = Math.min(item.count, reserve)
      reserve -= keep
      toss -= keep
    }
    if (toss <= 0) continue
    try {
      await bot.toss(item.type, null, toss)
      await sleep(150)
    } catch {}
  }
}

function scaffoldCount(bot) {
  return bot.inventory.items().filter(i => SCAFFOLD_ITEMS.includes(i.name)).reduce((a, i) => a + i.count, 0)
}

module.exports = { createBot }

// Ejecutado directamente (node bots/miner.js) arranca solo; desde el panel lo controla panel.js
if (require.main === module) createBot()
