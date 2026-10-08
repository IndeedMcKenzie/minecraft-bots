// ============================================================
//  bots/warehouse.js — Acceso al almacén central del organizador
//  Lo usa el Artesano para sacar materias primas:
//  localiza el almacén, lee los carteles de categoría de los cofres
//  y saca objetos concretos.
// ============================================================
const fs = require('fs')
const path = require('path')
const Vec3 = require('vec3')
const { goals: { GoalNear } } = require('mineflayer-pathfinder')
const cfg = require('../config')
const { safeGoto, inReach, teleportTo, sleep } = require('./common')
const inventory = require('./inventory')

const DATA = path.join(__dirname, '..', 'data')
const orgCfg = cfg.organizer || {}

// Para comparar carteles: sin mayúsculas ni tildes
function normalize(text) {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
}

/** Posición del almacén (la casa del organizador), o null si aún no se ha elegido. */
function warehouseHome() {
  const fixed = cfg.bots.organizer && cfg.bots.organizer.home
  if (fixed) return new Vec3(fixed.x, fixed.y, fixed.z)
  try {
    const p = JSON.parse(fs.readFileSync(path.join(DATA, 'home_organizer.json'), 'utf8'))
    return new Vec3(p.x, p.y, p.z)
  } catch {
    return null
  }
}

/** Nombre de categoría para mostrar (el de config.js) a partir del texto normalizado del cartel. */
function displayCat(key) {
  return Object.keys(orgCfg.categories || {}).find(name => normalize(name) === key) || key
}

function loadAssignments() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'almacen.json'), 'utf8')) } catch { return {} }
}

// Radio actual del almacén: el inicial, o hasta el cofre más lejano creado por el organizador
function warehouseRadius(home) {
  let r = orgCfg.warehouseRadius || 12
  for (const key of Object.keys(loadAssignments())) {
    const [x, y, z] = key.replace(/[()\s]/g, '').split(',').map(Number)
    if ([x, y, z].some(Number.isNaN)) continue
    r = Math.max(r, Math.ceil(new Vec3(x, y, z).distanceTo(home)) + 1)
  }
  return Math.min(r, orgCfg.maxWarehouseRadius || 112)
}

function chestIds(bot) {
  return ['chest', 'trapped_chest', 'barrel'].map(n => bot.registry.blocksByName[n]?.id).filter(Boolean)
}

/** Texto del cartel de un cofre (encima o en un lateral), o null. */
function signLabel(bot, chestPos) {
  for (const [x, y, z] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
    const b = bot.blockAt(chestPos.offset(x, y, z))
    if (!b || !b.name.endsWith('_sign') || typeof b.getSignText !== 'function') continue
    try {
      const line = (b.getSignText()[0] || '').split('\n').map(s => s.trim()).find(Boolean)
      if (line) return line
    } catch {}
  }
  return null
}

/** ¿Es un cofre de categoría del almacén? (tiene cartel o lo creó el organizador) */
function isWarehouseChest(bot, pos) {
  return !!(signLabel(bot, pos) || loadAssignments()[pos.toString()])
}

/** Cofres del almacén agrupados por categoría (normalizada). Requiere estar cerca del almacén. */
function categoryChests(bot, home) {
  const assigned = loadAssignments()
  const byCategory = new Map()
  const positions = bot.findBlocks({ matching: chestIds(bot), point: home, maxDistance: warehouseRadius(home), count: 5000 })
  for (const p of positions) {
    const label = signLabel(bot, p) || assigned[p.toString()]
    const chest = bot.blockAt(p)
    if (!label || !chest) continue
    const key = normalize(label)
    if (!byCategory.has(key)) byCategory.set(key, [])
    byCategory.get(key).push(chest)
  }
  return byCategory
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

const countByName = bot => bot.inventory.items().reduce((acc, i) => { acc[i.name] = (acc[i.name] || 0) + i.count; return acc }, {})

/**
 * Saca objetos del almacén. `wants` es una lista de { test(nombre) → bool, max, cats: ['Minerales', …] }.
 * Va al almacén (/tp), recorre los cofres de esas categorías y saca hasta `max` de lo que encaje.
 * Devuelve { nombre: cantidad } con lo que realmente llegó al inventario.
 */
async function fetchFromWarehouse(bot, wants, label = 'Bot') {
  const home = warehouseHome()
  if (!home) {
    console.warn(`[${label}] 🏬 No hay almacén: el Organizador aún no tiene casa.`)
    return {}
  }
  if (!await teleportTo(bot, home)) return {}

  const remaining = wants.map(w => ({ ...w, left: w.max }))
  const cats = new Set(wants.flatMap(w => (w.cats || []).map(normalize)))
  const chests = [...categoryChests(bot, home).entries()]
    .filter(([k]) => cats.size === 0 || cats.has(k))
    .flatMap(([k, list]) => list.map(chest => Object.assign(chest, { catKey: k })))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
  // Primero los cofres donde el inventario dice que está lo que se busca; los que seguro que no lo tienen, al final
  const knownRank = chest => {
    const has = inventory.chestHas(chest, name => remaining.some(r => r.test(name)))
    return has === true ? 0 : has === null ? 1 : 2
  }
  chests.sort((a, b) => knownRank(a) - knownRank(b))

  const before = countByName(bot)
  for (const chest of chests) {
    if (bot.stopped || remaining.every(r => r.left <= 0) || bot.inventory.emptySlotCount() <= 1) break
    if (!await approach(bot, chest)) continue
    try {
      const container = await openContainer(bot, chest)
      for (const item of container.containerItems()) {
        const w = remaining.find(r => r.left > 0 && r.test(item.name))
        if (!w || bot.inventory.emptySlotCount() <= 1) continue
        const n = Math.min(item.count, w.left)
        try {
          await container.withdraw(item.type, null, n)
          w.left -= n
          await sleep(120)
        } catch {}
      }
      inventory.recordChest(chest, displayCat(chest.catKey), container.containerItems())
      try { container.close() } catch {}
      await sleep(300)
    } catch {}
  }

  await sleep(800) // dejar que el servidor confirme
  const after = countByName(bot)
  const got = {}
  for (const [name, n] of Object.entries(after)) if (n > (before[name] || 0)) got[name] = n - (before[name] || 0)
  return got
}

module.exports = { warehouseHome, warehouseRadius, loadAssignments, categoryChests, isWarehouseChest, signLabel, fetchFromWarehouse, normalize, displayCat }
