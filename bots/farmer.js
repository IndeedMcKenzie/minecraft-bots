// ============================================================
//  bots/farmer.js — Bot Granjero Totalmente Autónomo
// ============================================================
const mineflayer = require('mineflayer')
const { pathfinder, goals: { GoalNear } } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const cfg = require('../config')
const stats = require('./stats')
const { botOptions, setupBot, safeGoto, equipBestTool, returnHomeAndDeposit, runPendingCommand, reachHome, teleportTo, idleSleep, serverFindBlocks, getZone, goToZone, isInventoryFull, withdrawToolsFromChest, collectNearbyItems, markBad, isBad, sleep, fmtPos, giveItem, inReach, waitUntil, HOLLOW_BLOCKS } = require('./common')
const { fetchFromWarehouse } = require('./warehouse')
const inventory = require('./inventory')

// La granja está alrededor de casa o, si se eligió en el mapa del panel, de su zona de trabajo (con su radio):
// todas las búsquedas parten de ahí (si no, el bot "deriva" y no vuelve). Se leen en cada uso.
const FARM_RADIUS = () => { const z = getZone('farmer'); return z ? z.radius : (cfg.search.farmRadius || 32) }
function farmCenter(bot) {
  const z = getZone('farmer')
  return z ? z.pos : (bot.home || bot.entity.position.floored())
}

const HOES = ['netherite_hoe', 'diamond_hoe', 'iron_hoe', 'golden_hoe', 'stone_hoe', 'wooden_hoe']
const SEED_NAMES = ['wheat_seeds', 'carrot', 'potato', 'beetroot_seeds']

// Lo que el granjero se queda al guardar: semillas para replantar y 1 azada de cada tipo
const SEED_RESERVE = { wheat_seeds: 32, carrot: 16, potato: 16, beetroot_seeds: 16 }

// ── Compostera ──
// Las semillas que sobran (trigo y remolacha, por encima de la reserva) van a una compostera junto a casa: cada una
// tiene un 30 % de subir un nivel y con 7 niveles sale 1 harina de huesos (unas 23 semillas por harina). La harina
// hace crecer al momento los cultivos poco crecidos (2–5 etapas de golpe): más cosecha, y las semillas ya no llenan
// el almacén (el 09/10 había 15.429 en 16 cofres; el Granjero se las va trayendo para compostarlas).
const COMPOSTABLE = ['wheat_seeds', 'beetroot_seeds']
const FETCH_SEEDS_MAX = 640              // semillas que se trae del almacén de una vez (10 pilas)
// Semillas sobrantes que se queda para compostar; lo que pase, a casa. Cabe una tanda del almacén entera más lo que
// junte cosechando (si no, devolvería a casa parte de lo que acaba de traer)
const COMPOST_BUFFER = FETCH_SEEDS_MAX + 128
const COMPOST_PER_ROUND = 192            // semillas como mucho por vuelta, para no dejar de cosechar mucho rato
const BONE_MEAL_PER_ROUND = 32           // harinas como mucho por vuelta
const BONE_MEAL_KEEP = 128               // harina que se queda sin usar (la que pase, a casa)
const FETCH_SEEDS_EVERY_MS = 10 * 60 * 1000
const compostOn = () => !cfg.farm || cfg.farm.compost !== false // se puede apagar en la pestaña ⚙️ Ajustes

const KEEP_AMOUNTS = {
  ...SEED_RESERVE,
  ...Object.fromEntries(COMPOSTABLE.map(n => [n, (SEED_RESERVE[n] || 0) + COMPOST_BUFFER])),
  bone_meal: BONE_MEAL_KEEP,
  composter: 1,
  ...Object.fromEntries(HOES.map(h => [h, 1])),
}

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

      // Si ha caído dentro de un bloque hueco (compostera, caldero) el pathfinder no sabe sacarlo: a casa con /tp
      const feetBlock = bot.blockAt(bot.entity.position.floored())
      if (feetBlock && HOLLOW_BLOCKS.includes(feetBlock.name) && bot.home) {
        console.warn(`[Granjero] 🕳️ Me he caído dentro de ${feetBlock.name.replace(/_/g, ' ')} ${fmtPos(feetBlock.position)}: salgo con /tp a casa.`)
        await teleportTo(bot, bot.home)
        continue
      }

      // Si se ha alejado de la granja (persiguiendo hierba, objetos…), volver antes de nada: a su zona si tiene,
      // si no a casa
      if (await goToZone(bot)) continue
      if (!getZone('farmer') && bot.home && bot.entity.position.distanceTo(bot.home) > FARM_RADIUS() + 8) {
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

      // Compostera: la harina de huesos hace crecer los cultivos; sin nada más que hacer, compostar las semillas
      // que sobran (y traerse las del almacén)
      if (compostOn()) {
        work += await useBoneMeal(bot)
        if (work === 0) {
          await fetchSeedsFromWarehouse(bot)
          work += await compostSurplus(bot)
        }
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

// ════════════════════════════════════════════════════════════
//  COMPOSTERA Y HARINA DE HUESOS
// ════════════════════════════════════════════════════════════
const countItem = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((a, i) => a + i.count, 0)
const seedSurplus = (bot, name) => Math.max(0, countItem(bot, name) - (SEED_RESERVE[name] || 0))
const totalSurplus = bot => COMPOSTABLE.reduce((a, n) => a + seedSurplus(bot, n), 0)

function findComposter(bot) {
  const id = bot.registry.blocksByName.composter && bot.registry.blocksByName.composter.id
  if (id === undefined || !bot.home) return null
  return bot.findBlock({ matching: id, point: bot.home, maxDistance: 8 })
}

// Hueco para la compostera: cerca del cofre de casa pero sin pegarse a ningún cofre (ahí van los cofres nuevos), sobre
// suelo firme que no sea tierra arada (no quita sitio a los cultivos) y con aire encima para poder usarla
function composterSpots(bot) {
  const h = bot.home
  const spots = []
  const isChest = p => { const b = bot.blockAt(p); return !!b && /chest/.test(b.name) }
  for (let dx = -4; dx <= 4; dx++) {
    for (let dz = -4; dz <= 4; dz++) {
      for (const dy of [0, -1, 1]) {
        const p = h.offset(dx, dy, dz)
        const b = bot.blockAt(p), above = bot.blockAt(p.offset(0, 1, 0)), below = bot.blockAt(p.offset(0, -1, 0))
        if (!b || !above || !below) continue
        if (!isAir(b) || !isAir(above) || below.boundingBox !== 'block') continue
        if (/chest|farmland|composter|furnace|leaves|water|lava/.test(below.name)) continue
        if ([[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]].some(([x, z]) => isChest(p.offset(x, 0, z)) || isChest(p.offset(x, -1, z)))) continue
        spots.push({ p, score: Math.abs(dx) + Math.abs(dz) + Math.abs(dy) * 3 + (Math.abs(dx) + Math.abs(dz) < 2 ? 10 : 0) })
        break
      }
    }
  }
  return spots.sort((a, b) => a.score - b.score).map(s => s.p)
}

/** La compostera de casa; si no hay, se da una (sin comando con el plugin) y la coloca. */
async function ensureComposter(bot) {
  // Justo al conectarse (p. ej. tras reiniciar el servidor) la zona de casa puede no estar cargada todavía: no
  // concluir que no hay compostera hasta verla (si no, pondría otra o se daría por vencido 10 minutos)
  if (!bot.home || bot.blockAt(bot.home) === null) return null
  const found = findComposter(bot)
  if (found) return found
  if (bot._composterTryAt && Date.now() - bot._composterTryAt < 10 * 60 * 1000) return null
  bot._composterTryAt = Date.now()
  if (countItem(bot, 'composter') === 0) {
    await giveItem(bot, 'composter', 1)
    await waitUntil(() => countItem(bot, 'composter') > 0, 3000)
  }
  if (countItem(bot, 'composter') === 0) {
    console.warn('[Granjero] ♻️ No pude conseguir una compostera (¿soy OP o está el plugin BotHelper?).')
    return null
  }
  for (const spot of composterSpots(bot).slice(0, 6)) {
    const ground = bot.blockAt(spot.offset(0, -1, 0))
    if (!inReach(bot, ground)) {
      await safeGoto(bot, new GoalNear(spot.x, spot.y, spot.z, 2), 10)
      if (!inReach(bot, ground)) continue
    }
    const feet = bot.entity.position.floored()
    if (feet.equals(spot) || feet.offset(0, 1, 0).equals(spot)) continue
    try {
      await bot.equip(bot.inventory.items().find(i => i.name === 'composter'), 'hand')
      await bot.placeBlock(ground, new Vec3(0, 1, 0))
    } catch {}
    await sleep(400)
    const placed = findComposter(bot)
    if (placed) {
      console.log(`[Granjero] ♻️ Compostera colocada en ${fmtPos(placed.position)}: ahí irán las semillas que sobren.`)
      return placed
    }
  }
  console.warn(`[Granjero] ♻️ No encontré dónde poner la compostera junto a casa ${fmtPos(bot.home)}.`)
  return null
}

/** Echa en la compostera las semillas que sobran y saca la harina de huesos. Devuelve cuántas semillas echó. */
async function compostSurplus(bot) {
  if (totalSurplus(bot) < 8) return 0
  const composter = await ensureComposter(bot)
  if (!composter) return 0
  if (!inReach(bot, composter)) {
    await safeGoto(bot, new GoalNear(composter.position.x, composter.position.y, composter.position.z, 2), 15)
    if (!inReach(bot, composter)) return 0
  }

  const seedsBefore = COMPOSTABLE.reduce((a, n) => a + countItem(bot, n), 0)
  const mealBefore = countItem(bot, 'bone_meal')
  let tries = 0, waits = 0, lastCheck = seedsBefore
  while (tries < COMPOST_PER_ROUND && totalSurplus(bot) > 0 && !bot.stopped && !bot.pendingCommand) {
    const block = bot.blockAt(composter.position)
    if (!block || block.name !== 'composter') break // la han quitado
    const level = Number((block.getProperties() || {}).level || 0)
    if (level >= 8) { // llena: sacar la harina de huesos (sale despedida hacia arriba)
      try { await bot.activateBlock(block) } catch {}
      waits = 0
      await sleep(300)
      continue
    }
    if (level === 7) { // pasa a "lista" al segundo: esperar (como mucho 3 s por cada llenado)
      if (++waits > 12) break
      await sleep(250)
      continue
    }
    waits = 0
    const seed = bot.inventory.items().find(i => COMPOSTABLE.includes(i.name) && seedSurplus(bot, i.name) > 0)
    if (!seed) break
    try {
      if (!bot.heldItem || bot.heldItem.name !== seed.name) await bot.equip(seed, 'hand')
      await bot.activateBlock(block)
    } catch { break }
    tries++
    await sleep(120)
    // Cada 16 intentos, comprobar que de verdad se gastan semillas (si no, algo va mal: no insistir)
    if (tries % 16 === 0) {
      const now = COMPOSTABLE.reduce((a, n) => a + countItem(bot, n), 0)
      if (now >= lastCheck) {
        console.warn(`[Granjero] ♻️ La compostera ${fmtPos(composter.position)} no acepta las semillas; lo dejo por ahora.`)
        break
      }
      lastCheck = now
    }
  }
  await sleep(600)
  await collectNearbyItems(bot, 5)

  const used = Math.max(0, seedsBefore - COMPOSTABLE.reduce((a, n) => a + countItem(bot, n), 0))
  const meal = Math.max(0, countItem(bot, 'bone_meal') - mealBefore)
  if (used > 0) {
    console.log(`[Granjero] ♻️ Compostadas ${used} semillas${meal ? ` → +${meal} harina de huesos` : ''} (me quedan ${totalSurplus(bot)} de sobra).`)
    stats.add('farmer', 'compostados', used)
    if (meal) stats.add('farmer', 'harinaHuesos', meal)
  }
  return used
}

/**
 * Harina de huesos en los cultivos poco crecidos (hasta 2 etapas antes de madurar: así no se desperdicia, porque la
 * harina sube 2–5 de golpe). La remolacha apenas crece con harina: solo trigo, zanahoria y patata.
 */
async function useBoneMeal(bot) {
  if (countItem(bot, 'bone_meal') === 0) return 0
  const crops = CROPS.filter(c => c.name !== 'beetroots')
  const young = c => b => b && b.name === c.name && Number((b.getProperties() || {}).age) <= c.maxAge - 2
  const remote = await serverFindBlocks(bot, { types: crops.map(c => c.name), center: farmCenter(bot), radius: FARM_RADIUS(), count: 128, immature: true })
  let blocks
  if (remote) {
    blocks = remote.filter(p => !isBad(bot, p)).map(p => bot.blockAt(p)).filter(b => b && crops.some(c => young(c)(b)))
  } else {
    blocks = []
    for (const c of crops) {
      const id = bot.registry.blocksByName[c.name] && bot.registry.blocksByName[c.name].id
      if (id === undefined) continue
      blocks.push(...bot.findBlocks({ matching: id, point: farmCenter(bot), maxDistance: FARM_RADIUS(), count: 64, useExtraInfo: young(c) })
        .filter(p => !isBad(bot, p)).map(p => bot.blockAt(p)).filter(Boolean))
    }
  }
  if (blocks.length === 0) return 0
  const here = bot.entity.position
  blocks.sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))

  let used = 0
  let missed = 0 // inalcanzables seguidos: si son varios, mejor dejarlo para la próxima vuelta (cada intento son 10 s)
  for (const target of blocks) {
    if (used >= BONE_MEAL_PER_ROUND || missed >= 3 || bot.stopped || bot.pendingCommand) break
    const meal = bot.inventory.items().find(i => i.name === 'bone_meal')
    if (!meal) break
    if (!inReach(bot, target)) {
      if (!await safeGoto(bot, new GoalNear(target.position.x, target.position.y, target.position.z, 2), 10)) { markBad(bot, target.position); missed++; continue }
    }
    missed = 0
    try {
      await bot.equip(meal, 'hand')
      const before = countItem(bot, 'bone_meal')
      await bot.activateBlock(bot.blockAt(target.position) || target)
      await sleep(200)
      if (countItem(bot, 'bone_meal') < before) used++
    } catch {
      markBad(bot, target.position)
    }
  }
  if (used > 0) {
    console.log(`[Granjero] 🌿 Harina de huesos en ${used} cultivos (me quedan ${countItem(bot, 'bone_meal')}).`)
    stats.add('farmer', 'abonados', used)
  }
  return used
}

/**
 * Las semillas que se acumularon en el almacén: cuando no le quedan sobrantes, se trae una tanda para compostarlas.
 * Solo si el inventario en vivo del plugin dice que hay (sin plugin no viaja a ciegas), y como mucho cada 10 minutos.
 */
async function fetchSeedsFromWarehouse(bot) {
  if (totalSurplus(bot) >= 64) return
  if (bot._seedFetchAt && Date.now() - bot._seedFetchAt < FETCH_SEEDS_EVERY_MS) return
  bot._seedFetchAt = Date.now()
  if (!inventory.isLive()) return
  // Sin compostera y sin poder colocarla hace poco: no traer semillas que no podrá usar
  if (!findComposter(bot) && bot._composterTryAt && Date.now() - bot._composterTryAt < 10 * 60 * 1000) return
  const stock = inventory.summary().items.filter(i => COMPOSTABLE.includes(i.name)).reduce((a, i) => a + i.count, 0)
  if (stock < 64 || bot.inventory.emptySlotCount() < 14) return
  console.log(`[Granjero] 🏬 Voy al almacén a por semillas para la compostera (hay ${stock}).`)
  const got = await fetchFromWarehouse(bot, [{ test: n => COMPOSTABLE.includes(n), max: FETCH_SEEDS_MAX, cats: ['Cultivos'] }], 'Granjero')
  const n = Object.values(got).reduce((a, b) => a + b, 0)
  if (bot.home) await teleportTo(bot, bot.home)
  console.log(n > 0 ? `[Granjero] 🏬 Traídas ${n} semillas del almacén para compostar.` : '[Granjero] 🏬 No pude sacar semillas del almacén.')
}

// Guarda la cosecha a partir de esta cantidad de excedente (o con el inventario casi lleno). Con 16 iba a casa cada
// minuto y medio (53 viajes en 1,3 h): cada vez abría y cerraba cofres para muy poco
const DEPOSIT_AT = 128

// Guarda la cosecha conservando una reserva de semillas para replantar
async function handleChestStorage(bot) {
  const totals = bot.inventory.items().reduce((acc, i) => {
    acc[i.name] = (acc[i.name] || 0) + i.count
    return acc
  }, {})
  const excess = Object.entries(totals)
    .reduce((acc, [name, count]) => acc + Math.max(0, count - (KEEP_AMOUNTS[name] || 0)), 0)

  if (excess >= DEPOSIT_AT || isInventoryFull(bot)) {
    await returnHomeAndDeposit(bot, [], KEEP_AMOUNTS)
  }
}

module.exports = { createBot }

// Ejecutado directamente (node bots/farmer.js) arranca solo; desde el panel lo controla panel.js
if (require.main === module) createBot()
