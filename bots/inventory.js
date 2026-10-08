// ============================================================
//  bots/inventory.js — Inventario del almacén
//  Lleva la cuenta de lo que hay en cada cofre del almacén. Se
//  actualiza cada vez que un bot abre uno (el Organizador al
//  guardar, el Artesano al sacar) y con un escaneo completo.
//  Se guarda en data/almacen_inventario.json.
// ============================================================
const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'data', 'almacen_inventario.json')

let data = load() // { chests: { "x,y,z": { cat, items: { nombre: n }, t } }, lastScan }
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

/** Sustituye todo el inventario por el contenido real leído por el plugin: [{ key: 'x,y,z', cat, items }]. */
function setLive(chests) {
  data.chests = {}
  for (const c of chests) data.chests[c.key] = { cat: c.cat, items: c.items, t: Date.now() }
  liveAt = Date.now()
  data.lastScan = liveAt
  scheduleSave()
}

/** ¿Se sabe que este cofre tiene algo que cumple test? true / false / null (no se sabe). */
function chestHas(block, test) {
  const c = data.chests[chestKey(block)]
  if (!c) return null
  return Object.keys(c.items).some(test)
}

/** Apunta el contenido de un cofre del almacén (bloque del cofre y lista de objetos de mineflayer). */
function recordChest(block, cat, items) {
  if (isLive()) return
  const totals = {}
  for (const i of items) totals[i.name] = (totals[i.name] || 0) + i.count
  data.chests[chestKey(block)] = { cat, items: totals, t: Date.now() }
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

module.exports = { recordChest, finishScan, summary, catsWith, chestKey, setLive, isLive, chestHas }
