// ============================================================
//  bots/farmer.js — Bot Granjero Totalmente Autónomo
// ============================================================
const mineflayer = require('mineflayer')
const { pathfinder, goals: { GoalNear } } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const cfg = require('../config')
const stats = require('./stats')
const { botOptions, setupBot, safeGoto, equipBestTool, returnHomeAndDeposit, runPendingCommand, reachHome, teleportTo, idleSleep, serverFindBlocks, isInventoryFull, withdrawToolsFromChest, collectNearbyItems, markBad, isBad, sleep, fmtPos } = require('./common')

const FARM_RADIUS = () => cfg.search.farmRadius || 32

// La granja está alrededor de casa: todas las búsquedas parten de ahí (si no, el bot "deriva" y no vuelve)
function farmCenter(bot) {
  return bot.home || bot.entity.position.floored()
}

const HOES = ['netherite_hoe', 'diamond_hoe', 'iron_hoe', 'golden_hoe', 'stone_hoe', 'wooden_hoe']
const SEED_NAMES = ['wheat_seeds', 'carrot', 'potato', 'beetroot_seeds']

// Lo que el granjero se queda al guardar: semillas para replantar y 1 azada de cada tipo
const SEED_RESERVE = { wheat_seeds: 32, carrot: 16, potato: 16, beetroot_seeds: 16 }
const KEEP_AMOUNTS = { ...SEED_RESERVE, ...Object.fromEntries(HOES.map(h => [h, 1])) }

const CROPS = [
  { name: 'wheat',     maxAge: 7, seed: 'wheat_seeds'    },
  { name: 'carrots',   maxAge: 7, seed: 'carrot'         },
  { name: 'potatoes',  maxAge: 7, seed: 'potato'         },
  { name: 'beetroots', maxAge: 3, seed: 'beetroot_seeds' },
]

const IDLE_WAIT_MS = 20 * 1000 // espera entre vueltas cuando no hubo nada que cosechar, plantar ni arar

// Solo la hierba suelta semillas de trigo (el helecho no)
const GRASS_BLOCKS = ['short_grass', 'tall_grass', 'grass']

function isAir(block) {
  return !!block && (block.name === 'air' || block.name === 'cave_air')
}

function createBot(ctrl = {}) {
  const bot = mineflayer.createBot(botOptions('farmer'))

  bot.loadPlugin(pathfinder)

  setupBot(bot, 'Granjero', () => createBot(ctrl), 'farmer', ctrl)

  bot.once('spawn', () => {
    console.log(`[${cfg.bots.farmer.username}] 🌾 Conectado e iniciando granja...`)
    setTimeout(() => workLoop(bot), 3000)
  })

  return bot
}

async function workLoop(bot) {
  bot.depositRules = { keep: [], amounts: KEEP_AMOUNTS }

  while (!bot.stopped) {
    try {
      // Órdenes del panel (p. ej. volver a casa)
      if (await runPendingCommand(bot)) continue

      const mcData = bot.registry

      // Si se ha alejado de la granja (persiguiendo hierba, objetos…), volver antes de nada
      if (bot.home && bot.entity.position.distanceTo(bot.home) > FARM_RADIUS() + 8) {
        console.log(`[Granjero] 🧭 Estoy lejos de la granja (${Math.round(bot.entity.position.distanceTo(bot.home))} bloques). Volviendo...`)
        if (!await reachHome(bot)) { await sleep(30000); continue }
      }

      await withdrawToolsFromChest(bot, HOES)
      await handleChestStorage(bot)

      let seedsCount = getSeedsCount(bot)
      if (seedsCount === 0) {
        console.log('[Granjero] 🌾 Sin semillas. Buscando hierba...')
        await gatherSeedsFromGrass(bot, mcData)
        seedsCount = getSeedsCount(bot)
      }

      let work = await harvestMatureCrops(bot, mcData)

      if (seedsCount > 0) {
        work += await plantEmptyFarmland(bot, mcData)
      }

      if (seedsCount > 0 && cfg.farm && cfg.farm.autoCreate) {
        if (await expandFarmNearWater(bot, mcData)) work++
      }

      await collectNearbyItems(bot, 8)
      // Los cultivos tardan minutos en crecer: si no había nada que hacer, no revisar cada 4 s (ahorra CPU)
      await (work > 0 ? sleep(4000) : idleSleep(bot, IDLE_WAIT_MS))
    } catch (err) {
      console.warn(`[Granjero] ⚠️ Bucle principal: ${err.message}`)
      await sleep(5000)
    }
  }
}

function getSeedsCount(bot) {
  return bot.inventory.items().filter(i => SEED_NAMES.includes(i.name)).reduce((acc, i) => acc + i.count, 0)
}

async function gatherSeedsFromGrass(bot, mcData) {
  const grassIds = GRASS_BLOCKS.map(n => mcData.blocksByName[n]?.id).filter(Boolean)
  if (grassIds.length === 0) return

  let attempts = 0
  while (attempts < 10 && getSeedsCount(bot) < 5 && !bot.stopped) {
    attempts++
    // matching solo recibe el tipo de bloque (sin posición); la lista negra va en useExtraInfo
    const grassPos = bot.findBlocks({
      matching: grassIds,
      point: farmCenter(bot),
      maxDistance: FARM_RADIUS(),
      count: 32,
    }).find(p => !isBad(bot, p))
    const grassBlock = grassPos && bot.blockAt(grassPos)

    if (!grassBlock) break

    const reached = await safeGoto(bot, new GoalNear(grassBlock.position.x, grassBlock.position.y, grassBlock.position.z, 1), 10)
    if (!reached) {
      markBad(bot, grassBlock.position)
      continue
    }

    try {
      await bot.dig(grassBlock)
      await sleep(300)
      await collectNearbyItems(bot, 4)
    } catch {
      markBad(bot, grassBlock.position)
    }
  }

  const found = getSeedsCount(bot)
  if (found > 0) console.log(`[Granjero] 🌾 Tengo ${found} semillas.`)
}

async function harvestMatureCrops(bot, mcData) {
  let harvested = 0
  let unreachable = 0
  let missedInARow = 0
  // Una sola búsqueda en el servidor para todos los cultivos (null: sin plugin, cada cultivo se busca en local)
  const remote = await serverFindBlocks(bot, { types: CROPS.map(c => c.name), center: farmCenter(bot), radius: FARM_RADIUS(), count: 256, mature: true })
  for (const crop of CROPS) {
    const matureBlocks = findMatureCrops(bot, mcData, crop, remote)
    for (const block of matureBlocks) {
      if (bot.stopped) return harvested
      const reached = await safeGoto(bot, new GoalNear(block.position.x, block.position.y, block.position.z, 1), 10)
      if (!reached) {
        markBad(bot, block.position)
        unreachable++
        // Varios seguidos sin poder llegar: probablemente se ha caído fuera de la granja (p. ej. colina abajo).
        // Volver a casa con /tp y reintentarlos desde allí, en vez de pasar minutos intentándolo uno a uno
        if (++missedInARow >= 3 && bot.home && bot.entity.position.distanceTo(bot.home) > 6) {
          console.log(`[Granjero] 🌀 No llego a los cultivos desde ${fmtPos(bot.entity.position)}: vuelvo a casa con /tp.`)
          for (const b of matureBlocks) bot.badBlocks.delete(b.position.toString())
          await teleportTo(bot, bot.home)
          return harvested
        }
        continue
      }
      missedInARow = 0

      try {
        await bot.dig(block)
        harvested++
        await sleep(250)
        await tryReplant(bot, block, crop)
      } catch (err) {
        markBad(bot, block.position)
      }
    }
  }
  if (unreachable > 0) console.warn(`[Granjero] ⚠️ ${unreachable} cultivos maduros inalcanzables (los dejo un rato).`)
  if (harvested > 0) {
    console.log(`[Granjero] ✅ Cosechados ${harvested} cultivos.`)
    stats.add('farmer', 'cosechas', harvested)
    await collectNearbyItems(bot, 8)
  }
  return harvested
}

// stateIds de cada cultivo en su edad máxima. Buscar por stateId deja que mineflayer descarte
// secciones enteras mirando solo su paleta, en vez de leer bloque a bloque con sus propiedades
// (antes esto era ~28% de la CPU de todo el proceso).
const matureStateCache = new Map()
function matureStateIds(bot, crop) {
  if (matureStateCache.has(crop.name)) return matureStateCache.get(crop.name)
  const Block = require('prismarine-block')(bot.registry)
  const blockType = bot.registry.blocksByName[crop.name]
  const ids = new Set()
  if (blockType) {
    for (let s = blockType.minStateId; s <= blockType.maxStateId; s++) {
      const props = Block.fromStateId(s, 0).getProperties()
      if (parseInt(props.age) >= crop.maxAge) ids.add(s)
    }
  }
  matureStateCache.set(crop.name, ids)
  return ids
}

// remote: posiciones de cultivos maduros de todos los tipos que ya buscó el servidor (null: buscar aquí)
function findMatureCrops(bot, mcData, crop, remote) {
  const ids = matureStateIds(bot, crop)
  if (ids.size === 0) return []

  // Del servidor (plugin) se quedan los de este cultivo (el estado lo comprueba ids); si no está, el bot como siempre
  if (remote) return remote.filter(p => !isBad(bot, p)).map(p => bot.blockAt(p)).filter(b => b && ids.has(b.stateId)).slice(0, 64)

  // Buscar por TIPO de bloque deja que mineflayer descarte secciones enteras mirando solo su paleta; la edad
  // se comprueba después solo en los cultivos encontrados. (Con una función en 'matching' se construía un
  // objeto por cada bloque del radio — cientos de miles — y bloqueaba a todos los bots varios segundos.)
  const typeId = bot.registry.blocksByName[crop.name] && bot.registry.blocksByName[crop.name].id
  if (typeId === undefined) return []
  const positions = bot.findBlocks({
    matching: typeId,
    useExtraInfo: (block) => ids.has(block.stateId),
    point: farmCenter(bot),
    maxDistance: FARM_RADIUS(),
    count: 64,
  })
  return positions.filter(p => !isBad(bot, p)).map(p => bot.blockAt(p)).filter(Boolean)
}

async function tryReplant(bot, block, crop) {
  const seedItem = bot.inventory.items().find(i => i.name === crop.seed)
  if (!seedItem) return

  const farmland = bot.blockAt(block.position.offset(0, -1, 0))
  if (!farmland || farmland.name !== 'farmland') return

  try {
    await bot.equip(seedItem, 'hand')
    await bot.placeBlock(farmland, new Vec3(0, 1, 0))
  } catch {}
}

async function plantEmptyFarmland(bot, mcData) {
  const farmlandId = mcData.blocksByName.farmland?.id
  if (!farmlandId) return 0

  // Búsqueda barata (solo por tipo) y luego se filtran las parcelas vacías; así las plantadas
  // no ocupan los 10 huecos y no se lee cada bloque de la zona con todas sus propiedades
  const emptyFarmlands = bot.findBlocks({
    matching: farmlandId,
    point: farmCenter(bot),
    maxDistance: FARM_RADIUS(),
    count: 400,
  })
    .filter(p => !isBad(bot, p) && isAir(bot.blockAt(p.offset(0, 1, 0))))
    .slice(0, 10)

  let planted = 0
  for (const pos of emptyFarmlands) {
    if (bot.stopped) return planted
    const seedItem = bot.inventory.items().find(i => SEED_NAMES.includes(i.name))
    if (!seedItem) break

    const reached = await safeGoto(bot, new GoalNear(pos.x, pos.y, pos.z, 1), 10)
    if (!reached) {
      markBad(bot, pos)
      continue
    }

    try {
      const farmlandBlock = bot.blockAt(pos)
      await bot.equip(seedItem, 'hand')
      await bot.placeBlock(farmlandBlock, new Vec3(0, 1, 0))
      console.log(`[Granjero] 🌱 Sembrado ${seedItem.name} en ${fmtPos(pos)}`)
      planted++
      stats.add('farmer', 'siembras')
      await sleep(250)
    } catch {
      markBad(bot, pos)
    }
  }
  return planted
}

// Devuelve true si aró una parcela nueva
async function expandFarmNearWater(bot, mcData) {
  const hasHoe = await equipBestTool(bot, HOES)
  if (!hasHoe) return false

  const waterId = mcData.blocksByName.water?.id
  if (!waterId) return false

  // Búsqueda barata por tipo y filtro después (el agua abunda: leer cada bloque con extras era caro)
  const waterPos = bot.findBlocks({
    matching: waterId,
    point: farmCenter(bot),
    maxDistance: (cfg.farm && cfg.farm.searchWaterRadius) || 32,
    count: 64,
  }).find(p => !isBad(bot, p))
  const waterBlock = waterPos && bot.blockAt(waterPos)
  if (!waterBlock) return false

  const soilTypes = ['grass_block', 'dirt']
  const soilIds = soilTypes.map(n => mcData.blocksByName[n]?.id).filter(Boolean)
  const wPos = waterBlock.position

  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      if (dx === 0 && dz === 0) continue
      const targetPos = wPos.offset(dx, 0, dz)
      if (isBad(bot, targetPos)) continue

      const block = bot.blockAt(targetPos)
      const above = bot.blockAt(targetPos.offset(0, 1, 0))

      if (block && soilIds.includes(block.type) && isAir(above)) {
        const reached = await safeGoto(bot, new GoalNear(targetPos.x, targetPos.y, targetPos.z, 1), 12)
        if (!reached) { markBad(bot, targetPos); continue }

        try {
          await equipBestTool(bot, HOES)
          await bot.activateBlock(block, new Vec3(0, 1, 0))
          await sleep(350)

          const freshFarmland = bot.blockAt(targetPos)
          if (!freshFarmland || freshFarmland.name !== 'farmland') {
            markBad(bot, targetPos)
            continue
          }
          console.log(`[Granjero] 🚜 Arada nueva tierra en ${fmtPos(targetPos)}`)

          const seedItem = bot.inventory.items().find(i => SEED_NAMES.includes(i.name))
          if (seedItem) {
            await bot.equip(seedItem, 'hand')
            await bot.placeBlock(freshFarmland, new Vec3(0, 1, 0))
          }
          return true
        } catch {
          markBad(bot, targetPos)
        }
      }
    }
  }
  // No queda tierra arable alrededor de este agua: probar con otra la próxima vez
  markBad(bot, wPos)
  return false
}

// Guarda la cosecha conservando una reserva de semillas para replantar
async function handleChestStorage(bot) {
  const totals = bot.inventory.items().reduce((acc, i) => {
    acc[i.name] = (acc[i.name] || 0) + i.count
    return acc
  }, {})
  const excess = Object.entries(totals)
    .reduce((acc, [name, count]) => acc + Math.max(0, count - (KEEP_AMOUNTS[name] || 0)), 0)

  // La granja suele estar junto a casa, así que guarda en cuanto junta algo de cosecha
  if (excess >= 16 || isInventoryFull(bot)) {
    await returnHomeAndDeposit(bot, [], KEEP_AMOUNTS)
  }
}

module.exports = { createBot }

// Ejecutado directamente (node bots/farmer.js) arranca solo; desde el panel lo controla panel.js
if (require.main === module) createBot()
