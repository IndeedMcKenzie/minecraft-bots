// ============================================================
//  bots/miner.js — Bot Minero Autónomo
//  1. Si no tiene pico, va a casa a buscar uno en los cofres
//  2. Busca minerales valiosos (carbón, hierro, oro, diamante) explorando
//  3. Descarta bloques de relleno (tierra, grava, adoquín)
//  4. Con el inventario lleno vuelve a casa, guarda todo y regresa
// ============================================================
const mineflayer = require('mineflayer')
const { pathfinder, goals: { GoalNear } } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const cfg = require('../config')
const stats = require('./stats')
const {
  botOptions,
  setupBot,
  safeGoto,
  explore,
  equipBestTool,
  returnHomeAndDeposit,
  runPendingCommand,
  setIssue,
  clearIssue,
  isInventoryFull,
  withdrawToolsFromChest,
  collectNearbyItems,
  markBad,
  isBad,
  inStuckZone,
  SCAFFOLD_ITEMS,
  sleep,
  fmtPos,
  serverFindBlocks,
  getZone,
  inZone,
  goToZone,
  exploreZone,
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

// Minerales que busca, del más importante al menos (cada uno con su versión de pizarra). Se eligen y ordenan en la
// pestaña ⚙️ Ajustes del panel (cfg.miner.ores) y se leen en cada búsqueda
const DEFAULT_ORES = ['diamond', 'emerald', 'gold', 'iron', 'coal', 'copper', 'lapis', 'redstone']
function orePriority() {
  const families = (cfg.miner && Array.isArray(cfg.miner.ores) && cfg.miner.ores.length) ? cfg.miner.ores : DEFAULT_ORES
  return families.flatMap(f => [`${f}_ore`, `deepslate_${f}_ore`])
}

// Lo que suelta cada mineral (sin toque de seda) → su nombre en las estadísticas ("minerales por tipo")
const ORE_OF_DROP = {
  coal: 'coal', raw_iron: 'iron', raw_copper: 'copper', raw_gold: 'gold', diamond: 'diamond',
  emerald: 'emerald', lapis_lazuli: 'lapis', redstone: 'redstone',
}
function oreDrops(bot) {
  const out = {}
  for (const i of bot.inventory.items()) if (ORE_OF_DROP[i.name]) out[i.name] = (out[i.name] || 0) + i.count
  return out
}

// Por debajo de esta altura la roca madre está mezclada con la pizarra (capas -64 a -60)
const MIN_ORE_Y = -58

const JUNK_NAMES = [
  'cobblestone', 'cobbled_deepslate', 'dirt', 'gravel',
  'sand', 'andesite', 'granite', 'diorite', 'tuff',
]

function createBot(ctrl = {}) {
  const bot = mineflayer.createBot(botOptions('miner'))

  bot.loadPlugin(pathfinder)

  setupBot(bot, 'Minero', () => createBot(ctrl), 'miner', ctrl)

  bot.once('spawn', () => {
    console.log(`[${cfg.bots.miner.username}] ⛏️ Conectado. Iniciando minería autónoma...`)
    setTimeout(() => workLoop(bot), 3000)
  })

  return bot
}

// Al guardar: 1 pico de cada tipo y una reserva de andamio (adoquín / pizarra profunda)
const KEEP_AMOUNTS = {
  ...Object.fromEntries(PICKAXES.map(p => [p, 1])),
  cobblestone: 32,
  cobbled_deepslate: 32,
}

async function workLoop(bot) {
  bot.depositRules = { keep: [], amounts: KEEP_AMOUNTS }

  while (!bot.stopped) {
    try {
      // ── 0. Órdenes del panel (p. ej. volver a casa) ──────────
      if (await runPendingCommand(bot)) continue

      const mcData = bot.registry

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
        setIssue(bot, 'tool', 'err', 'Sin pico: no puede minar hasta que haya uno en su cofre')
        console.log('[Minero] ⚠️ Sin pico en inventario ni en cofres. Esperando pico...')
        bot.idle = true // espera a propósito: que el detector de atascos no lo confunda
        await sleep(10000)
        continue
      }
      bot.idle = false
      clearIssue(bot, 'tool')

      // ── 5. Si tiene zona de trabajo (elegida en el mapa del panel) y está fuera, ir a ella
      if (await goToZone(bot)) continue

      // ── 6. Buscar el mejor mineral que el pico actual pueda extraer (dentro de su zona, si tiene) ──
      const zone = getZone('miner')
      const oreBlock = await findBestOre(bot, mcData, bot.heldItem?.type, zone)
      bot.currentTarget = oreBlock ? oreBlock.position : null // si se atasca yendo, se descarta

      if (!oreBlock && zone) {
        console.log('[Minero] 🔍 No veo minerales en mi zona desde aquí. La recorro...')
        await exploreZone(bot, zone)
        await sleep(3000)
        continue
      }
      if (!oreBlock) {
        console.log('[Minero] 🔍 No hay minerales visibles cerca. Explorando...')
        await explore(bot, 32)
        await sleep(500)
        continue
      }

      console.log(`[Minero] 💎 Encontrado: ${oreBlock.name} en ${fmtPos(oreBlock.position)}`)

      // ── 7. Navegar de forma segura hasta el mineral ──────────
      const reached = await safeGoto(bot, new GoalNear(oreBlock.position.x, oreBlock.position.y, oreBlock.position.z, 2), 15)
      if (!reached) {
        console.log('[Minero] ⚠️ Mineral inalcanzable temporalmente, buscando otro...')
        markBad(bot, oreBlock.position)
        await sleep(2000)
        continue
      }

      // ── 8. Picar mineral con el mejor pico ───────────────────
      await equipBestTool(bot, PICKAXES)
      const before = oreDrops(bot)
      let dug = false
      try {
        await bot.dig(oreBlock)
        dug = true
      } catch (err) {
        console.warn(`[Minero] Error al picar mineral: ${err.message}`)
        markBad(bot, oreBlock.position)
      }

      // ── 9. Recoger drops del suelo ───────────────────────────
      await sleep(600)
      // Ignorar el relleno del suelo, salvo el de andamio si le falta reserva para pilares
      const ignore = scaffoldCount(bot) >= SCAFFOLD_RESERVE ? JUNK_NAMES : JUNK_NAMES.filter(n => !SCAFFOLD_ITEMS.includes(n))
      await collectNearbyItems(bot, 8, ignore)

      // Lo que de verdad ganó: el plugin Veinminer del servidor rompe la veta entera al picar un mineral, así que
      // cada bloque que pica el bot puede dar 1 o 20 objetos. Se cuenta lo que entra en el inventario, por tipo.
      if (dug) {
        const after = oreDrops(bot)
        const gained = Object.keys(after).map(k => [k, after[k] - (before[k] || 0)]).filter(([, n]) => n > 0)
        const total = gained.reduce((a, [, n]) => a + n, 0)
        console.log(`[Minero] ✅ Minado: ${oreBlock.name}${total ? ` (+${gained.map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ')})` : ''}`)
        for (const [item, n] of gained) {
          stats.add('miner', 'minerales', n)
          stats.addDetail('minerales', ORE_OF_DROP[item], n)
        }
      }

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
// Con zona: solo dentro de ella (en horizontal), buscando desde su centro a la altura del bot
async function findBestOre(bot, mcData, pickType, zone) {
  const priority = new Map()
  const oreNames = orePriority()
  oreNames.forEach((name, i) => {
    const b = mcData.blocksByName[name]
    if (b) priority.set(b.id, Math.floor(i / 2)) // cada mineral y su versión deepslate comparten prioridad
  })

  // Nunca en las últimas capas: la roca madre aparece mezclada y el minero puede quedar encerrado sin salida
  const usable = (b) => b && b.position.y >= MIN_ORE_Y && !isBad(bot, b.position) && !inStuckZone(bot, b.position) && !!b.canHarvest(pickType) &&
    (!zone || inZone(zone, b.position))
  const center = zone ? new Vec3(zone.x, Math.floor(bot.entity.position.y), zone.z) : null
  const localSearch = () => bot.findBlocks({ matching: [...priority.keys()], point: center || undefined, maxDistance: cfg.search.mineRadius, count: 64, useExtraInfo: usable })
    .map(p => bot.blockAt(p))

  // Lo busca el servidor (plugin), solo entre los minerales que este pico puede picar y sin los descartados ni las
  // zonas de atasco (se los manda serverFindBlocks), así que lo que devuelve ya vale; si no está, el bot como siempre
  const types = oreNames.filter(name => {
    const b = mcData.blocksByName[name]
    return b && (!b.harvestTools || (pickType != null && b.harvestTools[pickType]))
  })
  if (types.length === 0) return null
  const remote = await serverFindBlocks(bot, { types, center, radius: cfg.search.mineRadius, hRadius: zone ? zone.radius : undefined, count: 128, minY: MIN_ORE_Y })
  let candidates = remote ? remote.map(p => bot.blockAt(p)).filter(usable) : localSearch().filter(Boolean)
  // Si aun así el bot descartó todo lo que mandó el servidor y había más, búsqueda local de respaldo
  if (remote && candidates.length === 0 && remote.saturated) candidates = localSearch().filter(Boolean)
  if (candidates.length === 0) return null

  const here = bot.entity.position
  let best = null
  let bestScore = Infinity
  for (const block of candidates) {
    const score = priority.get(block.type) * 1000 + block.position.distanceTo(here)
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
