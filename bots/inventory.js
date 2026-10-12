// ============================================================
//  bots/inventory.js — Inventario del almacén
//  Lleva la cuenta de lo que hay en cada cofre del almacén. Se
//  actualiza cada vez que un bot abre uno (el Organizador al
//  guardar, el Artesano al sacar) y con un escaneo completo.
//  Se guarda en data/almacen_inventario.json.
// ============================================================
const fs = require('fs')
const path = require('path')
const cfg = require('../config')

const FILE = path.join(__dirname, '..', 'data', 'almacen_inventario.json')

let data = load() // { chests: { "x,y,z": { cat, items: { nombre: n }, slots, t } }, lastScan }

// Objetos por pila de cada objeto (64 casi todos; 16 los carteles o los huevos; 1 las herramientas)
let itemData = null
function stackSize(name) {
  if (!itemData) { try { itemData = require('minecraft-data')(cfg.server.version).itemsByName } catch { itemData = {} } }
  return (itemData[name] && itemData[name].stackSize) || 64
}
let saveTimer = null

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return { chests: d.chests || {}, lastScan: d.lastScan || null }
  } catch {
    return { chests: {}, lastScan: null }
  }
}

function scheduleSave() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true })
      fs.writeFileSync(FILE, JSON.stringify(data))
    } catch {}
  }, 3000)
}

const keyOf = pos => `${pos.x},${pos.y},${pos.z}`

// Un cofre doble son dos bloques, pero abrir cualquiera de las dos mitades muestra el contenido entero:
// se apunta siempre con la clave de la misma mitad para no contarlo dos veces.
const DIRS = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }
const CLOCKWISE = { north: 'east', east: 'south', south: 'west', west: 'north' }
const COUNTER = { north: 'west', west: 'south', south: 'east', east: 'north' }
function chestKey(block) {
  const pos = block.position
  let props = {}
  try { props = block.getProperties() || {} } catch {}
  const dir = props.type === 'left' ? CLOCKWISE[props.facing] : props.type === 'right' ? COUNTER[props.facing] : null
  if (!dir) return keyOf(pos)
  const [dx, dz] = DIRS[dir]
  const other = { x: pos.x + dx, y: pos.y, z: pos.z + dz }
  // La mitad con menor x (y, si empatan, menor z)
  return (other.x < pos.x || (other.x === pos.x && other.z < pos.z)) ? keyOf(other) : keyOf(pos)
}

// Con el plugin BotHelper el panel recibe el contenido real de los cofres (setLive). Mientras esos datos
// estén frescos, lo que ven los bots no hace falta (y podría pisar un dato exacto con uno aproximado).
const LIVE_FRESH_MS = 2 * 60 * 1000
let liveAt = 0
const isLive = () => Date.now() - liveAt < LIVE_FRESH_MS

/** Sustituye todo el inventario por el contenido real leído por el plugin: [{ key: 'x,y,z', cat, items, slots }]. */
function setLive(chests) {
  data.chests = {}
  for (const c of chests) data.chests[c.key] = { cat: c.cat, items: c.items, slots: c.slots || null, t: Date.now() }
  liveAt = Date.now()
  data.lastScan = liveAt
  scheduleSave()
}

/**
 * ¿Le quedan huecos libres a este cofre? true / false / null (no se sabe). Solo con el inventario en vivo (dato de hace
 * ≤30 s, o de cuando un bot lo abrió después). Los huecos ocupados se calculan con las pilas llenas (lo que guarda el
 * Organizador se junta en pilas), así que puede creer que hay sitio y no haberlo, nunca al revés: un cofre que da
 * "lleno" lo está seguro. El Organizador lo usa para no abrir uno a uno los cofres llenos de una categoría.
 * Las pilas a medias no cuentan como sitio: casi todos los cofres llenos tienen alguna (37 brotes, 20 palos…) y rellenarlas
 * obligaba a abrir decenas de cofres para guardar un puñado de objetos.
 */
function hasRoomFor(block) {
  if (!isLive()) return null
  const c = data.chests[chestKey(block)]
  if (!c || !c.slots) return null
  let used = 0
  for (const [name, n] of Object.entries(c.items)) used += Math.ceil(n / stackSize(name))
  return used < c.slots
}

/** ¿Se sabe que este cofre tiene algo que cumple test? true / false / null (no se sabe). */
function chestHas(block, test) {
  const c = data.chests[chestKey(block)]
  if (!c) return null
  return Object.keys(c.items).some(test)
}

/**
 * ¿Algún cofre del almacén tiene algo que cumple test? (con el inventario en vivo: dato exacto de hace ≤30 s)
 * catOk(categoría del cofre) limita a los cofres donde se va a buscar: si no, un objeto mal colocado en otra categoría
 * hacía viajar al Artesano cada ciclo para no encontrar nada (carne cruda en "Varios").
 */
function anyChestHas(test, catOk = () => true) {
  return Object.values(data.chests).some(c => catOk(c.cat || '') && Object.keys(c.items).some(test))
}

/**
 * Apunta el contenido de un cofre del almacén (bloque del cofre, lista de objetos de mineflayer y sus huecos). También
 * con el inventario en vivo: lo que ve el bot al abrirlo es lo más reciente (p. ej. que lo acaba de llenar) hasta que el
 * plugin vuelva a leerlo.
 */
function recordChest(block, cat, items, slots = null) {
  const totals = {}
  for (const i of items) totals[i.name] = (totals[i.name] || 0) + i.count
  const key = chestKey(block)
  const prev = data.chests[key]
  data.chests[key] = { cat, items: totals, slots: slots || (prev && prev.slots) || null, t: Date.now() }
  scheduleSave()
}

/** Tras un escaneo completo: olvida los cofres que ya no existen y apunta la hora. */
function finishScan(existingChests) {
  const keep = new Set(existingChests.map(chestKey))
  for (const k of Object.keys(data.chests)) if (!keep.has(k)) delete data.chests[k]
  data.lastScan = Date.now()
  scheduleSave()
}

/** Totales por objeto, con sus categorías y en cuántos cofres está. */
function summary() {
  const byItem = {}
  const chests = Object.values(data.chests)
  for (const c of chests) {
    for (const [name, n] of Object.entries(c.items)) {
      const e = byItem[name] || (byItem[name] = { name, count: 0, cats: new Set(), chests: 0 })
      e.count += n
      e.chests++
      if (c.cat) e.cats.add(c.cat)
    }
  }
  const items = Object.values(byItem)
    .map(e => ({ ...e, cats: [...e.cats] }))
    .sort((a, b) => b.count - a.count)
  const times = chests.map(c => c.t)
  return {
    items,
    chests: chests.length,
    lastScan: data.lastScan,
    oldest: times.length ? Math.min(...times) : null,
    newest: times.length ? Math.max(...times) : null,
    live: isLive(),
  }
}

/** Categorías (del cartel) de los cofres donde se vio un objeto. */
function catsWith(itemName) {
  return [...new Set(Object.values(data.chests).filter(c => c.items[itemName]).map(c => c.cat).filter(Boolean))]
}

module.exports = { recordChest, finishScan, summary, catsWith, chestKey, setLive, isLive, chestHas, anyChestHas, hasRoomFor }
