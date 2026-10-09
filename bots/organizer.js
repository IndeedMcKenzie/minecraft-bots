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
const Vec3 = require('vec3')
const cfg = require('../config')
const stats = require('./stats')
const inventory = require('./inventory')
const { fetchFromWarehouse, displayCat } = require('./warehouse')
const {
  botOptions,
  setupBot,
  safeGoto,
  inReach,
  teleportTo,
  waitUntil,
  activeBots,
  depositNoMerge,
  setIssue,
  idleSleep,
  requestTeleport,
  openWithTimeout,
  clearIssue,
  sleep,
  fmtPos,
} = require('./common')

const orgCfg = Object.assign({
  intervalMinutes: 20, warehouseRadius: 12, maxWarehouseRadius: 112, maxChests: 0,
  protect: [], categories: { Varios: ['*'] },
}, cfg.organizer)
const SOURCE_CHEST_RADIUS = (cfg.home && cfg.home.chestRadius) || 6
// Se lee en cada ronda: se puede cambiar desde la pestaña ⚙️ Ajustes del panel
const roundMinutes = () => (cfg.organizer && cfg.organizer.intervalMinutes) || orgCfg.intervalMinutes
const ASSIGN_FILE = path.join(__dirname, '..', 'data', 'almacen.json')
const RING_STEP = 6 // cuánto crece el radio del almacén cada vez que se queda sin hueco
const SUPPLIES = ['chest', 'oak_sign'] // lo que usa para ampliar el almacén; no es carga
const SUPPLY_STOCK = 4                  // cofres y carteles que se da al empezar cada ronda
const FREE_SLOTS_RESERVE = 2            // huecos que deja libres al recoger, para que /give siempre quepa
const SPOT_TRIES = 15                   // huecos que prueba para un cofre nuevo antes de rendirse
const BAD_SPOT_MS = 30 * 60 * 1000     // un hueco donde falló no se vuelve a probar en este tiempo
const SCAN_EVERY_MS = 2 * 60 * 60 * 1000 // escaneo completo del inventario del almacén (además de lo que ve al guardar)

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
      // Órdenes del panel: "Organizar ahora" hace una ronda; "Volver a casa"/"Rescatar" vuelven al almacén.
      // Un pedido no se pierde aunque otra orden lo haya pisado: se atiende después.
      if (!bot.pendingCommand && bot.pendingRequest) bot.pendingCommand = 'request'
      const cmd = bot.pendingCommand
      if (cmd) {
        bot.pendingCommand = null
        if (cmd === 'organize') {
          await organizeRound(bot)
          nextRound = Date.now() + roundMinutes() * 60 * 1000
        } else if (cmd === 'scan') {
          await scanInventory(bot)
        } else if (cmd === 'request') {
          const req = bot.pendingRequest
          bot.pendingRequest = null
          await deliverRequest(bot, req)
        } else if (cargo(bot).length > 0) {
          await deliver(bot)
        } else if (bot.home) {
          await teleportTo(bot, bot.home)
        }
        continue
      }

      if (Date.now() >= nextRound) {
        await organizeRound(bot)
        nextRound = Date.now() + roundMinutes() * 60 * 1000
        const last = inventory.summary().lastScan
        // Con el plugin BotHelper el panel ya sabe el contenido real: no hace falta revisar cofre por cofre
        if (!bot.pendingCommand && !inventory.isLive() && (!last || Date.now() - last > SCAN_EVERY_MS)) await scanInventory(bot)
      }
      await idleSleep(bot, 2000)
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
  bot.fullCats = new Set() // categorías sin sitio en esta ronda: sus objetos se dejan en las casas

  // Antes de nada: vaciar lo que traiga de antes (y el buzón) y tener cofres/carteles de reserva
  if (!await teleportTo(bot, bot.home)) return
  if (cargo(bot).length > 0) await sortIntoWarehouse(bot)
  await sortInbox(bot)
  await stockSupplies(bot)

  // Lo que no cupo (categorías llenas) se queda en el inventario; mientras quede sitio para recoger, seguir
  if (bot.fullCats.size > 0) {
    console.warn(`[Organizador] 📦 Categorías sin sitio en el almacén: ${[...bot.fullCats].join(', ')}. Dejo esos objetos en las casas y sigo con el resto.`)
  }
  if (bot.inventory.emptySlotCount() <= FREE_SLOTS_RESERVE + 2) {
    console.warn(`[Organizador] ⛔ No puedo empezar: llevo ${cargoCount(bot)} objetos que no caben en el almacén y casi no me queda inventario.`)
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
      // Lo de categorías llenas no cabe en el almacén: devolverlo a la casa de la que salió
      if (cargo(bot).some(i => bot.fullCats.has(categoryOf(i.name)))) await returnLeftovers(bot, src)
      // Si no pudo ordenar algo de una categoría que SÍ tenía sitio, hay otro problema: no seguir recogiendo
      const stuckCargo = cargo(bot).filter(i => !bot.fullCats.has(categoryOf(i.name)))
      if (stuckCargo.length > 0 || bot.inventory.emptySlotCount() <= FREE_SLOTS_RESERVE + 2) {
        console.warn(`[Organizador] ⛔ Paro la ronda: no consigo ordenar ${cargoCount(bot)} objetos (quedan en mi inventario).`)
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
  if (bot.fullCats && bot.fullCats.size > 0) setIssue(bot, 'fullCats', 'warn', `Almacén sin sitio para: ${[...bot.fullCats].join(', ')} (se quedan en las casas)`)
  else clearIssue(bot, 'fullCats')
  console.log(`[Organizador] ✅ Ronda terminada: ${s.collected} objetos recogidos, ${s.sorted} ordenados en el almacén.`)
}

// ── Inventario del almacén y pedidos ─────────────────────────

/** Abre todos los cofres del almacén y apunta lo que hay (para la pestaña Almacén del panel). */
async function scanInventory(bot) {
  if (!bot.home || !await teleportTo(bot, bot.home)) return
  bot.scanning = true
  try {
    const warehouse = scanWarehouse(bot)
    const positions = []
    const seen = new Set() // la otra mitad de un cofre doble ya revisado no hace falta abrirla
    let opened = 0
    console.log('[Organizador] 📋 Revisando el contenido del almacén...')
    for (const [key, chests] of warehouse.byCategory) {
      for (const chest of chests) {
        if (bot.stopped || bot.pendingCommand) return // interrumpido: el escaneo queda a medias
        positions.push(chest)
        const chestId = inventory.chestKey(chest)
        if (seen.has(chestId)) continue
        seen.add(chestId)
        if (!await approach(bot, chest)) continue
        try {
          const container = await openContainer(bot, chest)
          inventory.recordChest(chest, displayCat(key), container.containerItems())
          try { container.close() } catch {}
          opened++
        } catch {}
        await sleep(250)
      }
    }
    inventory.finishScan(positions)
    console.log(`[Organizador] 📋 Inventario del almacén actualizado: ${opened} cofres revisados.`)
  } finally {
    bot.scanning = false
  }
}

/** Pedido del panel: saca `count` de `item` del almacén y se lo lleva al jugador con /tp. */
async function deliverRequest(bot, req) {
  if (!req) return
  const { item, count, player } = req
  const pretty = item.replace(/_/g, ' ')
  if (!bot.home) {
    console.warn('[Organizador] 📦 Pedido cancelado: no tengo almacén (usa "Fijar casa").')
    return
  }
  bot.delivering = req
  try {
    if (cargo(bot).length > 0) await deliver(bot) // vaciar antes lo que llevara
    console.log(`[Organizador] 📦 Pedido: ${count} × ${pretty} para ${player}. Buscándolo en el almacén...`)
    const cats = [...new Set([categoryOf(item), ...inventory.catsWith(item)].filter(Boolean))]
    const got = await fetchFromWarehouse(bot, [{ test: n => n === item, max: count, cats }], 'Organizador')
    const n = got[item] || 0
    if (n === 0) {
      console.warn(`[Organizador] 📦 Pedido: no encontré ${pretty} en el almacén.`)
      return
    }
    if (!bot.players[player]) {
      console.warn(`[Organizador] 📦 Pedido: ${player} ya no está conectado. Devuelvo ${pretty} al almacén.`)
      return
    }

    await requestTeleport(bot, { to: player })
    const near = () => {
      const e = bot.players[player] && bot.players[player].entity
      return e && e.position.distanceTo(bot.entity.position) < 6
    }
    if (!await waitUntil(near, 6000)) {
      console.warn(`[Organizador] 📦 Pedido: no pude llegar hasta ${player} con /tp. Devuelvo ${pretty} al almacén.`)
      return
    }
    await sleep(800) // que carguen los chunks y el jugador se vea bien
    const target = bot.players[player].entity
    await bot.lookAt(target.position.offset(0, 1.2, 0), true)
    for (const stack of bot.inventory.items().filter(i => i.name === item)) {
      await bot.tossStack(stack)
      await sleep(150)
    }
    console.log(`[Organizador] 📦 Pedido entregado: ${n} × ${pretty} a ${player}${n < count ? ` (solo había ${n} de ${count})` : ''}.`)
    stats.add('organizer', 'pedidos')
    stats.addDetail('pedidos', item, n)
    await sleep(1500)
  } catch (err) {
    console.warn(`[Organizador] 📦 Pedido fallido: ${err.message}`)
  } finally {
    bot.delivering = null
    // Lo que no se entregó vuelve a su cofre
    await teleportTo(bot, bot.home)
    if (cargo(bot).length > 0) await sortIntoWarehouse(bot)
  }
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
    // Solo se descarta una casa que esté en el mismo sitio que el almacén. Las de al lado (p. ej. el
    // taller del fundidor y el herrero) sí se recogen: collectFrom no toca los cofres del almacén.
    if (v.distanceTo(bot.home) < 2) continue
    if (homes.some(h => h.pos.distanceTo(v) < 1)) continue
    const label = { woodcutter: 'Leñador', miner: 'Minero', farmer: 'Granjero', fisher: 'Pescador', artisan: 'Artesano' }[key] || key
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
  const mcData = bot.registry
  return ['chest', 'trapped_chest', 'barrel'].map(n => mcData.blocksByName[n]?.id).filter(Boolean)
}

async function openContainer(bot, block) {
  return openWithTimeout(bot, block)
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
  const assigned = loadAssignments()
  const chests = bot.findBlocks({ matching: chestIds(bot), point: src.pos, maxDistance: SOURCE_CHEST_RADIUS, count: 32 })
    .map(p => bot.blockAt(p))
    .filter(Boolean)
    // Nunca vaciar cofres del almacén (con cartel de categoría o creados por el organizador) ni el de su casa
    .filter(c => !signLabel(bot, c.position) && !assigned[c.position.toString()] && !c.position.equals(bot.home))

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
        if (bot.fullCats && bot.fullCats.has(categoryOf(item.name))) continue // sin sitio en el almacén: dejarlo aquí
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

/** Devuelve a los cofres de una casa lo que no cupo en el almacén (categorías llenas). */
async function returnLeftovers(bot, src) {
  const before = cargoCount(bot)
  if (before === 0 || !await teleportTo(bot, src.pos)) return
  const chests = bot.findBlocks({ matching: chestIds(bot), point: src.pos, maxDistance: SOURCE_CHEST_RADIUS, count: 32 })
    .map(p => bot.blockAt(p))
    .filter(Boolean)

  for (const chest of chests) {
    if (cargo(bot).length === 0 || bot.stopped) break
    if (!await approach(bot, chest)) continue
    // 1º juntando pilas; si el servidor lo devuelve, en huecos vacíos
    for (const noMerge of [false, true]) {
      const n = cargoCount(bot)
      if (n === 0) break
      try {
        const container = await openContainer(bot, chest)
        const byType = new Map()
        for (const i of cargo(bot)) byType.set(i.type, (byType.get(i.type) || 0) + i.count)
        for (const [type, count] of byType) {
          try {
            if (noMerge) await depositNoMerge(bot, container, type)
            else await container.deposit(type, null, count)
            await sleep(150)
          } catch { break } // cofre lleno: probar el siguiente
        }
        try { container.close() } catch {}
        await sleep(1200)
      } catch { break }
      if (cargoCount(bot) < n) break
    }
  }
  const returned = before - cargoCount(bot)
  if (returned > 0) console.log(`[Organizador] ↩️ Devolví ${returned} objetos sin sitio en el almacén a la casa de ${src.label}.`)
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
    // Sin cofre para esta categoría o todos llenos: crear uno nuevo; si no se puede, la categoría está llena
    if (!await createCategoryChest(bot, cat, warehouse)) {
      if (bot.fullCats) bot.fullCats.add(cat)
      return
    }
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
    // Si el servidor devolvió el primer intento, en los siguientes no se juntan pilas
    // (ver depositNoMerge: objetos con datos ocultos de ViaVersion, como los huevos)
    const noMerge = tryN > 0
    try {
      const container = await openContainer(bot, chest)
      // Agrupar por tipo; deposit() rellena primero las pilas incompletas (compacta)
      const byType = new Map()
      for (const i of cargoOfCategory(bot, cat)) byType.set(i.type, (byType.get(i.type) || 0) + i.count)
      for (const [type, count] of byType) {
        try {
          if (noMerge) await depositNoMerge(bot, container, type)
          else await container.deposit(type, null, count)
          await sleep(150)
        } catch (e) {
          if (e.message && e.message.includes('destination full')) { chestFull = true; break }
        }
      }
      inventory.recordChest(chest, cat, container.containerItems())
      try { container.close() } catch {}
    } catch (err) {
      console.warn(`[Organizador] No pude abrir el cofre ${fmtPos(chest.position)}: ${err.message}`)
      return
    }
    await sleep(1500) // tiempo para que el servidor confirme o devuelva los objetos
    if (catCount(bot, cat) < before) return // aceptado
    if (chestFull) return // estaba lleno de antes: no hay nada que reintentar
    console.warn(`[Organizador] ↩️ El servidor devolvió lo que guardé en ${fmtPos(chest.position)}; reintento en huecos vacíos (${tryN + 1}/3)...`)
    await sleep(1000)
  }
}

/**
 * Cofres del almacén y su categoría. La categoría sale del cartel encima (o en un lateral) del cofre;
 * si el cartel no se pudo leer, de lo guardado en data/almacen.json al crearlo.
 */
// Radio actual del almacén: el inicial, o hasta el cofre más lejano que haya creado (crece al llenarse)
function warehouseRadius(bot) {
  let r = orgCfg.warehouseRadius
  for (const key of Object.keys(loadAssignments())) {
    const [x, y, z] = key.replace(/[()\s]/g, '').split(',').map(Number)
    if ([x, y, z].some(Number.isNaN)) continue
    r = Math.max(r, Math.ceil(new Vec3(x, y, z).distanceTo(bot.home)) + 1)
  }
  return Math.min(r, orgCfg.maxWarehouseRadius)
}

function scanWarehouse(bot) {
  const t0 = Date.now()
  const assigned = loadAssignments()
  const positions = bot.findBlocks({ matching: chestIds(bot), point: bot.home, maxDistance: warehouseRadius(bot), count: 5000 })
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
  const ms = Date.now() - t0
  if (ms > 300) console.warn(`[Organizador] ⏱️ Buscar los cofres del almacén tardó ${ms} ms (radio ${warehouseRadius(bot)}, ${positions.length} cofres)`)
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
  if (orgCfg.maxChests > 0 && warehouse.total >= orgCfg.maxChests) {
    console.warn(`[Organizador] 📦 El almacén ya tiene el máximo de ${orgCfg.maxChests} cofres (organizer.maxChests en config.js; 0 = ilimitado).`)
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
  // Los huecos donde ya falló (inaccesibles o donde no se pudo colocar) se descartan un rato,
  // para no reintentar siempre los mismos y probar otros
  if (!bot.badSpots) bot.badSpots = new Map()
  const now = Date.now()
  for (const [k, until] of bot.badSpots) if (until < now) bot.badSpots.delete(k)
  const candidates = findWarehouseSpots(bot, sameCat, p => !bot.badSpots.has(p.toString())).slice(0, SPOT_TRIES)
  for (const spot of candidates) {
    if (bot.stopped) return false
    const fail = () => bot.badSpots.set(spot.toString(), Date.now() + BAD_SPOT_MS)
    const ground = bot.blockAt(spot.offset(0, -1, 0))
    if (!await approach(bot, ground)) { fail(); continue }
    const feet = bot.entity.position.floored()
    if (feet.equals(spot) || feet.offset(0, 1, 0).equals(spot)) continue

    // 1. Cofre
    try {
      await bot.equip(bot.inventory.items().find(i => i.name === 'chest'), 'hand')
      await bot.placeBlock(ground, new Vec3(0, 1, 0))
    } catch {}
    await sleep(300)
    const chest = bot.blockAt(spot)
    if (!chest || chest.name !== 'chest') { fail(); continue }

    // 2. Cartel encima (agachado, para que el clic no abra el cofre)
    await placeSign(bot, chest, cat)
    saveAssignment(spot, cat) // por si el cartel no se pudo escribir

    if (!warehouse.byCategory.has(normalize(cat))) warehouse.byCategory.set(normalize(cat), [])
    warehouse.byCategory.get(normalize(cat)).push(chest)
    warehouse.total++
    console.log(`[Organizador] 🆕 Cofre nuevo para "${cat}" en ${fmtPos(spot)} (${warehouse.total}${orgCfg.maxChests > 0 ? '/' + orgCfg.maxChests : ''} cofres).`)
    stats.add('organizer', 'cofresCreados')
    return true
  }
  console.warn(`[Organizador] 📦 No encontré hueco para un cofre nuevo de "${cat}" (ni ampliando el almacén hasta ${orgCfg.maxWarehouseRadius} bloques).`)
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
function findWarehouseSpots(bot, sameCategoryChests, usable = () => true) {
  // Empezar por el radio actual y, si no hay hueco, ampliar en anillos hasta maxWarehouseRadius
  for (let R = warehouseRadius(bot); R <= orgCfg.maxWarehouseRadius; R += RING_STEP) {
    const spots = warehouseSpotsWithin(bot, sameCategoryChests, R).filter(usable)
    if (spots.length > 0) {
      if (R > warehouseRadius(bot)) console.log(`[Organizador] 📐 Amplío el almacén hasta ${R} bloques de radio.`)
      return spots
    }
  }
  return []
}

// Zonas donde no se ponen cofres: casas de otros bots (si no, las usarían como suyas)
function forbiddenZones(bot) {
  const zones = sourceHomes(bot).map(h => ({ pos: h.pos, r: SOURCE_CHEST_RADIUS + 2 }))
  return zones
}

function warehouseSpotsWithin(bot, sameCategoryChests, R) {
  const home = bot.home
  const spots = []
  const zones = forbiddenZones(bot)
  const forbidden = p => zones.some(z => z.square
    ? Math.abs(p.x - z.pos.x) <= z.r && Math.abs(p.z - z.pos.z) <= z.r
    : p.distanceTo(z.pos) <= z.r)

  for (let dx = -R; dx <= R; dx += 2) {
    for (let dz = -R; dz <= R; dz += 3) {
      for (let dy = -3; dy <= 3; dy++) {
        const p = home.offset(dx, dy, dz)
        if (p.distanceTo(home) > R - 0.5 || p.equals(home) || forbidden(p)) continue
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
