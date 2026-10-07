// ============================================================
//  bots/organizer.js — Bot Organizador
//  1. Cada cierto tiempo se teletransporta a las casas de los demás bots
//  2. Saca de sus cofres todo menos las herramientas de repuesto
//  3. Vuelve al almacén central (su casa) y reparte cada objeto en el
//     cofre de su categoría (identificado por el cartel que tiene encima)
//  4. Si una categoría no tiene cofre o están llenos, se da uno con /give,
//     lo coloca y le pone un cartel con el nombre de la categoría
// ============================================================
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder, goals: { GoalNear } } = require('mineflayer-pathfinder')
const { loader: autoEat } = require('mineflayer-auto-eat')
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
  activeBots,
  sleep,
  fmtPos,
} = require('./common')

const orgCfg = Object.assign({
  intervalMinutes: 20, warehouseRadius: 12, maxChests: 40, protect: [], categories: { Varios: ['*'] },
}, cfg.organizer)
const SOURCE_CHEST_RADIUS = (cfg.home && cfg.home.chestRadius) || 6
const ASSIGN_FILE = path.join(__dirname, '..', 'data', 'almacen.json')
const SUPPLIES = ['chest', 'oak_sign'] // lo que usa para ampliar el almacén; no es carga
const SUPPLY_STOCK = 4                  // cofres y carteles que se da al empezar cada ronda
const FREE_SLOTS_RESERVE = 2            // huecos que deja libres al recoger, para que /give siempre quepa

// "*_log" → /^.*_log$/
function wildcardToRegex(pattern) {
  return new RegExp('^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
}
const CATEGORY_RULES = Object.entries(orgCfg.categories).map(([name, patterns]) => ({ name, regexes: patterns.map(wildcardToRegex) }))
const PROTECT_RULES = orgCfg.protect.map(wildcardToRegex)

function categoryOf(itemName) {
  const rule = CATEGORY_RULES.find(c => c.regexes.some(r => r.test(itemName)))
  return rule ? rule.name : null
}

function isProtected(itemName) {
  return PROTECT_RULES.some(r => r.test(itemName))
}

// Para comparar carteles escritos a mano: sin mayúsculas ni tildes
function normalize(text) {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
}

function createBot(ctrl = {}) {
  const bot = mineflayer.createBot(botOptions('organizer'))

  bot.loadPlugin(pathfinder)
  bot.loadPlugin(autoEat)

  setupBot(bot, 'Organizador', () => createBot(ctrl), 'organizer', ctrl)

  bot.once('spawn', () => {
    console.log(`[${cfg.bots.organizer.username}] 🗂️ Conectado. Primera ronda en unos segundos...`)
    setTimeout(() => workLoop(bot), 3000)
  })

  return bot
}

async function workLoop(bot) {
  let nextRound = Date.now() + 15000

  while (!bot.stopped) {
    try {
      // Órdenes del panel: "Organizar ahora" hace una ronda; "Volver a casa"/"Rescatar" vuelven al almacén
      const cmd = bot.pendingCommand
      if (cmd) {
        bot.pendingCommand = null
        if (cmd === 'organize') {
          await organizeRound(bot)
          nextRound = Date.now() + orgCfg.intervalMinutes * 60 * 1000
        } else if (cargo(bot).length > 0) {
          await deliver(bot)
        } else if (bot.home) {
          await teleportTo(bot, bot.home)
        }
        continue
      }

      if (Date.now() >= nextRound) {
        await organizeRound(bot)
        nextRound = Date.now() + orgCfg.intervalMinutes * 60 * 1000
      }
      await sleep(2000)
    } catch (err) {
      console.warn(`[Organizador] ⚠️ ${err.message}`)
      await sleep(5000)
    }
  }
}

// ── Ronda completa ───────────────────────────────────────────
async function organizeRound(bot) {
  bot.organizing = true // el panel lo muestra en el botón
  try {
    await organizeRoundInner(bot)
  } finally {
    bot.organizing = false
  }
}

async function organizeRoundInner(bot) {
  if (!bot.home) {
    console.log('[Organizador] 🏠 Sin almacén todavía. Ponme junto a un cofre y usa "!casa organizador" (o "Fijar casa" en el panel).')
    return
  }
  const sources = sourceHomes(bot)
  if (sources.length === 0) {
    console.log('[Organizador] 🗂️ No conozco casas de otros bots que revisar.')
    return
  }

  console.log(`[Organizador] 🗂️ Empiezo ronda: ${sources.length} casas que revisar.`)
  bot.roundStats = { collected: 0, sorted: 0 }

  // Antes de nada: vaciar lo que traiga de antes (y el buzón) y tener cofres/carteles de reserva
  if (!await teleportTo(bot, bot.home)) return
  if (cargo(bot).length > 0) await sortIntoWarehouse(bot)
  await sortInbox(bot)
  await stockSupplies(bot)

  if (cargo(bot).length > 0) {
    console.warn(`[Organizador] ⛔ No puedo empezar: llevo ${cargoCount(bot)} objetos que no caben en el almacén. Revisa los avisos de arriba.`)
    return
  }

  for (const src of sources) {
    if (bot.stopped || bot.pendingCommand) break
    if (!await waitOwnerIdle(src)) {
      console.log(`[Organizador] ⏭️ ${src.label} está guardando en su casa ahora; lo dejo para la próxima ronda.`)
      continue
    }

    // Varios viajes si en una casa hay más de lo que cabe en el inventario
    for (let trip = 0; trip < 8 && !bot.stopped && !bot.pendingCommand; trip++) {
      console.log(`[Organizador] 🌀 Voy a casa de ${src.label} ${fmtPos(src.pos)}...`)
      if (!await teleportTo(bot, src.pos)) return
      const { taken, more } = await collectFrom(bot, src)
      if (taken > 0) console.log(`[Organizador] 📥 Recogí ${taken} objetos en casa de ${src.label}.`)
      bot.roundStats.collected += taken
      if (cargo(bot).length > 0) await deliver(bot)
      // Si no pudo ordenar lo recogido, seguir recogiendo solo empeoraría las cosas
      if (cargo(bot).length > 0) {
        console.warn(`[Organizador] ⛔ Paro la ronda: no consigo ordenar ${cargoCount(bot)} objetos (queda en mi inventario y en el buzón).`)
        return finishRound(bot)
      }
      if (!more || taken === 0) break
    }
  }

  await teleportTo(bot, bot.home)
  await sortInbox(bot)
  finishRound(bot)
}

function finishRound(bot) {
  const s = bot.roundStats
  stats.add('organizer', 'rondas')
  stats.add('organizer', 'recogidos', s.collected)
  console.log(`[Organizador] ✅ Ronda terminada: ${s.collected} objetos recogidos, ${s.sorted} ordenados en el almacén.`)
}

// ── Material y buzón ─────────────────────────────────────────

// Se da cofres y carteles de reserva mientras tiene sitio en el inventario
async function stockSupplies(bot) {
  for (const name of SUPPLIES) {
    const have = bot.inventory.items().filter(i => i.name === name).reduce((a, i) => a + i.count, 0)
    if (have < 2) await giveSelf(bot, name, SUPPLY_STOCK - have)
  }
}

/**
 * El cofre de su casa (sin cartel) es el buzón: lo usa de colchón si se queda sin sitio
 * y al final de cada ronda ordena lo que haya dentro. También sirve para que tú le dejes cosas.
 */
function inboxChest(bot) {
  if (!orgCfg.inbox) return null // desactivado: no tocar cofres sin cartel
  const block = bot.home && bot.blockAt(bot.home)
  if (!block || !['chest', 'trapped_chest', 'barrel'].includes(block.name)) return null
  if (signLabel(bot, bot.home)) return null // con cartel es un cofre de categoría, no buzón
  return block
}

async function sortInbox(bot) {
  for (let round = 0; round < 6 && !bot.stopped; round++) {
    const inbox = inboxChest(bot)
    if (!inbox || !await approach(bot, inbox)) return
    let took = 0
    try {
      const container = await openContainer(bot, inbox)
      const byType = new Map()
      for (const item of container.containerItems()) byType.set(item.type, (byType.get(item.type) || 0) + item.count)
      for (const [type, count] of byType) {
        if (bot.inventory.emptySlotCount() <= FREE_SLOTS_RESERVE) break
        const before = cargoCount(bot)
        try { await container.withdraw(type, null, count) } catch {}
        took += cargoCount(bot) - before
        await sleep(150)
      }
      try { container.close() } catch {}
      await sleep(300)
    } catch { return }
    if (took === 0) return
    console.log(`[Organizador] 📬 Saqué ${took} objetos del buzón para ordenarlos.`)
    const before = cargoCount(bot)
    await sortIntoWarehouse(bot)
    if (cargoCount(bot) >= before) return // no avanzó: no insistir
  }
}

// Mete carga en el buzón para liberar huecos (cuando necesita sitio para un /give)
async function freeSlotsUsingInbox(bot, slotsNeeded) {
  const inbox = inboxChest(bot)
  if (!inbox || !await approach(bot, inbox)) return false
  try {
    const container = await openContainer(bot, inbox)
    // Primero las pilas más pequeñas: liberan un hueco moviendo pocos objetos
    const stacks = cargo(bot).sort((a, b) => a.count - b.count)
    for (const stack of stacks) {
      if (bot.inventory.emptySlotCount() >= slotsNeeded) break
      try { await container.deposit(stack.type, null, stack.count) } catch { break }
      await sleep(150)
    }
    try { container.close() } catch {}
    await sleep(300)
  } catch { return false }
  return bot.inventory.emptySlotCount() >= slotsNeeded
}

// Casas de los demás bots (config, data/home_*.json), sin repetir y sin contar el propio almacén
function sourceHomes(bot) {
  const homes = []
  for (const key of Object.keys(cfg.bots)) {
    if (key === 'organizer') continue
    let pos = cfg.bots[key].home || (cfg.chest && cfg.chest.position)
    if (!pos) {
      try { pos = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', `home_${key}.json`), 'utf8')) } catch {}
    }
    if (!pos) continue
    const v = new Vec3(pos.x, pos.y, pos.z)
    if (v.distanceTo(bot.home) <= orgCfg.warehouseRadius + SOURCE_CHEST_RADIUS) continue
    if (homes.some(h => h.pos.distanceTo(v) < 1)) continue
    const label = { woodcutter: 'Leñador', miner: 'Minero', farmer: 'Granjero', fisher: 'Pescador', rancher: 'Ganadero' }[key] || key
    homes.push({ key, label, pos: v })
  }
  return homes
}

// Espera (hasta 30 s) a que el dueño de esa casa termine de guardar
async function waitOwnerIdle(src) {
  const owner = [...activeBots].find(b => b.botKey === src.key)
  if (!owner) return true
  return waitUntil(() => !owner.depositing, 30000, 500)
}

function chestIds(bot) {
  const mcData = require('minecraft-data')(bot.version)
  return ['chest', 'trapped_chest', 'barrel'].map(n => mcData.blocksByName[n]?.id).filter(Boolean)
}

async function openContainer(bot, block) {
  return Promise.race([
    bot.openContainer(block),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout al abrir cofre')), 4000)),
  ])
}

async function approach(bot, block) {
  if (inReach(bot, block)) return true
  await safeGoto(bot, new GoalNear(block.position.x, block.position.y, block.position.z, 2), 12)
  return inReach(bot, block)
}

// Objetos de carga: todo menos lo que usa para ampliar el almacén
function cargo(bot) {
  return bot.inventory.items().filter(i => !SUPPLIES.includes(i.name))
}

function cargoCount(bot) {
  return cargo(bot).reduce((a, i) => a + i.count, 0)
}

// ── Recoger ──────────────────────────────────────────────────
/** Saca de los cofres de una casa todo lo no protegido. more = true si quedó algo por falta de espacio. */
async function collectFrom(bot, src) {
  const chests = bot.findBlocks({ matching: chestIds(bot), point: src.pos, maxDistance: SOURCE_CHEST_RADIUS, count: 32 })
    .map(p => bot.blockAt(p))
    .filter(Boolean)

  const before = cargoCount(bot)
  let more = false

  for (const chest of chests) {
    if (bot.stopped || bot.pendingCommand) break
    if (bot.inventory.emptySlotCount() <= FREE_SLOTS_RESERVE) { more = true; break }
    if (!await approach(bot, chest)) continue

    try {
      const container = await openContainer(bot, chest)
      // Agrupar por tipo: withdraw() saca de varias pilas a la vez
      const byType = new Map()
      for (const item of container.containerItems()) {
        if (isProtected(item.name)) continue
        byType.set(item.type, (byType.get(item.type) || 0) + item.count)
      }
      for (const [type, count] of byType) {
        if (bot.inventory.emptySlotCount() <= FREE_SLOTS_RESERVE) { more = true; break }
        // No sacar más de lo que cabe dejando la reserva de huecos libres
        const item = container.containerItems().find(i => i.type === type)
        const room = (bot.inventory.emptySlotCount() - FREE_SLOTS_RESERVE) * (item ? item.stackSize : 64)
        const amount = Math.min(count, room)
        if (amount < count) more = true
        try {
          await container.withdraw(type, null, amount)
          await sleep(150)
        } catch {
          more = true // inventario lleno a mitad
          break
        }
      }
      try { container.close() } catch {}
      await sleep(300)
    } catch (err) {
      console.warn(`[Organizador] No pude abrir el cofre ${fmtPos(chest.position)}: ${err.message}`)
    }
  }
  return { taken: cargoCount(bot) - before, more }
}

// ── Ordenar en el almacén ────────────────────────────────────
async function deliver(bot) {
  if (!bot.home || cargo(bot).length === 0) return
  if (!await teleportTo(bot, bot.home)) return
  await sortIntoWarehouse(bot)
}

async function sortIntoWarehouse(bot) {
  const warehouse = scanWarehouse(bot)
  const summary = []

  // Agrupar la carga por categoría; primero las que ya tienen cofre (liberan huecos para los /give)
  const cats = [...new Set(cargo(bot).map(i => categoryOf(i.name)).filter(Boolean))]
    .sort((a, b) => (warehouse.byCategory.has(normalize(b)) ? 1 : 0) - (warehouse.byCategory.has(normalize(a)) ? 1 : 0))
  for (const cat of cats) {
    if (bot.stopped) return
    const before = cargoOfCategory(bot, cat).reduce((a, i) => a + i.count, 0)
    await depositCategory(bot, cat, warehouse)
    const stored = before - cargoOfCategory(bot, cat).reduce((a, i) => a + i.count, 0)
    if (stored > 0) summary.push(`${cat} ×${stored}`)
    if (bot.roundStats) bot.roundStats.sorted += stored
    stats.add('organizer', 'ordenados', stored)
    stats.addDetail('almacen', cat, stored)
  }

  if (summary.length) console.log(`[Organizador] 🗂️ Ordenado: ${summary.join(' · ')}`)
  const left = cargoCount(bot)
  if (left > 0) console.warn(`[Organizador] 📦 Me quedan ${left} objetos sin sitio en el almacén.`)
}

function cargoOfCategory(bot, cat) {
  return cargo(bot).filter(i => categoryOf(i.name) === cat)
}

async function depositCategory(bot, cat, warehouse) {
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const chest of warehouse.byCategory.get(normalize(cat)) || []) {
      if (cargoOfCategory(bot, cat).length === 0) return
      if (!await approach(bot, chest)) continue
      await depositVerified(bot, cat, chest)
    }
    if (cargoOfCategory(bot, cat).length === 0) return
    // Sin cofre para esta categoría o todos llenos: crear uno nuevo
    if (!await createCategoryChest(bot, cat, warehouse)) return
  }
}

const catCount = (bot, cat) => cargoOfCategory(bot, cat).reduce((a, i) => a + i.count, 0)

/**
 * Deposita la carga de una categoría en un cofre y COMPRUEBA que el servidor lo aceptó: a veces
 * (justo después de colocar cofre y cartel) rechaza los clics y devuelve los objetos al cerrar.
 * Si detecta la devolución, lo reintenta.
 */
async function depositVerified(bot, cat, chest) {
  for (let tryN = 0; tryN < 3 && !bot.stopped; tryN++) {
    const before = catCount(bot, cat)
    if (before === 0) return
    let chestFull = false
    try {
      const container = await openContainer(bot, chest)
      // Agrupar por tipo; deposit() rellena primero las pilas incompletas (compacta)
      const byType = new Map()
      for (const i of cargoOfCategory(bot, cat)) byType.set(i.type, (byType.get(i.type) || 0) + i.count)
      for (const [type, count] of byType) {
        try {
          await container.deposit(type, null, count)
          await sleep(150)
        } catch (e) {
          if (e.message && e.message.includes('destination full')) { chestFull = true; break }
        }
      }
      try { container.close() } catch {}
    } catch (err) {
      console.warn(`[Organizador] No pude abrir el cofre ${fmtPos(chest.position)}: ${err.message}`)
      return
    }
    await sleep(1500) // tiempo para que el servidor confirme o devuelva los objetos
    if (catCount(bot, cat) < before) return // aceptado
    if (chestFull) return // estaba lleno de antes: no hay nada que reintentar
    console.warn(`[Organizador] ↩️ El servidor devolvió lo que guardé en ${fmtPos(chest.position)}; reintento (${tryN + 1}/3)...`)
    await sleep(1000)
  }
}

/**
 * Cofres del almacén y su categoría. La categoría sale del cartel encima (o en un lateral) del cofre;
 * si el cartel no se pudo leer, de lo guardado en data/almacen.json al crearlo.
 */
function scanWarehouse(bot) {
  const assigned = loadAssignments()
  const positions = bot.findBlocks({ matching: chestIds(bot), point: bot.home, maxDistance: orgCfg.warehouseRadius, count: 300 })
  const byCategory = new Map()

  for (const p of positions) {
    const chest = bot.blockAt(p)
    if (!chest) continue
    const label = signLabel(bot, p) || assigned[p.toString()]
    if (!label) continue
    const key = normalize(label)
    if (!byCategory.has(key)) byCategory.set(key, [])
    byCategory.get(key).push(chest)
  }
  return { byCategory, total: positions.length }
}

function signLabel(bot, chestPos) {
  const around = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
  for (const [x, y, z] of around) {
    const b = bot.blockAt(chestPos.offset(x, y, z))
    if (!b || !b.name.endsWith('_sign') || typeof b.getSignText !== 'function') continue
    try {
      const front = b.getSignText()[0] || ''
      const line = front.split('\n').map(s => s.trim()).find(Boolean)
      if (line) return line
    } catch {}
  }
  return null
}

function loadAssignments() {
  try { return JSON.parse(fs.readFileSync(ASSIGN_FILE, 'utf8')) } catch { return {} }
}

function saveAssignment(pos, category) {
  const all = loadAssignments()
  all[pos.toString()] = category
  try {
    fs.mkdirSync(path.dirname(ASSIGN_FILE), { recursive: true })
    fs.writeFileSync(ASSIGN_FILE, JSON.stringify(all, null, 2))
  } catch {}
}

// ── Ampliar el almacén ───────────────────────────────────────
async function createCategoryChest(bot, cat, warehouse) {
  if (warehouse.total >= orgCfg.maxChests) {
    console.warn(`[Organizador] 📦 El almacén ya tiene el máximo de ${orgCfg.maxChests} cofres (organizer.maxChests en config.js).`)
    return false
  }
  // Para recibir cofre y cartel con /give necesita huecos libres: si no los hay, usar el buzón de colchón
  const missing = SUPPLIES.filter(n => !bot.inventory.items().some(i => i.name === n)).length
  if (missing > 0 && bot.inventory.emptySlotCount() < missing) {
    if (!await freeSlotsUsingInbox(bot, missing)) {
      console.warn('[Organizador] 📦 Inventario lleno y sin buzón libre: no puedo darme un cofre nuevo.')
      return false
    }
  }
  if (!await giveSelf(bot, 'chest') || !await giveSelf(bot, 'oak_sign')) return false

  const sameCat = warehouse.byCategory.get(normalize(cat)) || []
  for (const spot of findWarehouseSpots(bot, sameCat).slice(0, 6)) {
    const ground = bot.blockAt(spot.offset(0, -1, 0))
    if (!await approach(bot, ground)) continue
    const feet = bot.entity.position.floored()
    if (feet.equals(spot) || feet.offset(0, 1, 0).equals(spot)) continue

    // 1. Cofre
    try {
      await bot.equip(bot.inventory.items().find(i => i.name === 'chest'), 'hand')
      await bot.placeBlock(ground, new Vec3(0, 1, 0))
    } catch {}
    await sleep(300)
    const chest = bot.blockAt(spot)
    if (!chest || chest.name !== 'chest') continue

    // 2. Cartel encima (agachado, para que el clic no abra el cofre)
    await placeSign(bot, chest, cat)
    saveAssignment(spot, cat) // por si el cartel no se pudo escribir

    if (!warehouse.byCategory.has(normalize(cat))) warehouse.byCategory.set(normalize(cat), [])
    warehouse.byCategory.get(normalize(cat)).push(chest)
    warehouse.total++
    console.log(`[Organizador] 🆕 Cofre nuevo para "${cat}" en ${fmtPos(spot)} (${warehouse.total}/${orgCfg.maxChests}).`)
    stats.add('organizer', 'cofresCreados')
    return true
  }
  console.warn(`[Organizador] 📦 No encontré hueco para un cofre nuevo de "${cat}" en el almacén.`)
  return false
}

async function placeSign(bot, chest, text) {
  try {
    await bot.equip(bot.inventory.items().find(i => i.name === 'oak_sign'), 'hand')
    const opened = new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 3000)
      bot.once('signOpen', (block) => { clearTimeout(timer); resolve(block) })
    })
    bot.setControlState('sneak', true)
    await sleep(250)
    try { await bot.placeBlock(chest, new Vec3(0, 1, 0)) } catch {}
    bot.setControlState('sneak', false)

    const signBlock = (await opened) || bot.blockAt(chest.position.offset(0, 1, 0))
    if (signBlock && signBlock.name.endsWith('_sign')) {
      bot.updateSign(signBlock, text)
    }
    await sleep(1500) // dejar que el servidor termine con el cartel antes de abrir cofres
  } catch (err) {
    bot.setControlState('sneak', false)
    console.warn(`[Organizador] No pude poner el cartel "${text}": ${err.message}`)
  }
}

// Se da `count` unidades con /give si no tiene ninguna (requiere OP y un hueco libre)
async function giveSelf(bot, itemName, count = 1) {
  const has = () => bot.inventory.items().some(i => i.name === itemName)
  if (has() && count <= 1) return true
  if (bot.inventory.emptySlotCount() === 0 && !has()) {
    console.warn(`[Organizador] No puedo recibir ${itemName}: inventario lleno.`)
    return false
  }
  bot.chat(`/give ${bot.username} ${itemName} ${Math.max(1, count)}`)
  const ok = await waitUntil(has, 3000)
  if (!ok) console.warn(`[Organizador] No pude darme ${itemName} con /give. ¿Es OP? Ejecuta en la consola del servidor: op ${bot.username}`)
  return ok
}

/**
 * Huecos para cofres en cuadrícula (cada 2 bloques en X y cada 3 en Z, dejando pasillos) dentro del radio
 * del almacén: aire con aire encima (para el cartel), suelo firme y sin cofres pegados (así no se unen en
 * cofres dobles de distinta categoría). Prioriza los cercanos a cofres de la misma categoría.
 */
function findWarehouseSpots(bot, sameCategoryChests) {
  const home = bot.home
  const R = orgCfg.warehouseRadius
  const spots = []

  for (let dx = -R; dx <= R; dx += 2) {
    for (let dz = -R; dz <= R; dz += 3) {
      for (let dy = -2; dy <= 2; dy++) {
        const p = home.offset(dx, dy, dz)
        if (p.distanceTo(home) > R - 0.5 || p.equals(home)) continue
        const b = bot.blockAt(p)
        const above = bot.blockAt(p.offset(0, 1, 0))
        const below = bot.blockAt(p.offset(0, -1, 0))
        if (!b || !above || !below) continue
        if (!(b.name === 'air' || b.name === 'cave_air')) continue
        if (!(above.name === 'air' || above.name === 'cave_air')) continue
        if (below.boundingBox !== 'block' || below.name.includes('chest') || below.name.includes('leaves') || below.name === 'farmland') continue
        const touchesChest = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => {
          const n = bot.blockAt(p.offset(x, 0, z))
          return n && (n.name === 'chest' || n.name === 'trapped_chest')
        })
        if (touchesChest) continue

        const score = sameCategoryChests.length
          ? Math.min(...sameCategoryChests.map(c => c.position.distanceTo(p)))
          : 50 + p.distanceTo(home)
        spots.push({ p, score })
      }
    }
  }
  return spots.sort((a, b) => a.score - b.score).map(s => s.p)
}

module.exports = { createBot }

// Ejecutado directamente (node bots/organizer.js) arranca solo; desde el panel lo controla panel.js
if (require.main === module) createBot()
