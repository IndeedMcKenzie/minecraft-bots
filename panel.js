// ============================================================
//  panel.js — Panel de control: ejecuta los 3 bots en un solo
//  proceso y sirve la interfaz en http://127.0.0.1:<puerto>
// ============================================================
const http = require('http')
const fs = require('fs')
const net = require('net')
const path = require('path')
const util = require('util')
const cfg = require('./config')
const stats = require('./bots/stats')

const PORT = (cfg.panel && cfg.panel.port) || 3000
const MAX_LOGS = 500
const STATE_INTERVAL_MS = 2000
const SERVER_CHECK_MS = 10000

const BOT_DEFS = [
  { key: 'woodcutter', label: 'Leñador',  emoji: '🪓', file: './bots/woodcutter' },
  { key: 'miner',      label: 'Minero',   emoji: '⛏️', file: './bots/miner'      },
  { key: 'farmer',     label: 'Granjero', emoji: '🌾', file: './bots/farmer'     },
  { key: 'fisher',     label: 'Pescador', emoji: '🎣', file: './bots/fisher'     },
  { key: 'organizer',  label: 'Organizador', emoji: '🗂️', file: './bots/organizer' },
  { key: 'rancher',    label: 'Ganadero', emoji: '🐄', file: './bots/rancher'    },
]
const DEF_BY_KEY = Object.fromEntries(BOT_DEFS.map(d => [d.key, d]))

// ── Captura de logs ──────────────────────────────────────────
// Los bots escriben con console.log("[Minero] ..."): el prefijo indica de qué bot es
const PREFIX_TO_KEY = {}
for (const d of BOT_DEFS) {
  PREFIX_TO_KEY[d.label] = d.key
  PREFIX_TO_KEY[cfg.bots[d.key].username] = d.key
}

const logs = []
const activity = {}
let logSeq = 0
const sseClients = new Set()

const originalConsole = { log: console.log, warn: console.warn, error: console.error }
for (const level of ['log', 'warn', 'error']) {
  console[level] = (...args) => {
    originalConsole[level](...args)
    addLog(level, util.format(...args))
  }
}

function addLog(level, text) {
  const m = text.match(/^\[([^\]]+)\]\s*/)
  const key = m ? (PREFIX_TO_KEY[m[1]] || null) : null
  const entry = { id: ++logSeq, t: Date.now(), bot: key, level, text }
  logs.push(entry)
  if (logs.length > MAX_LOGS) logs.shift()
  if (key) activity[key] = { text: text.slice(m[0].length), t: entry.t }
  broadcast('log', entry)
}

// Con los 3 bots en el mismo proceso, un error no capturado de uno no debe tumbar a los demás
process.on('uncaughtException', (err) => console.error(`[Panel] ❌ Error no capturado: ${err.stack || err.message}`))
process.on('unhandledRejection', (err) => console.error(`[Panel] ❌ Promesa rechazada: ${err && (err.stack || err.message) || err}`))

// ── Control de bots ──────────────────────────────────────────
// Cada inicio crea un ctrl nuevo: si una instancia vieja termina después, su ctrl
// (ya deshabilitado) impide que reconecte y duplique el bot.
const ctrls = {}

function startBot(key) {
  const def = DEF_BY_KEY[key]
  if (!def || (ctrls[key] && ctrls[key].enabled)) return
  const ctrl = { enabled: true, bot: null, issue: null }
  ctrls[key] = ctrl
  console.log(`[${def.label}] ▶️ Iniciando...`)
  try {
    require(def.file).createBot(ctrl)
  } catch (err) {
    ctrl.issue = err.message
    console.error(`[${def.label}] ❌ No se pudo iniciar: ${err.message}`)
  }
}

function stopBot(key) {
  const def = DEF_BY_KEY[key]
  const ctrl = ctrls[key]
  if (!def || !ctrl || !ctrl.enabled) return
  ctrl.enabled = false
  const bot = ctrl.bot
  if (bot) {
    bot.stopped = true
    try { bot.pathfinder && bot.pathfinder.stop() } catch {}
    try { bot.quit() } catch {}
  }
  console.log(`[${def.label}] ⏹️ Detenido.`)
}

async function restartBot(key) {
  stopBot(key)
  await new Promise(r => setTimeout(r, 1500)) // dar tiempo a que el servidor cierre la sesión anterior
  startBot(key)
}

// ── Estado ───────────────────────────────────────────────────
let serverOnline = null

function checkServer() {
  const socket = net.connect({ host: cfg.server.host, port: cfg.server.port })
  const done = (ok) => { serverOnline = ok; socket.destroy() }
  socket.setTimeout(2000)
  socket.once('connect', () => done(true))
  socket.once('timeout', () => done(false))
  socket.once('error', () => done(false))
}

function savedHome(key) {
  const configured = cfg.bots[key].home || (cfg.chest && cfg.chest.position)
  if (configured) return configured
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', `home_${key}.json`), 'utf8')) } catch { return null }
}

// Inventario completo, indicando cuánto de cada objeto es reserva (se lo queda a propósito al guardar)
function inventoryInfo(bot) {
  const { getDepositableItems } = require('./bots/common')
  const rules = bot.depositRules || { keep: [], amounts: {} }
  const totals = {}
  for (const i of bot.inventory.items()) totals[i.name] = (totals[i.name] || 0) + i.count
  const items = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({
      name,
      count,
      kept: rules.keep.includes(name) ? count : Math.min(count, rules.amounts[name] || 0),
    }))
  const pending = getDepositableItems(bot, rules.keep, rules.amounts).reduce((a, i) => a + i.count, 0)
  return { items, pending }
}

function botState(def) {
  const ctrl = ctrls[def.key]
  const bot = ctrl && ctrl.bot
  let status = 'stopped'
  if (ctrl && ctrl.enabled) {
    if (bot && bot.entity && !bot.stopped) status = 'online'
    else if (bot && bot.stopped) status = 'reconnecting'
    else status = 'connecting'
  }
  const online = status === 'online'
  const home = (bot && bot.home) || savedHome(def.key)
  const inv = online ? inventoryInfo(bot) : { items: [], pending: null }

  return {
    key: def.key,
    label: def.label,
    emoji: def.emoji,
    username: cfg.bots[def.key].username,
    status,
    issue: (ctrl && ctrl.issue) || null,
    activity: activity[def.key] || null,
    health: online ? Math.round(bot.health) : null,
    food: online ? Math.round(bot.food) : null,
    pos: online ? { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) } : null,
    freeSlots: online ? bot.inventory.emptySlotCount() : null,
    items: inv.items,
    pending: inv.pending,
    lastDeposit: (bot && bot.lastDeposit) || null,
    goingHome: online && bot.pendingCommand === 'gohome',
    rescuing: online && bot.pendingCommand === 'escape',
    organizing: online && (bot.pendingCommand === 'organize' || !!bot.organizing),
    homeFull: online && !!bot.homeFull,
    homeChests: (bot && bot.homeChestCount) || null,
    maxChests: (cfg.home && cfg.home.maxChests) || 15,
    gifts: (cfg.bots[def.key].give || []).map(g => g.item.replace(/_/g, ' ') + (g.count > 1 ? ` ×${g.count}` : '')).join(', '),
    home: home ? { x: Math.floor(home.x), y: Math.floor(home.y), z: Math.floor(home.z) } : null,
  }
}

const startedAt = Date.now()
function getState() {
  return {
    server: { host: cfg.server.host, port: cfg.server.port, online: serverOnline },
    startedAt,
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    bots: BOT_DEFS.map(botState),
  }
}

function broadcast(event, data) {
  if (sseClients.size === 0) return
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) res.write(msg)
}

// ── Servidor HTTP ────────────────────────────────────────────
function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log('[Panel] ⏻ Apagando bots y panel...')
  for (const d of BOT_DEFS) stopBot(d.key)
  stats.save()
  broadcast('shutdown', {})
  setTimeout(() => process.exit(0), 1500)
}

async function handleAction(res, key, action) {
  const def = DEF_BY_KEY[key]
  if (!def) return sendJson(res, 404, { ok: false, error: 'Bot desconocido' })

  if (action === 'start') startBot(key)
  else if (action === 'stop') stopBot(key)
  else if (action === 'restart') restartBot(key)
  else if (['home', 'gohome', 'escape', 'give', 'organize'].includes(action)) {
    const bot = ctrls[key] && ctrls[key].bot
    if (!bot || !bot.entity || bot.stopped) return sendJson(res, 409, { ok: false, error: `${def.label} no está conectado` })
    const common = require('./bots/common')

    if (action === 'home') {
      const pos = common.setHomeFromNearestChest(bot)
      if (!pos) return sendJson(res, 409, { ok: false, error: `${def.label} no ve ningún cofre a menos de 8 bloques` })
      return sendJson(res, 200, { ok: true, message: `Nueva casa de ${def.label} en (${pos.x}, ${pos.y}, ${pos.z})` })
    }
    if (action === 'gohome') {
      if (!bot.home) return sendJson(res, 409, { ok: false, error: `${def.label} no tiene casa todavía: usa "Fijar casa" junto a un cofre` })
      common.requestCommand(bot, 'gohome')
      return sendJson(res, 200, { ok: true, message: `${def.label} vuelve a casa` })
    }
    if (action === 'organize') {
      if (key !== 'organizer') return sendJson(res, 400, { ok: false, error: 'Solo el Organizador organiza' })
      if (!bot.home) return sendJson(res, 409, { ok: false, error: 'El Organizador no tiene almacén: usa "Fijar casa" junto a un cofre' })
      common.requestCommand(bot, 'organize')
      return sendJson(res, 200, { ok: true, message: 'Organizador: empezando ronda de recogida y ordenación' })
    }
    if (action === 'escape') {
      common.requestCommand(bot, 'escape')
      return sendJson(res, 200, { ok: true, message: `${def.label}: iniciando rescate (subir a la superficie → casa → /tp)` })
    }
    if (action === 'give') {
      const result = await common.giveConfiguredItems(bot)
      return sendJson(res, result.ok ? 200 : 409, result.ok ? { ok: true, message: result.message } : { ok: false, error: result.message })
    }
  } else return sendJson(res, 400, { ok: false, error: 'Acción desconocida' })

  sendJson(res, 200, { ok: true })
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const parts = url.pathname.split('/').filter(Boolean)

  if (req.method === 'GET' && url.pathname === '/') {
    fs.readFile(path.join(__dirname, 'panel', 'index.html'), (err, html) => {
      if (err) { res.writeHead(500); return res.end('No se encontró panel/index.html') }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(html)
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, getState())

  if (req.method === 'GET' && url.pathname === '/api/stats') {
    return sendJson(res, 200, {
      ...stats.snapshot(),
      now: Date.now(),
      bots: BOT_DEFS.map(d => ({ key: d.key, label: d.label, emoji: d.emoji })),
    })
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    res.write(`event: init\ndata: ${JSON.stringify({ logs, state: getState() })}\n\n`)
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  if (req.method === 'POST') {
    // Cabecera propia: obliga a una comprobación CORS que este servidor nunca aprueba,
    // así ninguna web abierta en el navegador puede mandar órdenes al panel
    if (req.headers['x-panel'] !== '1') return sendJson(res, 403, { ok: false, error: 'Prohibido' })

    if (parts[0] === 'api' && parts[1] === 'bots' && parts.length === 4) return handleAction(res, parts[2], parts[3])
    if (parts[0] === 'api' && parts[1] === 'all' && parts.length === 3) {
      for (const d of BOT_DEFS) {
        if (parts[2] === 'start') startBot(d.key)
        else if (parts[2] === 'stop') stopBot(d.key)
      }
      return sendJson(res, 200, { ok: true })
    }
    if (url.pathname === '/api/shutdown') {
      sendJson(res, 200, { ok: true })
      return shutdown()
    }
  }

  sendJson(res, 404, { ok: false, error: 'No encontrado' })
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    originalConsole.error(`El puerto ${PORT} ya está en uso: probablemente el panel ya está abierto (http://127.0.0.1:${PORT}).`)
    process.exit(1)
  }
  originalConsole.error(err)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Panel] 🖥️ Panel en http://127.0.0.1:${PORT}`)
  checkServer()
  setInterval(checkServer, SERVER_CHECK_MS)
  setInterval(() => broadcast('state', getState()), STATE_INTERVAL_MS)
  // Tiempo conectado de cada bot (para las estadísticas)
  setInterval(() => {
    for (const d of BOT_DEFS) {
      const bot = ctrls[d.key] && ctrls[d.key].enabled && ctrls[d.key].bot
      if (bot && bot.entity && !bot.stopped) stats.add(d.key, 'conectadoMs', STATE_INTERVAL_MS)
    }
  }, STATE_INTERVAL_MS)
  if (!cfg.panel || cfg.panel.autoStart !== false) {
    // Escalonado para no saturar el servidor con 3 logins a la vez
    BOT_DEFS.forEach((d, i) => setTimeout(() => startBot(d.key), i * 2000))
  }
})

process.on('SIGINT', shutdown)
