// ============================================================
//  bots/woodcutter.js — Bot Leñador Autónomo
//  Tala árboles (con hacha o con las manos si está vacío) y replanta
//  brotes mientras explora; con el inventario lleno vuelve a casa a guardar
// ============================================================
const mineflayer = require('mineflayer')
const { pathfinder, goals: { GoalNear, GoalBlock } } = require('mineflayer-pathfinder')
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
  isInventoryFull,
  withdrawToolsFromChest,
  collectNearbyItems,
  markBad,
  isBad,
  inStuckZone,
  inReach,
  teleportTo,
  setIssue,
  clearIssue,
  sleep,
  fmtPos,
} = require('./common')

const LOG_TYPES = [
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log',
  'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
  'pale_oak_log',
]

const SAPLING_MAP = {
  oak_log:      'oak_sapling',
  birch_log:    'birch_sapling',
  spruce_log:   'spruce_sapling',
  jungle_log:   'jungle_sapling',
  acacia_log:   'acacia_sapling',
  dark_oak_log: 'dark_oak_sapling',
  mangrove_log: 'mangrove_propagule',
  cherry_log:   'cherry_sapling',
  pale_oak_log: 'pale_oak_sapling',
}

const AXES = ['netherite_axe', 'diamond_axe', 'iron_axe', 'golden_axe', 'stone_axe', 'wooden_axe']

// Lo que se queda al guardar: 1 hacha de cada tipo (las repetidas van al cofre),
// y 8 brotes de cada tipo para replantar
const KEEP_AMOUNTS = Object.fromEntries([
  ...AXES.map(a => [a, 1]),
  ...Object.values(SAPLING_MAP).map(s => [s, 8]),
])

function createBot(ctrl = {}) {
  const bot = mineflayer.createBot(botOptions('woodcutter'))

  bot.loadPlugin(pathfinder)

  setupBot(bot, 'Leñador', () => createBot(ctrl), 'woodcutter', ctrl)

  bot.once('spawn', () => {
    console.log(`[${cfg.bots.woodcutter.username}] 🪓 Conectado y listo. Iniciando recolección autónoma...`)
    setTimeout(() => workLoop(bot), 3000)
  })

  return bot
}

async function workLoop(bot) {
  let treesCut = 0
  bot.depositRules = { keep: [], amounts: KEEP_AMOUNTS }

  while (!bot.stopped) {
    try {
      // 0. Órdenes del panel (p. ej. volver a casa)
      if (await runPendingCommand(bot)) continue

      const mcData = bot.registry

      // 1. Sin hacha: ir a casa a por el repuesto (el Artesano deja uno allí); talar a mano es mucho más lento
      await withdrawToolsFromChest(bot, AXES, { travel: true })

      // 2. Inventario lleno: volver a casa, guardar todo (menos un hacha, comida y algunos brotes) y regresar
      if (isInventoryFull(bot)) {
        await returnHomeAndDeposit(bot, [], KEEP_AMOUNTS)
      }

      // 3. Equipar hacha si existe (si no, talará con la mano vacía)
      const hasAxe = await equipBestTool(bot, AXES)
      if (!hasAxe) {
        setIssue(bot, 'tool', 'warn', 'Sin hacha: tala a mano, mucho más lento')
        console.log('[Leñador] ✊ Sin hacha en inventario. Talando con las manos...')
      } else clearIssue(bot, 'tool')

      // 4. Buscar árbol cercano
      const logIds = LOG_TYPES.map(n => mcData.blocksByName[n]?.id).filter(Boolean)
      const logBlock = bot.findBlock({
        matching: logIds,
        maxDistance: cfg.search.woodRadius,
        useExtraInfo: (block) => !isBad(bot, block.position) && !inStuckZone(bot, block.position) && isBottomLog(bot, block),
      })
      bot.currentTarget = logBlock ? logBlock.position : null // si se atasca yendo, se descarta

      if (!logBlock) {
        // Tras un rescate o al volver de guardar puede estar lejos del bosque donde talaba: volver allí
        // con /tp en vez de explorar a ciegas desde casa (alrededor de casa ya no suele quedar nada)
        if (bot.lastForest && bot.entity.position.distanceTo(bot.lastForest) > cfg.search.woodRadius) {
          const forest = bot.lastForest
          bot.lastForest = null // si allí tampoco hay árboles, explorar desde ese punto
          console.log(`[Leñador] 🧭 Aquí no hay árboles: vuelvo al último bosque ${fmtPos(forest)}...`)
          if (await teleportTo(bot, forest)) continue
        }
        console.log('[Leñador] 🌲 No hay árboles cerca. Explorando...')
        await explore(bot, 32)
        await sleep(500)
        continue
      }

      console.log(`[Leñador] 🌲 Árbol en ${fmtPos(logBlock.position)} — acercándome...`)

      // 5. Ir de forma segura hasta el árbol
      const reached = await safeGoto(bot, new GoalNear(logBlock.position.x, logBlock.position.y, logBlock.position.z, 2), 15)
      if (!reached) {
        console.log('[Leñador] ⚠️ No pude alcanzar este árbol, buscando otro...')
        markBad(bot, logBlock.position)
        await sleep(2000)
        continue
      }

      // 6. Talar el árbol completo de abajo hacia arriba
      const cut = await fellTree(bot, mcData, logBlock)
      if (cut === 0) {
        markBad(bot, logBlock.position)
        continue
      }
      treesCut++
      bot.lastForest = logBlock.position.clone()
      stats.add('woodcutter', 'arboles')

      // 7. Replantar brote
      await tryReplant(bot, logBlock)

      // 8. Recoger drops del suelo (madera, brotes, manzanas)
      await sleep(1000)
      await collectNearbyItems(bot, 10)

      await sleep(1500)
    } catch (err) {
      console.warn(`[Leñador] ⚠️ ${err.message}`)
      await sleep(3000)
    }
  }
}

// ── Talar tronco hacia arriba ────────────────────────────────
// Tras cortar la base se coloca en el hueco del tronco para alcanzar los troncos altos
async function fellTree(bot, mcData, baseBlock) {
  const logIds = LOG_TYPES.map(n => mcData.blocksByName[n]?.id).filter(Boolean)
  const basePos = baseBlock.position.clone()
  let pos = basePos.clone()
  let count = 0
  let movedUnder = false

  while (count < 12 && !bot.stopped) {
    const block = bot.blockAt(pos)
    if (!block || !logIds.includes(block.type)) break

    if (!inReach(bot, block)) {
      if (movedUnder || count === 0) break
      movedUnder = true
      await safeGoto(bot, new GoalBlock(basePos.x, basePos.y, basePos.z), 8)
      if (!inReach(bot, block)) {
        console.log(`[Leñador] ↕️ Tronco fuera de alcance en ${fmtPos(pos)}, dejo el árbol.`)
        break
      }
    }

    try {
      await equipBestTool(bot, AXES)
      await bot.dig(block)
      count++
      await sleep(100)
    } catch (err) {
      console.warn(`[Leñador] No se pudo picar bloque: ${err.message}`)
      break
    }
    pos = pos.offset(0, 1, 0)
  }

  if (count > 0) {
    console.log(`[Leñador] ✅ Talados ${count} troncos`)
  }
  return count
}

// ── Verificar que es la base de un árbol en tierra natural ───
function isBottomLog(bot, block) {
  const below = bot.blockAt(block.position.offset(0, -1, 0))
  if (!below) return false
  return ['grass_block', 'dirt', 'podzol', 'mycelium', 'rooted_dirt',
          'moss_block', 'mud', 'coarse_dirt'].includes(below.name)
}

// ── Replantar plántula en la misma base ──────────────────────
async function tryReplant(bot, baseBlock) {
  const saplingName = SAPLING_MAP[baseBlock.name]
  if (!saplingName) return

  const sapling = bot.inventory.items().find(i => i.name === saplingName)
  if (!sapling) return

  try {
    const soilBlock = bot.blockAt(baseBlock.position.offset(0, -1, 0))
    if (!soilBlock) return
    await bot.equip(sapling, 'hand')
    await bot.placeBlock(soilBlock, new Vec3(0, 1, 0))
    console.log(`[Leñador] 🌱 Replantado: ${saplingName}`)
  } catch {}
}

module.exports = { createBot }

// Ejecutado directamente (node bots/woodcutter.js) arranca solo; desde el panel lo controla panel.js
if (require.main === module) createBot()
