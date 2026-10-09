// ============================================================
//  bots/artisan.js — Bot Artesano (fundidor, cocinero y herrero)
//  Trabaja en un taller junto al almacén:
//  · Herramientas (prioridad): cada cierto tiempo revisa que cada
//    bot tenga una herramienta de repuesto en su casa; si falta,
//    saca materiales del almacén, la fabrica en una mesa de trabajo
//    y se la lleva con /tp.
//  · Hornos: coloca una fila de hornos, saca del almacén minerales
//    en bruto y comida cruda (y carbón o madera como combustible),
//    funde y cocina, y guarda lo producido en su cofre; el
//    organizador lo lleva al almacén.
// ============================================================
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder, goals: { GoalNear } } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const cfg = require('../config')
const stats = require('./stats')
const {
  botOptions,
  setupBot,
  safeGoto,
  inReach,
  teleportTo,
  waitUntil,
  depositNoMerge,
  returnHomeAndDeposit,
  runPendingCommand,
  setIssue,
  idleSleep,
  giveItem,
  openWithTimeout,
  clearIssue,
  sleep,
  fmtPos,
} = require('./common')
const { fetchFromWarehouse } = require('./warehouse')

const TAG = '[Artesano]'

// ── Configuración (secciones smelter y smith de config.js) ──
const sCfg = Object.assign({
  furnaces: 4,
  cycleSeconds: 30,
  batchPerFurnace: 64,
  smelt: ['raw_iron', 'raw_gold', 'raw_copper', 'beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato'],
  fuels: ['coal', 'charcoal', '*_log', '*_planks'],
}, cfg.smelter)

const smCfg = Object.assign({
  checkMinutes: 10,
  sparesPerBot: 1,
  tools: { woodcutter: 'axe', miner: 'pickaxe', farmer: 'hoe', fisher: 'fishing_rod' },
  tiers: ['diamond', 'iron', 'stone'],
}, cfg.smith)

// "*_log" → /^.*_log$/
const wildcard = p => new RegExp('^' + p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
const FUEL_RULES = sCfg.fuels.map(wildcard)
const isFuel = name => FUEL_RULES.some(r => r.test(name))
const isInput = name => sCfg.smelt.includes(name)
// Objetos que funde una unidad de combustible
const fuelValue = name => (name === 'coal' || name === 'charcoal') ? 8 : 1.5

const HOME_CHEST_RADIUS = (cfg.home && cfg.home.chestRadius) || 6
const LABELS = { woodcutter: 'Leñador', miner: 'Minero', farmer: 'Granjero', fisher: 'Pescador', organizer: 'Organizador' }

// Material por nivel (nombres de objeto) y categoría del almacén donde buscarlo
const TIER_MATERIAL = {
  diamond: { names: ['diamond'], cats: ['Minerales'] },
  iron: { names: ['iron_ingot'], cats: ['Minerales'] },
  stone: { names: ['cobblestone', 'cobbled_deepslate', 'blackstone'], cats: ['Piedra'] },
}
// Material y palos que lleva cada herramienta
const RECIPE_NEEDS = { pickaxe: { mat: 3, sticks: 2 }, axe: { mat: 3, sticks: 2 }, hoe: { mat: 2, sticks: 2 }, sword: { mat: 2, sticks: 1 }, shovel: { mat: 1, sticks: 2 } }

const CRAFT_ATTEMPTS = 3 // intentos de crafteo antes de recurrir a /give

const isToolOf = family => name => family === 'fishing_rod' ? name === 'fishing_rod' : name.endsWith(`_${family}`)
const countOf = (bot, test) => bot.inventory.items().filter(i => test(i.name)).reduce((a, i) => a + i.count, 0)

// Al guardar en su cofre se queda lo pendiente de meter en los hornos, el combustible y sus bloques de taller
const keepNames = bot => bot.inventory.items().map(i => i.name)
  .filter(n => isInput(n) || isFuel(n) || n === 'furnace' || n === 'crafting_table')

function createBot(ctrl = {}) {
  const bot = mineflayer.createBot(botOptions('artisan'))

  bot.loadPlugin(pathfinder)

  setupBot(bot, 'Artesano', () => createBot(ctrl), 'artisan', ctrl)

  bot.once('spawn', () => {
    console.log(`[${cfg.bots.artisan.username}] 🛠️ Conectado. Hornos y herramientas en marcha...`)
    setTimeout(() => workLoop(bot), 3000)
  })

  return bot
}

async function workLoop(bot) {
  let nextToolCheck = Date.now() + 20000
  let lastNoHomeMsg = 0
  bot.depositRules = { keep: [], amounts: {} }

  while (!bot.stopped) {
    try {
      if (await runPendingCommand(bot)) continue

      if (!bot.home) {
        if (Date.now() - lastNoHomeMsg > 60000) {
          console.log(`${TAG} 🏠 Sin taller. Pon un cofre cerca del almacén (con sitio al norte para los hornos), hazme TP al lado y usa "!casa artesano".`)
          lastNoHomeMsg = Date.now()
        }
        await sleep(10000)
        continue
      }
      if (bot.entity.position.distanceTo(bot.home) > 12) await teleportTo(bot, bot.home)

      // 1. Herramientas primero: a un bot sin repuesto le corre más prisa que a los hornos
      if (Date.now() >= nextToolCheck) {
        await checkAndCraft(bot)
        nextToolCheck = Date.now() + smCfg.checkMinutes * 60 * 1000
        if (bot.entity.position.distanceTo(bot.home) > 12) await teleportTo(bot, bot.home)
      }

      // 2. Hornos (siguen trabajando solos mientras tanto)
      await furnaceCycle(bot)

      await idleSleep(bot, sCfg.cycleSeconds * 1000)
    } catch (err) {
      console.warn(`${TAG} ⚠️ ${err.message}`)
      await sleep(5000)
    }
  }
}

// Guarda en su cofre lo producido o lo que sobró, quedándose con lo que aún necesita
async function storeOutputs(bot) {
  const keep = keepNames(bot)
  bot.depositRules = { keep, amounts: {} }
  if (bot.inventory.items().some(i => !keep.includes(i.name))) await returnHomeAndDeposit(bot, keep, {})
}

// ════════════════════════════════════════════════════════════
//  HORNOS
// ════════════════════════════════════════════════════════════
async function furnaceCycle(bot) {
  const furnaces = await ensureFurnaces(bot)
  if (furnaces.length === 0) return

  // Recoger lo terminado y ver qué hornos están libres o parados sin combustible
  const idle = [], noFuel = []
  let unfueledItems = 0
  for (const f of furnaces) {
    const state = await serviceFurnace(bot, f)
    if (state === 'idle') idle.push(f)
    else if (state && state.noFuel) { noFuel.push(f); unfueledItems += state.noFuel }
  }

  await storeOutputs(bot)

  // Hornos con material pero sin combustible: traerlo del almacén y reponerlo
  if (noFuel.length > 0) {
    await ensureFuel(bot, unfueledItems)
    if (bot.entity.position.distanceTo(bot.home) > 12) await teleportTo(bot, bot.home)
    for (const f of noFuel) await serviceFurnace(bot, f)
  }

  // Cargar los hornos libres (trayendo material del almacén si hace falta)
  if (idle.length > 0) {
    if (!bot.inventory.items().some(i => isInput(i.name))) await fetchSmeltables(bot, idle.length)
    if (bot.inventory.items().some(i => isInput(i.name))) {
      // Puede tener material de antes en el inventario pero no combustible: que no cargue hornos que no arden
      await ensureFuel(bot, Math.min(countOf(bot, isInput), idle.length * sCfg.batchPerFurnace))
      if (bot.entity.position.distanceTo(bot.home) > 12) await teleportTo(bot, bot.home)
      for (const f of idle) await loadFurnace(bot, f)
    }
  }
}

const fuelUnits = bot => bot.inventory.items().filter(i => isFuel(i.name)).reduce((a, i) => a + i.count * fuelValue(i.name), 0)

/** Trae del almacén combustible para fundir `items` objetos: carbón primero; si no llega, madera. */
async function ensureFuel(bot, items) {
  if (fuelUnits(bot) >= items) { clearIssue(bot, 'fuel'); return }
  await fetchFromWarehouse(bot, [
    { test: n => n === 'coal' || n === 'charcoal', max: Math.ceil((items - fuelUnits(bot)) / 8), cats: ['Minerales', 'Varios'] },
  ], 'Artesano')
  if (fuelUnits(bot) < items) {
    await fetchFromWarehouse(bot, [
      { test: n => /_log$|_planks$/.test(n), max: Math.ceil((items - fuelUnits(bot)) / 1.5), cats: ['Madera'] },
    ], 'Artesano')
  }
  if (fuelUnits(bot) < items) {
    setIssue(bot, 'fuel', 'err', 'Sin combustible en el almacén (carbón o madera): los hornos se paran')
    console.warn(`${TAG} ⚠️ No queda combustible suficiente en el almacén (carbón o madera).`)
  } else clearIssue(bot, 'fuel')
}

function findFurnaces(bot) {
  const id = bot.registry.blocksByName.furnace.id
  return bot.findBlocks({ matching: id, point: bot.home, maxDistance: 5, count: 20 })
    .map(p => bot.blockAt(p)).filter(Boolean)
}

/** Se asegura de que haya sCfg.furnaces hornos junto a casa (los coloca con /give si faltan). */
async function ensureFurnaces(bot) {
  let furnaces = findFurnaces(bot)
  const missing = sCfg.furnaces - furnaces.length
  if (missing <= 0) return furnaces
  // Tras colocar, el servidor tarda un poco en confirmar los bloques: no reintentar enseguida
  // (si no, contaría de menos y pondría hornos de más)
  if (bot.lastFurnacePlacing && Date.now() - bot.lastFurnacePlacing < 5 * 60 * 1000) return furnaces
  bot.lastFurnacePlacing = Date.now()

  if (!await giveSelf(bot, 'furnace', missing)) return furnaces
  for (const spot of furnaceSpots(bot).slice(0, missing * 3)) {
    if (findFurnaces(bot).length >= sCfg.furnaces || bot.stopped) break
    if (await placeBlockAt(bot, spot, 'furnace')) await sleep(200)
  }
  await sleep(1500) // dejar que lleguen las confirmaciones de los bloques colocados
  furnaces = findFurnaces(bot)
  console.log(`${TAG} 🔥 Hornos listos: ${furnaces.length}/${sCfg.furnaces}.`)
  return furnaces
}

// Huecos para hornos: una fila a 2 bloques al norte del cofre de casa (y alrededores si no hay sitio)
function furnaceSpots(bot) {
  const h = bot.home
  const spots = []
  for (let dz = -2; dz >= -4; dz--) {
    for (let dx = -3; dx <= 3; dx++) {
      for (const dy of [0, 1, -1]) {
        const p = h.offset(dx, dy, dz)
        const b = bot.blockAt(p), above = bot.blockAt(p.offset(0, 1, 0)), below = bot.blockAt(p.offset(0, -1, 0))
        if (!b || !above || !below) continue
        if (b.name !== 'air' || above.boundingBox !== 'empty' || below.boundingBox !== 'block') continue
        if (below.name.includes('chest') || below.name === 'furnace') continue
        spots.push({ p, score: Math.abs(dz + 2) * 10 + Math.abs(dx) + Math.abs(dy) * 5 })
        break
      }
    }
  }
  return spots.sort((a, b) => a.score - b.score).map(s => s.p)
}

async function openFurnace(bot, block) {
  if (!inReach(bot, block)) {
    await safeGoto(bot, new GoalNear(block.position.x, block.position.y, block.position.z, 2), 8)
    if (!inReach(bot, block)) return null
  }
  return openWithTimeout(bot, block, b => bot.openFurnace(b), 4000, 'horno')
}

/** Saca lo terminado y repone combustible. Devuelve 'idle' si el horno no tiene nada que fundir. */
async function serviceFurnace(bot, block) {
  let furnace
  try { furnace = await openFurnace(bot, block) } catch { return 'error' }
  if (!furnace) return 'error'
  try {
    const out = furnace.outputItem()
    if (out) {
      await furnace.takeOutput()
      stats.add('artisan', 'producidos', out.count)
      stats.addDetail('fundido', out.name, out.count)
    }
    const input = furnace.inputItem()
    if (!input) return 'idle'
    // Con material dentro pero sin combustible (se acabó): reponer. Sin el fuego encendido
    // (furnace.fuel) y sin combustible que poner, el horno está parado: hay que traer más.
    if (!furnace.fuelItem()) {
      await putFuelFor(bot, furnace, input.count)
      await sleep(300)
      if (!furnace.fuelItem() && !(furnace.fuel > 0)) return { noFuel: input.count }
    }
    return 'busy'
  } catch {
    return 'error'
  } finally {
    try { furnace.close() } catch {}
    await sleep(250)
  }
}

/** Mete en un horno libre un lote de un mismo material y el combustible necesario. */
async function loadFurnace(bot, block) {
  const input = bot.inventory.items().find(i => isInput(i.name))
  if (!input) return
  let furnace
  try { furnace = await openFurnace(bot, block) } catch { return }
  if (!furnace) return
  try {
    const count = Math.min(sCfg.batchPerFurnace, countOf(bot, n => n === input.name))
    await furnace.putInput(input.type, null, count)
    await putFuelFor(bot, furnace, count)
    console.log(`${TAG} 🔥 Horno ${fmtPos(block.position)}: ${count} × ${input.name.replace(/_/g, ' ')}.`)
  } catch (err) {
    console.warn(`${TAG} No pude cargar el horno ${fmtPos(block.position)}: ${err.message}`)
  } finally {
    try { furnace.close() } catch {}
    await sleep(250)
  }
}

async function putFuelFor(bot, furnace, itemsToSmelt) {
  const current = furnace.fuelItem()
  for (const rule of FUEL_RULES) {
    const fuel = bot.inventory.items().find(i => rule.test(i.name) && (!current || current.name === i.name))
    if (!fuel) continue
    const have = countOf(bot, n => n === fuel.name)
    const needed = Math.min(have, 64 - (current ? current.count : 0), Math.ceil(itemsToSmelt / fuelValue(fuel.name)))
    if (needed > 0) await furnace.putFuel(fuel.type, null, needed)
    return
  }
}

/** Trae del almacén material para los hornos libres y combustible suficiente. */
async function fetchSmeltables(bot, idleFurnaces) {
  const got = await fetchFromWarehouse(bot, [
    { test: isInput, max: idleFurnaces * sCfg.batchPerFurnace, cats: ['Minerales', 'Comida', 'Pesca', 'Cultivos'] },
  ], 'Artesano')
  const inputs = Object.entries(got).filter(([n]) => isInput(n)).reduce((a, [, n]) => a + n, 0)
  if (inputs === 0) {
    setIssue(bot, 'idle', 'info', 'Nada que fundir ni cocinar en el almacén')
    console.log(`${TAG} 💤 No hay nada que fundir ni cocinar en el almacén.`)
    await teleportTo(bot, bot.home)
    return
  }

  clearIssue(bot, 'idle')
  await ensureFuel(bot, countOf(bot, isInput))
  const summary = Object.entries(got).map(([n, c]) => `${n.replace(/_/g, ' ')} ×${c}`).join(' · ')
  console.log(`${TAG} 🏬 Traído del almacén para los hornos: ${summary}`)
  await teleportTo(bot, bot.home)
}

// ════════════════════════════════════════════════════════════
//  HERRAMIENTAS
// ════════════════════════════════════════════════════════════
function homeOf(key) {
  const fixed = cfg.bots[key] && cfg.bots[key].home
  if (fixed) return new Vec3(fixed.x, fixed.y, fixed.z)
  try {
    const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', `home_${key}.json`), 'utf8'))
    return new Vec3(p.x, p.y, p.z)
  } catch {
    return null
  }
}

function chestIds(bot) {
  return ['chest', 'trapped_chest', 'barrel'].map(n => bot.registry.blocksByName[n]?.id).filter(Boolean)
}

async function openContainer(bot, block) {
  if (!inReach(bot, block)) {
    await safeGoto(bot, new GoalNear(block.position.x, block.position.y, block.position.z, 2), 10)
    if (!inReach(bot, block)) return null
  }
  return openWithTimeout(bot, block)
}

async function checkAndCraft(bot) {
  console.log(`${TAG} 🔍 Revisando herramientas de repuesto de los bots...`)
  const needs = []
  for (const [key, family] of Object.entries(smCfg.tools)) {
    if (bot.stopped || bot.pendingCommand) return
    const home = homeOf(key)
    if (!home) continue
    const spares = await countSpares(bot, home, family)
    if (spares === null) continue
    if (spares < smCfg.sparesPerBot) needs.push({ key, family, home, n: smCfg.sparesPerBot - spares })
  }

  if (needs.length === 0) {
    clearIssue(bot, 'tools')
    console.log(`${TAG} ✅ Todos los bots tienen herramientas de repuesto.`)
    await teleportTo(bot, bot.home)
    return
  }
  console.log(`${TAG} 🛠️ Hace falta: ${needs.map(n => `${LABELS[n.key] || n.key} (${n.family.replace('_', ' ')} ×${n.n})`).join(', ')}`)

  const failed = []
  for (const need of needs) {
    for (let i = 0; i < need.n && !bot.stopped && !bot.pendingCommand; i++) {
      const tool = await craftTool(bot, need.family)
      if (!tool || !await deliverTool(bot, tool, need)) {
        failed.push(`${LABELS[need.key] || need.key} (${need.family.replace('_', ' ')})`)
        break
      }
    }
  }
  // Si un bot se queda sin repuesto, que se vea en el panel (el motivo concreto está en el registro)
  if (failed.length) setIssue(bot, 'tools', 'warn', `No pudo dar repuesto a: ${failed.join(', ')}`)
  else if (!bot.stopped && !bot.pendingCommand) clearIssue(bot, 'tools')

  // Lo que sobre (materiales) a su cofre: el organizador lo devuelve al almacén
  await teleportTo(bot, bot.home)
  await storeOutputs(bot)
}

/** Cuenta herramientas de una familia en los cofres de una casa. null si no pudo revisarlos. */
async function countSpares(bot, home, family) {
  if (!await teleportTo(bot, home)) return null
  const chests = bot.findBlocks({ matching: chestIds(bot), point: home, maxDistance: HOME_CHEST_RADIUS, count: 32 })
    .map(p => bot.blockAt(p)).filter(Boolean)
  let total = 0
  let unread = 0
  for (const chest of chests) {
    try {
      const c = await openContainer(bot, chest)
      if (!c) { unread++; continue }
      total += c.containerItems().filter(i => isToolOf(family)(i.name)).length
      try { c.close() } catch {}
      await sleep(250)
    } catch { unread++ }
  }
  // Si algún cofre no se pudo abrir (a veces el servidor no responde) no se sabe cuántos hay: mejor no
  // fabricar de más y volver a mirar en la próxima revisión
  if (total < smCfg.sparesPerBot && unread > 0) {
    console.warn(`[Artesano] No pude abrir ${unread} cofre(s) en ${fmtPos(home)}; lo reviso en la próxima vuelta.`)
    return null
  }
  return total
}

/** Consigue materiales y fabrica una herramienta. Devuelve el nombre del objeto fabricado o null. */
async function craftTool(bot, family) {
  let itemName = null

  if (family === 'fishing_rod') {
    if (countOf(bot, n => n === 'string') < 2) await fetchFromWarehouse(bot, [{ test: n => n === 'string', max: 2, cats: ['Mobs', 'Varios'] }], 'Artesano')
    if (countOf(bot, n => n === 'string') < 2) {
      // Ningún bot consigue cuerda (sale de las arañas): si el almacén no tiene, se la da con /give
      console.log(`${TAG} 🧵 No hay cuerda en el almacén: me la doy con /give.`)
      if (!await giveSelf(bot, 'string', 2)) return null
    }
    if (!await ensureSticks(bot, 3)) return null
    itemName = 'fishing_rod'
  } else {
    const needs = RECIPE_NEEDS[family]
    if (!needs) return null
    for (const tier of smCfg.tiers) {
      const mat = TIER_MATERIAL[tier]
      if (!mat) continue
      const has = () => countOf(bot, n => mat.names.includes(n))
      if (has() < needs.mat) {
        await fetchFromWarehouse(bot, [{ test: n => mat.names.includes(n), max: needs.mat - has(), cats: mat.cats }], 'Artesano')
      }
      if (has() >= needs.mat) { itemName = `${tier}_${family}`; break }
    }
    if (!itemName) {
      console.warn(`${TAG} ⛏️ No hay material en el almacén para fabricar ${family}.`)
      return null
    }
    if (!await ensureSticks(bot, needs.sticks)) return null
  }

  const table = await ensureTable(bot)
  if (!table) return null
  const before = countOf(bot, n => n === itemName)
  const invText = () => bot.inventory.items().map(i => `${i.name}×${i.count}`).join(', ') || 'vacío'
  const invBefore = invText()
  const made = () => countOf(bot, n => n === itemName) > before
  // A veces el servidor rechaza en silencio los clics en la mesa (objetos del almacén con datos ocultos de
  // ViaVersion): no se gasta nada y no sale nada. Se reintenta; si sigue igual, se da la herramienta con /give.
  for (let attempt = 1; attempt <= CRAFT_ATTEMPTS && !made(); attempt++) {
    if (!await craft(bot, itemName, table)) return null
    await waitUntil(made, 2500) // el servidor puede tardar en confirmar el resultado
    if (!made() && attempt < CRAFT_ATTEMPTS) {
      console.warn(`${TAG} El crafteo de ${itemName.replace(/_/g, ' ')} no dio resultado (antes: ${invBefore} · después: ${invText()}); reintento ${attempt}/${CRAFT_ATTEMPTS - 1}...`)
      await sleep(1500)
    }
  }
  if (!made()) {
    console.warn(`${TAG} El servidor no acepta el crafteo de ${itemName.replace(/_/g, ' ')}: me lo doy con /give para que no falte el repuesto.`)
    if (!await giveSelf(bot, itemName, countOf(bot, n => n === itemName) + 1)) return null
    stats.add('artisan', 'herramientasGive')
  }
  console.log(`${TAG} 🔨 Fabricado: ${itemName.replace(/_/g, ' ')}.`)
  stats.add('artisan', 'herramientas')
  stats.addDetail('herramientas', itemName)
  return itemName
}

/** Se asegura de tener `n` palos: del almacén o fabricándolos con tablas/troncos. */
async function ensureSticks(bot, n) {
  const sticks = () => countOf(bot, s => s === 'stick')
  if (sticks() >= n) return true
  await fetchFromWarehouse(bot, [{ test: s => s === 'stick', max: n - sticks(), cats: ['Madera'] }], 'Artesano')
  if (sticks() >= n) return true

  // Sin palos en el almacén: tablas (o troncos para hacerlas) → palos
  if (countOf(bot, s => s.endsWith('_planks')) < 2) {
    await fetchFromWarehouse(bot, [{ test: s => s.endsWith('_log') && !s.startsWith('stripped_'), max: 1, cats: ['Madera'] }], 'Artesano')
    const table = await ensureTable(bot)
    if (!table) return false
    const planks = bot.registry.itemsArray.filter(i => i.name.endsWith('_planks')).find(i => bot.recipesFor(i.id, null, 1, table).length > 0)
    if (planks) await craft(bot, planks.name, table)
  }
  const table = await ensureTable(bot)
  if (!table) return false
  while (sticks() < n && countOf(bot, s => s.endsWith('_planks')) >= 2) {
    if (!await craft(bot, 'stick', table)) break
  }
  if (sticks() < n) console.warn(`${TAG} 🪵 No consigo palos (ni madera para hacerlos).`)
  return sticks() >= n
}

async function craft(bot, itemName, table) {
  const item = bot.registry.itemsByName[itemName]
  if (!item) return false
  if (!inReach(bot, table)) {
    await safeGoto(bot, new GoalNear(table.position.x, table.position.y, table.position.z, 2), 10)
    if (!inReach(bot, table)) {
      console.warn(`${TAG} No llego a la mesa de trabajo ${fmtPos(table.position)}.`)
      return false
    }
  }
  const recipe = bot.recipesFor(item.id, null, 1, table)[0]
  if (!recipe) {
    console.warn(`${TAG} No tengo materiales para la receta de ${itemName}.`)
    return false
  }
  try {
    await bot.craft(recipe, 1, table)
    await sleep(500)
    return true
  } catch (err) {
    console.warn(`${TAG} Falló el crafteo de ${itemName}: ${err.message}`)
    return false
  }
}

/** Mesa de trabajo junto a casa (la coloca con /give si no hay). */
async function ensureTable(bot) {
  if (bot.entity.position.distanceTo(bot.home) > 12) await teleportTo(bot, bot.home)
  const id = bot.registry.blocksByName.crafting_table.id
  const found = bot.findBlock({ matching: id, point: bot.home, maxDistance: 5 })
  if (found) return found

  if (!await giveSelf(bot, 'crafting_table', 1)) return null
  // Hueco a los lados o al sur del cofre (al norte están los hornos)
  for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [2, 2], [-2, 2], [3, 0], [-3, 0]]) {
    for (const dy of [0, 1, -1]) {
      const spot = bot.home.offset(dx, dy, dz)
      const b = bot.blockAt(spot), below = bot.blockAt(spot.offset(0, -1, 0))
      if (!b || !below || b.name !== 'air' || below.boundingBox !== 'block' || below.name.includes('chest')) continue
      if (await placeBlockAt(bot, spot, 'crafting_table')) {
        await sleep(300)
        const placed = bot.findBlock({ matching: id, point: bot.home, maxDistance: 5 })
        if (placed) {
          console.log(`${TAG} 🪚 Mesa de trabajo colocada en ${fmtPos(placed.position)}.`)
          return placed
        }
      }
    }
  }
  console.warn(`${TAG} No encontré sitio para la mesa de trabajo junto a casa.`)
  return null
}

async function deliverTool(bot, itemName, need) {
  const label = LABELS[need.key] || need.key
  if (!await teleportTo(bot, need.home)) return false
  const chests = bot.findBlocks({ matching: chestIds(bot), point: need.home, maxDistance: HOME_CHEST_RADIUS, count: 32 })
    .map(p => bot.blockAt(p)).filter(Boolean)
  const tool = bot.registry.itemsByName[itemName]
  for (const chest of chests) {
    const before = countOf(bot, n => n === itemName)
    try {
      const c = await openContainer(bot, chest)
      if (!c) continue
      try { await depositNoMerge(bot, c, tool.id, 1) } catch {}
      try { c.close() } catch {}
      // Esperar a que el servidor confirme (con el servidor cargado puede tardar más de un segundo)
      await waitUntil(() => countOf(bot, n => n === itemName) < before, 4000)
    } catch { continue }
    if (countOf(bot, n => n === itemName) < before) {
      console.log(`${TAG} 📦 Entregado ${itemName.replace(/_/g, ' ')} en casa de ${label} ${fmtPos(chest.position)}.`)
      stats.add('artisan', 'entregas')
      return true
    }
  }
  console.warn(`${TAG} No pude dejar ${itemName.replace(/_/g, ' ')} en casa de ${label} (¿cofres llenos?).`)
  return false
}

// ════════════════════════════════════════════════════════════
//  UTILIDADES
// ════════════════════════════════════════════════════════════
/** Coloca un bloque del inventario en `spot` (apoyado en el bloque de debajo). */
async function placeBlockAt(bot, spot, itemName) {
  const ground = bot.blockAt(spot.offset(0, -1, 0))
  if (!ground) return false
  if (!inReach(bot, ground)) {
    await safeGoto(bot, new GoalNear(spot.x, spot.y, spot.z, 2), 8)
    if (!inReach(bot, ground)) return false
  }
  const feet = bot.entity.position.floored()
  if (feet.equals(spot) || feet.offset(0, 1, 0).equals(spot)) return false
  try {
    await bot.equip(bot.inventory.items().find(i => i.name === itemName), 'hand')
    await bot.placeBlock(ground, new Vec3(0, 1, 0))
    return true
  } catch {
    return false
  }
}

// Se asegura de tener `count` unidades; si no, se las da con /give (requiere OP)
async function giveSelf(bot, itemName, count) {
  if (countOf(bot, n => n === itemName) >= count) return true
  await giveItem(bot, itemName, count - countOf(bot, n => n === itemName))
  const ok = await waitUntil(() => countOf(bot, n => n === itemName) >= count, 3000)
  if (!ok) console.warn(`${TAG} No pude darme ${itemName} con /give. ¿Es OP? Ejecuta en la consola del servidor: op ${bot.username}`)
  return ok
}

module.exports = { createBot }

// Ejecutado directamente (node bots/artisan.js) arranca solo; desde el panel lo controla panel.js
if (require.main === module) createBot()
