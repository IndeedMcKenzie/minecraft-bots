// ============================================================
//  panel/serverlink.js — Conexión con el plugin BotHelper del servidor
//  · Estado del servidor (TPS, tiempo por tick, memoria, jugadores) cada 5 s
//  · Contenido real de los cofres del almacén (inventario en vivo)
//  · Consola: ejecutar comandos
//  Si el plugin no está o el servidor está apagado, todo queda en "sin conexión"
//  y el panel sigue funcionando como sin él.
// ============================================================
const fs = require('fs')
const cfg = require('../config')
const inventory = require('../bots/inventory')
const { warehouseHome, warehouseRadius, loadAssignments, normalize, displayCat } = require('../bots/warehouse')

const pcfg = cfg.serverPlugin || {}
const STATUS_MS = 5000
const CHESTS_MS = 30000
const LOW_TPS = 15

let token = null
let status = null
let online = false
let lowTpsSince = null
let chestsBusy = false
let chestsAt = 0

function readToken() {
  if (!token && pcfg.tokenFile) {
    try { token = fs.readFileSync(pcfg.tokenFile, 'utf8').trim() || null } catch {}
  }
  return token
}

async function call(path, body, timeoutMs = 8000) {
  if (!pcfg.url) throw new Error('Plugin no configurado (config.js → serverPlugin)')
  const key = readToken()
  if (!key) throw new Error('No encuentro la clave del plugin (¿está instalado BotHelper?)')
  let res
  try {
    res = await fetch(pcfg.url + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-Token': key, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new Error(err.name === 'TimeoutError' ? 'El servidor tardó demasiado en responder' : 'El plugin no respondió (¿servidor apagado o reiniciándose?)')
  }
  if (res.status === 403) token = null // la clave cambió: releerla la próxima vez
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.error || `Error ${res.status}`)
  return data
}

async function pollStatus() {
  try {
    status = await call('/status')
    online = true
    const tps = status.tps[0]
    lowTpsSince = tps < LOW_TPS ? (lowTpsSince || Date.now()) : null
  } catch {
    online = false
    status = null
    lowTpsSince = null
  }
}

/** Lee del plugin el contenido real de los cofres del almacén y lo pasa al inventario. */
async function refreshChests() {
  if (!online || chestsBusy) return false
  const home = warehouseHome()
  if (!home) return false
  chestsBusy = true
  try {
    const radius = warehouseRadius(home)
    const res = await call('/chests', { world: 'world', x: home.x, y: home.y, z: home.z, radius })
    const assigned = loadAssignments() // categoría de los cofres creados por el organizador (si el cartel no se lee)
    const chests = []
    for (const c of res.chests) {
      const halves = c.halves.length ? c.halves : [c.pos]
      const label = c.label || halves.map(([x, y, z]) => assigned[`(${x}, ${y}, ${z})`]).find(Boolean)
      if (!label) continue // sin cartel ni asignación: no es del almacén (p. ej. el buzón)
      // Misma clave que usa bots/inventory.js para un cofre doble: la mitad con menor x (o menor z)
      const [kx, ky, kz] = halves.slice().sort((a, b) => a[0] - b[0] || a[2] - b[2])[0]
      chests.push({ key: `${kx},${ky},${kz}`, cat: displayCat(normalize(label)), items: c.items })
    }
    inventory.setLive(chests)
    chestsAt = Date.now()
    return true
  } catch {
    return false
  } finally {
    chestsBusy = false
  }
}

/** Refresca los cofres si los datos tienen más de `maxAgeMs` (para la pestaña Almacén abierta). */
function refreshChestsIfOlder(maxAgeMs) {
  if (Date.now() - chestsAt > maxAgeMs) refreshChests()
}

/** Registro de diagnóstico del plugin: { enable?, since, player, limit } → { enabled, events } */
async function debugEvents(opts) {
  return call('/events', opts)
}

/** Búsqueda de bloques hecha por el servidor (ver BlockFinder del plugin). */
async function findBlocks(query) {
  return call('/find', query, 6000)
}

/** Teletransporta a un bot con el plugin: target { x, y, z, world? } o { to: 'Jugador' }. */
async function teleport(player, target) {
  return call('/teleport', { player, ...target })
}

/** Dibuja en BlueMap recorridos, casas y zonas de los bots (plugin 1.4). Devuelve { ok, bluemap }. */
async function updateMapMarkers(bots) {
  return call('/markers', { bots })
}

/** Datos de un jugador según el servidor (con stillSeconds y hazard si es un bot), o null. */
function playerInfo(name) {
  return (online && status && status.players.find(p => p.name === name)) || null
}

async function runCommand(command) {
  return call('/command', { command })
}

function serverInfo() {
  if (!online || !status) return { online: false }
  return {
    online: true,
    tps: status.tps,
    mspt: status.mspt,
    memory: status.memory,
    players: status.players,
    entities: status.worlds.reduce((a, w) => a + w.entities, 0),
    chunks: status.worlds.reduce((a, w) => a + w.chunks, 0),
    lowTpsSince,
  }
}

function start() {
  pollStatus().then(() => refreshChests())
  setInterval(pollStatus, STATUS_MS).unref()
  setInterval(refreshChests, CHESTS_MS).unref()
}

module.exports = { start, serverInfo, isOnline: () => online, refreshChests, refreshChestsIfOlder, runCommand, debugEvents, teleport, playerInfo, findBlocks, updateMapMarkers }
