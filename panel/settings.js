// ============================================================
//  panel/settings.js — Ajustes que se cambian desde el panel
//  Lista cerrada de valores de config.js que se pueden cambiar en vivo (pestaña ⚙️ Ajustes). Los cambios se
//  guardan en data/settings.json y se aplican encima de config.js al arrancar: config.js sigue siendo la base
//  y "Restablecer" vuelve a su valor. Los bots leen estos valores en cada uso, así que no hace falta reiniciar.
// ============================================================
const fs = require('fs')
const path = require('path')
const cfg = require('../config')

const FILE = path.join(__dirname, '..', 'data', 'settings.json')

// Familias de mineral que el Minero puede buscar, en el orden por defecto (la primera es la más importante)
const ORE_FAMILIES = ['diamond', 'emerald', 'gold', 'iron', 'coal', 'copper', 'lapis', 'redstone']
const ORE_LABELS = { diamond: 'Diamante', emerald: 'Esmeralda', gold: 'Oro', iron: 'Hierro', coal: 'Carbón', copper: 'Cobre', lapis: 'Lapislázuli', redstone: 'Redstone' }

const SCHEMA = [
  { path: 'search.woodRadius', group: '🪓 Leñador', label: 'Radio de búsqueda de árboles', type: 'int', min: 16, max: 128, unit: 'bloques',
    help: 'Más radio encuentra árboles más lejos, pero cada búsqueda cuesta algo más al servidor.' },
  { path: 'search.mineRadius', group: '⛏️ Minero', label: 'Radio de búsqueda de minerales', type: 'int', min: 16, max: 128, unit: 'bloques',
    help: 'El Minero solo ve los minerales de los chunks que tiene cargados (unos 80 bloques).' },
  { path: 'miner.ores', group: '⛏️ Minero', label: 'Minerales que busca y su prioridad', type: 'ores',
    help: 'Marca los que quieres que mine y ordénalos: siempre va primero a por el de más arriba que tenga cerca.' },
  { path: 'search.farmRadius', group: '🌾 Granjero', label: 'Tamaño de la granja (radio desde su casa o su zona)', type: 'int', min: 8, max: 64, unit: 'bloques',
    help: 'Cosecha y siembra hasta esta distancia. Más de 64 bloques quedaría fuera de lo que el Granjero ve.' },
  { path: 'farm.autoCreate', group: '🌾 Granjero', label: 'Ampliar la granja junto al agua', type: 'bool',
    help: 'Si tiene semillas, ara tierra nueva junto al agua dentro de su radio.' },
  { path: 'farm.compost', group: '🌾 Granjero', label: 'Compostera: semillas sobrantes → harina de huesos', type: 'bool',
    help: 'Echa en una compostera junto a su casa las semillas que sobran (también las del almacén) y usa la harina de huesos para que los cultivos crezcan antes.' },
  { path: 'organizer.intervalMinutes', group: '🗂️ Organizador', label: 'Cada cuánto hace una ronda', type: 'int', min: 5, max: 120, unit: 'min',
    help: 'Recoge lo guardado en las casas de los demás y lo ordena en el almacén. Se aplica desde la próxima ronda.' },
  { path: 'home.teleportDistance', group: '🏠 Todos los bots', label: 'Ir y volver de casa con /tp a partir de', type: 'int', min: 50, max: 2000, unit: 'bloques',
    help: 'Más cerca, caminan; más lejos (o si están bajo tierra), se teletransportan a casa y de vuelta a donde trabajaban.' },
  { path: 'home.returnWhenFreeSlots', group: '🏠 Todos los bots', label: 'Volver a guardar cuando queden', type: 'int', min: 1, max: 12, unit: 'huecos libres',
    help: 'Con más huecos vuelven antes a casa (viajes más cortos pero más frecuentes).' },
  { path: 'serverRescue.enabled', group: '🆘 Rescate', label: 'Rescate desde el servidor', type: 'bool',
    help: 'El plugin devuelve a casa a un bot en lava, fuego, asfixia o quieto demasiado tiempo lejos de casa.' },
  { path: 'serverRescue.stillMinutes', group: '🆘 Rescate', label: 'Minutos quieto lejos de casa para rescatarlo', type: 'int', min: 2, max: 30, unit: 'min',
    help: 'Solo Leñador y Minero.' },
  { path: 'notifications.discord', group: '🔔 Avisos', label: 'Mandar las alertas a Discord', type: 'bool', help: 'A través de DiscordSRV.' },
  { path: 'notifications.discordMaxPerHour', group: '🔔 Avisos', label: 'Máximo de avisos a Discord por hora', type: 'int', min: 1, max: 60, unit: 'por hora',
    help: 'El mismo aviso no se repite en 30 minutos.' },
]
const BY_PATH = Object.fromEntries(SCHEMA.map(s => [s.path, s]))

function getPath(obj, p) {
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}
function setPath(obj, p, value) {
  const keys = p.split('.')
  let o = obj
  for (const k of keys.slice(0, -1)) o = o[k] || (o[k] = {})
  o[keys[keys.length - 1]] = value
}

// Valores de config.js antes de aplicar nada (para "Restablecer")
const DEFAULTS = Object.fromEntries(SCHEMA.map(s => [s.path, clone(getPath(cfg, s.path))]))
DEFAULTS['miner.ores'] = DEFAULTS['miner.ores'] || ORE_FAMILIES.slice()
function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)) }

let overrides = {}

/** Comprueba y normaliza un valor; devuelve { value } o { error }. */
function validate(item, value) {
  if (item.type === 'bool') {
    if (typeof value !== 'boolean') return { error: 'Debe ser sí o no' }
    return { value }
  }
  if (item.type === 'int') {
    const n = Number(value)
    if (!Number.isFinite(n) || Math.round(n) !== n) return { error: 'Debe ser un número entero' }
    if (n < item.min || n > item.max) return { error: `Entre ${item.min} y ${item.max}` }
    return { value: n }
  }
  if (item.type === 'ores') {
    if (!Array.isArray(value)) return { error: 'Lista no válida' }
    const list = [...new Set(value.map(String))].filter(v => ORE_FAMILIES.includes(v))
    if (list.length === 0) return { error: 'Marca al menos un mineral' }
    return { value: list }
  }
  return { error: 'Tipo desconocido' }
}

function load() {
  try { overrides = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {} } catch { overrides = {} }
  for (const [p, v] of Object.entries(overrides)) {
    const item = BY_PATH[p]
    const r = item ? validate(item, v) : { error: 'desconocido' }
    if (r.error) { delete overrides[p]; continue }
    setPath(cfg, p, r.value)
  }
  if (getPath(cfg, 'miner.ores') == null) setPath(cfg, 'miner.ores', ORE_FAMILIES.slice())
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(overrides, null, 2))
  } catch {}
}

/** Lista para el panel: cada ajuste con su valor actual y el de config.js. */
function list() {
  return SCHEMA.map(s => ({
    ...s,
    value: clone(getPath(cfg, s.path)),
    default: clone(DEFAULTS[s.path]),
    changed: Object.prototype.hasOwnProperty.call(overrides, s.path),
    ...(s.type === 'ores' ? { options: ORE_FAMILIES.map(k => ({ key: k, label: ORE_LABELS[k] })) } : {}),
  }))
}

/** Cambia un ajuste (value === null: volver al valor de config.js). Devuelve { ok, error?, label, value }. */
function update(p, value) {
  const item = BY_PATH[p]
  if (!item) return { ok: false, error: 'Ajuste desconocido' }
  if (value === null) {
    delete overrides[p]
    setPath(cfg, p, clone(DEFAULTS[p]))
  } else {
    const r = validate(item, value)
    if (r.error) return { ok: false, error: `${item.label}: ${r.error}` }
    overrides[p] = r.value
    setPath(cfg, p, r.value)
  }
  save()
  return { ok: true, label: item.label, value: getPath(cfg, p) }
}

load()

module.exports = { list, update, ORE_FAMILIES }
