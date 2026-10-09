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
const { createAlerts } = require('./panel/alerts')
const inventory = require('./bots/inventory')
const serverlink = require('./panel/serverlink')

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
  { key: 'artisan',    label: 'Artesano', emoji: '🛠️', file: './bots/artisan'    },
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

// ── Alertas ──────────────────────────────────────────────────
function statusOf(key) {
  const ctrl = ctrls[key]
  const bot = ctrl && ctrl.bot
  if (!ctrl || !ctrl.enabled) return 'stopped'
  if (bot && bot.entity && !bot.stopped) return 'online'
  return bot && bot.stopped ? 'reconnecting' : 'connecting'
}

const alerts = createAlerts({
  keys: BOT_DEFS.map(d => d.key),
  getInfo: key => {
    const ctrl = ctrls[key]
    const bot = ctrl && ctrl.bot
    return { status: statusOf(key), enabled: !!(ctrl && ctrl.enabled), bot, issue: ctrl && ctrl.issue, homeFull: !!(bot && bot.homeFull) }
  },
  // Cada alerta nueva o resuelta queda también en el registro del bot
  onChange: (key, alert, appeared) => {
    const label = DEF_BY_KEY[key].label
    if (appeared) {
      console.warn(`[${label}] 🚨 Alerta: ${alert.text}`)
      notifyDiscord(`${alert.level === 'err' ? '🚨' : '⚠️'} ${DEF_BY_KEY[key].emoji} ${label}: ${alert.text}`)
    } else console.log(`[${label}] ✅ Resuelto: ${alert.text}`)
  },
})
const evaluateAlerts = () => { for (const d of BOT_DEFS) alerts.evaluate(d.key) }

// Alertas del propio servidor (necesitan el plugin BotHelper)
function serverAlerts() {
  const info = serverlink.serverInfo()
  const out = []
  if (info.online && info.lowTpsSince && Date.now() - info.lowTpsSince >= 60000) {
    out.push({ id: 'tps', level: 'warn', since: info.lowTpsSince, text: `El servidor va lento: ${info.tps[0]} TPS (lo normal es 20)` })
  }
  return out
}

// ── Alertas a Discord (DiscordSRV, vía la consola del plugin) ──
const discordSent = []          // horas de los últimos envíos (para el tope por hora)
const discordRecent = new Map() // texto → hora (no repetir el mismo aviso en 30 min)
function notifyDiscord(text) {
  const n = cfg.notifications || {}
  if (!n.discord || !serverlink.isOnline()) return
  const now = Date.now()
  while (discordSent.length && now - discordSent[0] > 3600000) discordSent.shift()
  if (discordSent.length >= (n.discordMaxPerHour || 20)) return
  if (discordRecent.has(text) && now - discordRecent.get(text) < 30 * 60000) return
  discordSent.push(now)
  discordRecent.set(text, now)
  const clean = text.replace(/[\r\n]+/g, ' ').slice(0, 300)
  serverlink.runCommand(`discord broadcast ${clean}`).catch(() => {})
}

// ── Rescate desde el servidor (plugin BotHelper) ─────────────
// El servidor sabe con certeza si un bot está en lava/fuego/asfixiándose, y cuánto lleva sin moverse aunque
// se reconecte (el detector de atascos del bot se reinicia al reconectar y no ve el caso de la roca madre).
const HAZARD_ES = { LAVA: 'lava', FIRE: 'fuego', FIRE_TICK: 'fuego', SUFFOCATION: 'asfixia dentro de un bloque', DROWNING: 'ahogándose' }
const lastRescue = {}
async function serverRescueCheck() {
  const rc = cfg.serverRescue || {}
  if (!rc.enabled || !serverlink.isOnline()) return
  const common = require('./bots/common')
  const now = Date.now()
  for (const d of BOT_DEFS) {
    const bot = onlineBot(d.key)
    if (!bot || !bot.home || bot.pendingCommand) continue
    if (lastRescue[d.key] && now - lastRescue[d.key] < 3 * 60000) continue
    const info = serverlink.playerInfo(bot.username)
    if (!info) continue
    const farFromHome = bot.entity.position.distanceTo(bot.home) > 8
    let reason = null
    if (info.hazard) reason = `en peligro (${HAZARD_ES[info.hazard] || info.hazard})`
    else if (cfg.bots[d.key].stuckWatch && farFromHome && !bot.idle && info.stillSeconds >= (rc.stillMinutes || 4) * 60) {
      reason = `quieto ${Math.round(info.stillSeconds / 60)} min lejos de casa`
    }
    if (!reason) continue
    lastRescue[d.key] = now
    console.warn(`[${d.label}] 🆘 El servidor me ve ${reason}: me devuelve a casa.`)
    stats.add(d.key, 'atascos')
    // Que no vuelva enseguida a lo que perseguía
    if (bot.currentTarget) common.markBad(bot, bot.currentTarget, 15 * 60000, true)
    try { bot.pathfinder.setGoal(null) } catch {}
    try {
      const r = await serverlink.teleport(bot.username, { x: bot.home.x + 0.5, y: bot.home.y + 1, z: bot.home.z + 0.5 })
      if (!r.ok) console.warn(`[${d.label}] 🆘 El rescate falló: ${r.error || 'sin motivo'}`)
    } catch (err) {
      console.warn(`[${d.label}] 🆘 El rescate falló: ${err.message}`)
    }
  }
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
  const status = statusOf(def.key)
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
    pos: online ? { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) } : null,
    freeSlots: online ? bot.inventory.emptySlotCount() : null,
    items: inv.items,
    pending: inv.pending,
    lastDeposit: (bot && bot.lastDeposit) || null,
    goingHome: online && bot.pendingCommand === 'gohome',
    rescuing: online && bot.pendingCommand === 'escape',
    organizing: online && (bot.pendingCommand === 'organize' || !!bot.organizing),
    homeFull: online && !!bot.homeFull,
    alerts: alerts.current(def.key),
    homeChests: (bot && bot.homeChestCount) || null,
    maxChests: (cfg.home && cfg.home.maxChests) || 15,
    gifts: (cfg.bots[def.key].give || []).map(g => g.item.replace(/_/g, ' ') + (g.count > 1 ? ` ×${g.count}` : '')).join(', '),
    home: home ? { x: Math.floor(home.x), y: Math.floor(home.y), z: Math.floor(home.z) } : null,
  }
}

const startedAt = Date.now()

// Retraso del bucle del panel (lo que tardan en atenderse los timers): con los 6 bots en este proceso,
// un retraso alto significa que ningún bot puede reaccionar ni enviar nada mientras dura
const { monitorEventLoopDelay } = require('perf_hooks')
const loopDelay = monitorEventLoopDelay({ resolution: 20 })
loopDelay.enable()
let loopStats = null
setInterval(() => {
  const ms = n => Math.round(n / 1e6)
  loopStats = { p50: ms(loopDelay.percentile(50)), p95: ms(loopDelay.percentile(95)), p99: ms(loopDelay.percentile(99)), max: ms(loopDelay.max), at: Date.now() }
  loopDelay.reset()
}, 60000).unref()
function getState() {
  return {
    server: { host: cfg.server.host, port: cfg.server.port, online: serverOnline, plugin: serverlink.serverInfo() },
    serverAlerts: serverAlerts(),
    startedAt,
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    loopDelay: loopStats, // retraso del panel en el último minuto (ms)
    map: (cfg.panel && cfg.panel.bluemapUrl) || null,
    bots: BOT_DEFS.map(botState),
  }
}

function broadcast(event, data) {
  if (sseClients.size === 0) return
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) res.write(msg)
}

// ── Almacén: inventario y pedidos ────────────────────────────
const BOT_USERNAMES = new Set(BOT_DEFS.map(d => cfg.bots[d.key].username))
const MAX_REQUEST = 27 * 64 // un inventario lleno como mucho

function onlineBot(key) {
  const bot = ctrls[key] && ctrls[key].enabled && ctrls[key].bot
  return bot && bot.entity && !bot.stopped ? bot : null
}

// Jugadores conectados que no son bots (los ve cualquier bot conectado)
function onlinePlayers() {
  const bot = BOT_DEFS.map(d => onlineBot(d.key)).find(Boolean)
  return bot ? Object.keys(bot.players).filter(n => !BOT_USERNAMES.has(n)).sort() : []
}

function warehouseState() {
  // Con el plugin, el contenido se lee directamente de los cofres (como mucho cada 10 s mientras se mira)
  if (serverlink.isOnline()) serverlink.refreshChestsIfOlder(10000)
  const org = onlineBot('organizer')
  const req = org && (org.delivering || org.pendingRequest)
  return {
    ...inventory.summary(),
    players: onlinePlayers(),
    organizer: {
      online: !!org,
      hasHome: !!(org && org.home),
      scanning: !!(org && (org.scanning || org.pendingCommand === 'scan')),
      organizing: !!(org && (org.organizing || org.pendingCommand === 'organize')),
      request: req ? { item: req.item, count: req.count, player: req.player, started: !!org.delivering } : null,
    },
    plugin: serverlink.isOnline(),
  }
}

function readJson(req, limit = 4096) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > limit) { resolve(null); req.destroy() }
    })
    req.on('end', () => { try { resolve(JSON.parse(body)) } catch { resolve(null) } })
  })
}

async function handleWarehouse(req, res, action) {
  // Con el plugin, "Revisar almacén" es instantáneo y no necesita al Organizador
  if (action === 'scan' && serverlink.isOnline()) {
    const ok = await serverlink.refreshChests()
    return sendJson(res, ok ? 200 : 502, ok ? { ok: true, message: 'Almacén actualizado (leído directamente del servidor)' } : { ok: false, error: 'El plugin no pudo leer los cofres' })
  }
  const org = onlineBot('organizer')
  if (!org) return sendJson(res, 409, { ok: false, error: 'El Organizador no está conectado' })
  if (!org.home) return sendJson(res, 409, { ok: false, error: 'El Organizador no tiene almacén: usa "Fijar casa" junto a un cofre' })
  const common = require('./bots/common')

  if (action === 'scan') {
    if (org.delivering || org.pendingRequest) return sendJson(res, 409, { ok: false, error: 'El Organizador está con un pedido; espera a que termine' })
    common.requestCommand(org, 'scan')
    return sendJson(res, 200, { ok: true, message: 'Organizador: revisando todos los cofres del almacén' })
  }
  if (action === 'request') {
    const body = await readJson(req)
    const item = body && String(body.item || '')
    const count = body && Math.floor(Number(body.count))
    const player = body && String(body.player || '')
    if (!/^[a-z0-9_]{1,64}$/.test(item)) return sendJson(res, 400, { ok: false, error: 'Objeto no válido' })
    if (!(count >= 1 && count <= MAX_REQUEST)) return sendJson(res, 400, { ok: false, error: `Cantidad entre 1 y ${MAX_REQUEST}` })
    if (!onlinePlayers().includes(player)) return sendJson(res, 409, { ok: false, error: 'Ese jugador no está conectado al servidor' })
    if (org.delivering || org.pendingRequest) return sendJson(res, 409, { ok: false, error: 'El Organizador ya está con otro pedido; espera a que termine' })
    org.pendingRequest = { item, count, player }
    common.requestCommand(org, 'request')
    return sendJson(res, 200, { ok: true, message: `Pedido en marcha: ${count} × ${item.replace(/_/g, ' ')} para ${player}` })
  }
  sendJson(res, 400, { ok: false, error: 'Acción desconocida' })
}

// ── Consola del servidor (plugin BotHelper) ──────────────────
async function handleConsole(req, res) {
  if (!serverlink.isOnline()) return sendJson(res, 409, { ok: false, error: 'El plugin BotHelper no está conectado' })
  const body = await readJson(req)
  const command = body && String(body.command || '').trim()
  if (!command || command.length > 500) return sendJson(res, 400, { ok: false, error: 'Comando vacío o demasiado largo' })
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  console.log(`[Panel] 🖥️ Consola (${ip}): /${command.replace(/^\//, '')}`)
  try {
    const r = await serverlink.runCommand(command)
    return sendJson(res, 200, { ok: true, known: r.known !== false, output: r.output || [] })
  } catch (err) {
    // Un comando mal escrito no es un fallo del plugin: se muestra como lo haría la consola del servidor
    const syntax = err.message.match(/^CommandSyntaxException: (.*)$/s)
    if (syntax) return sendJson(res, 200, { ok: true, known: true, output: [], syntaxError: syntax[1] })
    return sendJson(res, 502, { ok: false, error: err.message })
  }
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

// Quién puede usar el panel: este PC siempre; desde la red, solo las IPs de panel.allowedIps
const ALLOWED_IPS = new Set((cfg.panel && cfg.panel.allowedIps) || [])
// Las IPs del propio PC (p. ej. abrir http://192.168.1.10:3000 desde aquí mismo)
const OWN_IPS = new Set(Object.values(require('os').networkInterfaces()).flat().filter(Boolean).map(i => i.address))
function clientAllowed(req) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
  return ip === '127.0.0.1' || ip === '::1' || OWN_IPS.has(ip) || ALLOWED_IPS.has(ip)
}

const server = http.createServer((req, res) => {
  if (!clientAllowed(req)) {
    console.warn(`[Panel] ⛔ Acceso denegado desde ${req.socket.remoteAddress} (no está en panel.allowedIps)`)
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end('Acceso denegado: este equipo no está autorizado en config.js (panel.allowedIps).')
  }
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

  if (req.method === 'GET' && url.pathname === '/api/warehouse') return sendJson(res, 200, warehouseState())

  // Registro de diagnóstico del plugin: /api/debug?player=Bot_Minero&since=<ms>&limit=200
  if (req.method === 'GET' && url.pathname === '/api/debug') {
    if (!serverlink.isOnline()) return sendJson(res, 409, { ok: false, error: 'El plugin BotHelper no está conectado' })
    const q = url.searchParams
    serverlink.debugEvents({ since: Number(q.get('since')) || 0, player: q.get('player') || null, limit: Number(q.get('limit')) || 200 })
      .then(r => sendJson(res, 200, r)).catch(err => sendJson(res, 502, { ok: false, error: err.message }))
    return
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
    if (parts[0] === 'api' && parts[1] === 'warehouse' && parts.length === 3) return handleWarehouse(req, res, parts[2])
    if (url.pathname === '/api/console') return handleConsole(req, res)
    if (url.pathname === '/api/debug') {
      if (!serverlink.isOnline()) return sendJson(res, 409, { ok: false, error: 'El plugin BotHelper no está conectado' })
      return readJson(req).then(body => serverlink.debugEvents({ enable: !!(body && body.enable), limit: 1 }))
        .then(r => { console.log(`[Panel] 🔬 Registro de diagnóstico ${r.enabled ? 'activado' : 'desactivado'}.`); sendJson(res, 200, { ok: true, enabled: r.enabled, message: `Diagnóstico ${r.enabled ? 'activado' : 'desactivado'}` }) })
        .catch(err => sendJson(res, 502, { ok: false, error: err.message }))
    }
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

const HOST = (cfg.panel && cfg.panel.host) || '127.0.0.1'
server.listen(PORT, HOST, () => {
  console.log(`[Panel] 🖥️ Panel en http://127.0.0.1:${PORT}`)
  if (HOST !== '127.0.0.1') {
    const lan = Object.values(require('os').networkInterfaces()).flat()
      .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${PORT}`)
    console.log(`[Panel] 🌐 En la red: ${lan.join(' · ')} (permitido desde: ${[...ALLOWED_IPS].join(', ') || 'nadie más'})`)
  }
  checkServer()
  setInterval(checkServer, SERVER_CHECK_MS)
  serverlink.start()
  // Medidor de bloqueos: los 6 bots comparten este proceso; si se queda congelado, ninguno envía nada
  let lastBeat = Date.now()
  setInterval(() => {
    const lag = Date.now() - lastBeat - 250
    if (lag > 1000) console.warn(`[Panel] ⏱️ El panel estuvo bloqueado ${(lag / 1000).toFixed(1)} s (los bots no pudieron enviar nada en ese tiempo)`)
    lastBeat = Date.now()
  }, 250)
  setInterval(() => broadcast('state', getState()), STATE_INTERVAL_MS)
  setInterval(evaluateAlerts, 10000)
  setInterval(serverRescueCheck, 10000)
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
