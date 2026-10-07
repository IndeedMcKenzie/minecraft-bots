// ============================================================
//  bots/common.js — Módulo compartido para todos los bots
// ============================================================
const fs = require('fs')
const path = require('path')
const Vec3 = require('vec3')
const { Movements, goals: { GoalNear, GoalNearXZ, GoalY } } = require('mineflayer-pathfinder')
const cfg = require('../config')
const stats = require('./stats')

const BAD_BLOCK_MS = 5 * 60 * 1000   // Tiempo que un bloque inalcanzable queda ignorado
const STUCK_ZONE_MS = 30 * 60 * 1000 // Tiempo que una zona donde se atascó queda prohibida
const STUCK_ZONE_RADIUS = 10         // Radio de esa zona prohibida
const CHEST_RETRY_MS = 60 * 1000     // Espera antes de reintentar guardar/sacar del cofre tras un fallo
const REACH = 4.5                    // Alcance de interacción en supervivencia (1.21)
const TRAVEL_SEGMENT = 48            // Longitud de cada tramo al viajar lejos (dentro de chunks cargados)
const HOMES_DIR = path.join(__dirname, '..', 'data')

const homeCfg = Object.assign({
  returnWhenFreeSlots: 2, returnToWorkSpot: true, chestRadius: 6, maxTravelMinutes: 3, autoChests: true, maxChests: 15,
}, cfg.home)
const CHEST_FULL_RETRY_MS = 5 * 60 * 1000 // Con los cofres de casa llenos, no volver a intentarlo enseguida
const stuckCfg = Object.assign({ detectSeconds: 90, allowTeleport: true, repeatMinutes: 10 }, cfg.stuck)

// Bloques que el bot puede ponerse bajo los pies para subir (el pathfinder por defecto solo usa tierra y adoquín)
const SCAFFOLD_ITEMS = [
  'cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'deepslate',
  'andesite', 'diorite', 'granite', 'tuff',
]
const PICKAXES = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'golden_pickaxe', 'stone_pickaxe', 'wooden_pickaxe']

// Opciones de conexión comunes para mineflayer.createBot
function botOptions(botKey) {
  return {
    host:         cfg.server.host,
    port:         cfg.server.port,
    username:     cfg.bots[botKey].username,
    version:      cfg.server.version,
    auth:         cfg.server.auth,
    viewDistance: cfg.bots[botKey].viewDistance || cfg.server.viewDistance || 'short',
  }
}

/**
 * ctrl (opcional) lo usa el panel para controlar el bot: ctrl.enabled = false impide reconectar,
 * ctrl.bot apunta a la instancia actual y ctrl.issue guarda el último motivo de desconexión.
 */
// Bots conectados en este proceso (el organizador lo usa para no vaciar cofres mientras su dueño guarda)
const activeBots = new Set()

function setupBot(bot, name, reconnectFn, botKey, ctrl = {}) {
  // bot.stopped = true cuando la conexión termina: los bucles de trabajo deben salir
  bot.stopped = false
  bot.badBlocks = new Map()
  bot.stuckZones = [] // { pos, until }: zonas donde se atascó; sus objetivos se ignoran un rato
  bot.label = name
  bot.botKey = botKey
  ctrl.bot = bot
  activeBots.add(bot)
  bot.once('end', () => activeBots.delete(bot))

  let reconnectScheduled = false
  function scheduleReconnect() {
    bot.stopped = true
    if (reconnectScheduled || ctrl.enabled === false) return
    reconnectScheduled = true
    if (cfg.reconnect.enabled && typeof reconnectFn === 'function') {
      console.log(`[${name}] 🔄 Reconectando en ${cfg.reconnect.delayMs / 1000}s...`)
      setTimeout(() => { if (ctrl.enabled !== false) reconnectFn() }, cfg.reconnect.delayMs)
    }
  }

  bot.once('spawn', () => {
    ctrl.issue = null
    if (bot.pathfinder) {
      const mcData = require('minecraft-data')(bot.version)
      const movements = new Movements(bot, mcData)
      movements.canDig = true
      movements.digCost = 10
      movements.allowParkour = false
      movements.allow1by1towers = false // solo se activan durante un rescate
      movements.scafoldingBlocks = SCAFFOLD_ITEMS.map(n => mcData.itemsByName[n]?.id).filter(Boolean)
      bot.pathfinder.setMovements(movements)
      // Presupuesto de CPU por tick para calcular rutas (el cálculo de rutas es lo que más CPU gasta).
      // Los bots que recorren terreno difícil necesitan más: con poco, calculan rutas a trozos y "dudan".
      bot.pathfinder.tickTimeout = (botKey && cfg.bots[botKey]?.pathfinderTickMs) ||
        (cfg.performance && cfg.performance.pathfinderTickMs) || 20
    }

    if (botKey && cfg.bots[botKey]?.stuckWatch) startStuckWatch(bot)

    if (bot.autoEat && typeof bot.autoEat.enableAuto === 'function') {
      try { bot.autoEat.enableAuto() } catch {}
    }

    if (Array.isArray(cfg.starterCommands) && cfg.starterCommands.length > 0) {
      setTimeout(() => {
        if (bot.stopped) return
        for (const cmd of cfg.starterCommands) {
          const resolved = cmd.replace('{username}', bot.username)
          bot.chat(resolved)
        }
      }, 3000)
    }

    // Esperar a que carguen los chunks antes de buscar el cofre de casa
    setTimeout(() => { if (!bot.stopped) initHome(bot) }, 2000)
  })

  bot.on('chat', (username, message) => handleChatCommand(bot, username, message))
  bot.on('death', () => {
    console.log(`[${name}] 💀 He muerto.`)
    stats.add(botKey, 'muertes')
  })

  bot.on('error', (err) => {
    console.error(`[${name}] ❌ Error: ${err.message}`)
    ctrl.issue = err.message
    // Si no se pudo conectar puede que no llegue 'end'; el guard evita reconexiones dobles
    if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(err.code)) scheduleReconnect()
  })
  // 'kicked' siempre va seguido de 'end', así que solo se reconecta desde 'end'
  bot.on('kicked', (reason) => {
    let msg = reason
    try { msg = JSON.stringify(reason) } catch {}
    console.log(`[${name}] ⚠️ Expulsado: ${msg}`)
    ctrl.issue = `Expulsado: ${msg}`
    stats.add(botKey, 'expulsiones')
  })
  bot.on('end', () => {
    console.log(`[${name}] 🔌 Conexión finalizada.`)
    scheduleReconnect()
  })
}

// ── Lista negra temporal de bloques (inalcanzables o que fallan) ──
function markBad(bot, pos, ms = BAD_BLOCK_MS, force = false) {
  // Si el fallo se debe a que una orden del panel interrumpió la tarea, el bloque no tiene la culpa
  if (bot.pendingCommand && !force) return
  bot.badBlocks.set(pos.toString(), Date.now() + ms)
}

// ¿Está pos cerca de un sitio donde el bot se atascó hace poco?
function inStuckZone(bot, pos) {
  const now = Date.now()
  bot.stuckZones = bot.stuckZones.filter(z => z.until > now)
  return bot.stuckZones.some(z => z.pos.distanceTo(pos) <= STUCK_ZONE_RADIUS)
}

function isBad(bot, pos) {
  const key = pos.toString()
  const expires = bot.badBlocks.get(key)
  if (!expires) return false
  if (Date.now() > expires) { bot.badBlocks.delete(key); return false }
  return true
}

function inReach(bot, block) {
  if (!block || !bot.entity) return false
  return block.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.62, 0)) <= REACH
}

function safeGoto(bot, goal, minTimeoutSeconds = 25) {
  return new Promise((resolve) => {
    if (bot.stopped || !bot.entity) return resolve(false)
    // Hay una orden pendiente: abandonar la tarea actual para atenderla cuanto antes
    if (bot.pendingCommand && !bot.commandRunning) return resolve(false)

    let finished = false
    let timeoutMs = minTimeoutSeconds * 1000

    if (goal) {
      const gx = goal.x ?? goal.target?.x
      const gy = goal.y ?? goal.target?.y
      const gz = goal.z ?? goal.target?.z
      if (gx !== undefined && gz !== undefined) {
        const dist = bot.entity.position.distanceTo({ x: gx, y: gy ?? bot.entity.position.y, z: gz })
        timeoutMs = Math.max(minTimeoutSeconds * 1000, Math.ceil(dist * 2000))
      }
    }

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true
        try { bot.pathfinder.stop() } catch {}
        resolve(false)
      }
    }, timeoutMs)

    try {
      bot.pathfinder.goto(goal)
        .then(() => {
          // goto() también "resuelve" cuando la ruta calculada está vacía, que puede significar
          // "no puedo moverme" (encerrado, sin herramienta). Solo cuenta si de verdad está en el objetivo.
          if (!finished) { finished = true; clearTimeout(timer); resolve(isAtGoal(bot, goal)) }
        })
        .catch(() => {
          if (!finished) { finished = true; clearTimeout(timer); resolve(false) }
        })
    } catch (e) {
      if (!finished) { finished = true; clearTimeout(timer); resolve(false) }
    }
  })
}

function isAtGoal(bot, goal) {
  if (!bot.entity || typeof goal.isEnd !== 'function') return true
  try { return goal.isEnd(bot.entity.position.floored()) } catch { return true }
}

function distXZ(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

/**
 * Viaje de larga distancia: avanza por tramos de TRAVEL_SEGMENT bloques hacia el destino,
 * porque el pathfinder solo conoce los chunks cargados. Si un tramo se bloquea, prueba
 * a desviarse. Devuelve true si llega a `range` bloques del destino.
 */
async function travelTo(bot, target, range = 2, maxMs = Infinity) {
  let failures = 0
  const deadline = Date.now() + maxMs
  while (!bot.stopped && bot.entity) {
    if (Date.now() > deadline) return false
    const pos = bot.entity.position
    const remaining = distXZ(pos, target)

    if (remaining <= TRAVEL_SEGMENT) {
      if (await safeGoto(bot, new GoalNear(target.x, target.y, target.z, range), 30)) return true
      if (++failures >= 4) return false
      continue
    }

    let angle = Math.atan2(target.z - pos.z, target.x - pos.x)
    if (failures > 0) angle += (Math.random() - 0.5) * (Math.PI / 1.5) // desvío para rodear obstáculos
    const wx = Math.floor(pos.x + Math.cos(angle) * TRAVEL_SEGMENT)
    const wz = Math.floor(pos.z + Math.sin(angle) * TRAVEL_SEGMENT)

    await safeGoto(bot, new GoalNearXZ(wx, wz, 4), 30)

    // Aunque el tramo no se complete, cuenta como avance si se acercó
    if (bot.entity && distXZ(bot.entity.position, target) < remaining - 8) {
      failures = 0
    } else if (++failures >= 6) {
      return false
    }
  }
  return false
}

/**
 * Exploración libre: mantiene un rumbo y avanza `dist` bloques; si se bloquea, cambia de rumbo.
 */
async function explore(bot, dist = 24) {
  if (!bot.entity) return
  if (bot.exploreHeading === undefined) bot.exploreHeading = Math.random() * Math.PI * 2
  bot.exploreHeading += (Math.random() - 0.5) * 0.6 // pequeñas variaciones para no ir en línea recta perfecta

  const pos = bot.entity.position
  const tx = Math.floor(pos.x + Math.cos(bot.exploreHeading) * dist)
  const tz = Math.floor(pos.z + Math.sin(bot.exploreHeading) * dist)
  const ok = await safeGoto(bot, new GoalNearXZ(tx, tz, 3), 20)
  if (!ok) bot.exploreHeading = Math.random() * Math.PI * 2
}

async function equipBestTool(bot, toolNames) {
  for (const name of toolNames) {
    const item = bot.inventory.items().find(i => i.name === name)
    if (item) {
      try { await bot.equip(item, 'hand'); return true } catch {}
    }
  }
  return false
}

function chestIds(bot) {
  const mcData = require('minecraft-data')(bot.version)
  return [
    mcData.blocksByName.chest?.id,
    mcData.blocksByName.trapped_chest?.id,
    mcData.blocksByName.barrel?.id,
  ].filter(Boolean)
}

// ── Casa: cofre base de cada bot ─────────────────────────────
// Prioridad: config.bots.<bot>.home → config.chest.position → data/home_<bot>.json → cofre más cercano al aparecer

function homeFile(bot) {
  return path.join(HOMES_DIR, `home_${bot.botKey || bot.username}.json`)
}

function toVec3(p) {
  return p ? new Vec3(p.x, p.y, p.z) : null
}

function initHome(bot) {
  const configured = (bot.botKey && cfg.bots[bot.botKey]?.home) || (cfg.chest && cfg.chest.position)
  if (configured) {
    bot.home = toVec3(configured)
    console.log(`[${bot.label}] 🏠 Casa (config) en ${fmtPos(bot.home)}`)
    return
  }

  try {
    const saved = JSON.parse(fs.readFileSync(homeFile(bot), 'utf8'))
    bot.home = toVec3(saved)
    console.log(`[${bot.label}] 🏠 Casa guardada en ${fmtPos(bot.home)}`)
    return
  } catch {}

  // Bots como el organizador no adoptan un cofre cualquiera: su casa la eliges tú
  if (bot.botKey && cfg.bots[bot.botKey]?.autoHome === false) {
    console.log(`[${bot.label}] 🏠 Sin casa. Ponme junto a un cofre y usa "!casa ${bot.label.toLowerCase()}" o "Fijar casa" en el panel.`)
    return
  }

  const chest = bot.findBlock({ matching: chestIds(bot), maxDistance: (cfg.search && cfg.search.chestRadius) || 48 })
  if (chest) {
    setHome(bot, chest.position)
  } else {
    console.log(`[${bot.label}] 🏠 Sin casa todavía: usaré el primer cofre que encuentre.`)
  }
}

function setHome(bot, pos) {
  bot.home = toVec3(pos)
  try {
    fs.mkdirSync(HOMES_DIR, { recursive: true })
    fs.writeFileSync(homeFile(bot), JSON.stringify({ x: pos.x, y: pos.y, z: pos.z }))
  } catch (e) {
    console.warn(`[${bot.label}] No pude guardar la casa: ${e.message}`)
  }
  console.log(`[${bot.label}] 🏠 Nueva casa en ${fmtPos(bot.home)}`)
}

// Cofres que pertenecen a la casa: los que están a homeCfg.chestRadius bloques del cofre base
function findHomeChests(bot) {
  if (!bot.home) return []
  return bot.findBlocks({
    matching: chestIds(bot),
    point: bot.home,
    maxDistance: homeCfg.chestRadius,
    count: 32,
  })
    .map(p => bot.blockAt(p))
    .filter(Boolean)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
}

function isNearHome(bot, dist = (cfg.search && cfg.search.chestRadius) || 48) {
  return !!(bot.home && bot.entity && bot.entity.position.distanceTo(bot.home) <= dist)
}

/**
 * Comandos de chat de jugadores:
 *   !casa <bot|todos>  → el bot adopta como casa el cofre más cercano a él (radio 8)
 * <bot> puede ser el nombre de usuario (Bot_Minero), el rol (minero) o la clave (miner).
 */
function handleChatCommand(bot, username, message) {
  if (username === bot.username || !message.startsWith('!')) return
  const [cmd, target] = message.trim().split(/\s+/)
  if (cmd.toLowerCase() !== '!casa' || !target) return

  const t = target.toLowerCase()
  const names = [bot.username, bot.label, bot.botKey].filter(Boolean).map(n => n.toLowerCase())
  if (t !== 'todos' && !names.some(n => n === t || n.normalize('NFD').replace(/[̀-ͯ]/g, '') === t)) return

  const pos = setHomeFromNearestChest(bot)
  bot.chat(pos ? `Nueva casa en ${fmtPos(pos)}.` : 'No veo ningún cofre a menos de 8 bloques de mí.')
}

// Adopta como casa el cofre más cercano (radio 8). Devuelve su posición o null
function setHomeFromNearestChest(bot) {
  if (!bot.entity) return null
  const chest = bot.findBlock({ matching: chestIds(bot), maxDistance: 8 })
  if (!chest) return null
  setHome(bot, chest.position)
  return chest.position
}

// Si aún no tiene casa, adopta el cofre más cercano que vea
function ensureHome(bot) {
  if (bot.home) return true
  const chest = bot.findBlock({ matching: chestIds(bot), maxDistance: (cfg.search && cfg.search.chestRadius) || 48 })
  if (!chest) return false
  setHome(bot, chest.position)
  return true
}

// Función segura para abrir cofres con timeout de 4 segundos
async function safeOpenContainer(bot, block) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout al abrir cofre')), 4000)
    bot.openContainer(block).then(c => {
      clearTimeout(timer)
      resolve(c)
    }).catch(e => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

function isInventoryFull(bot) {
  return bot.inventory.emptySlotCount() <= homeCfg.returnWhenFreeSlots
}

function getDepositableItems(bot, keepItemNames = [], keepAmounts = {}) {
  const totals = new Map()
  for (const item of bot.inventory.items()) {
    if (keepItemNames.includes(item.name)) continue
    const entry = totals.get(item.name) || { name: item.name, type: item.type, count: 0 }
    entry.count += item.count
    totals.set(item.name, entry)
  }
  return [...totals.values()]
    .map(e => ({ ...e, count: e.count - (keepAmounts[e.name] || 0) }))
    .filter(e => e.count > 0)
}

/**
 * Vuelve a casa (desde donde sea), reparte todo en los cofres de casa excepto keepItemNames
 * (y la reserva de keepAmounts) y, si returnToWorkSpot está activo, regresa al sitio donde trabajaba.
 * Devuelve: 'ok' | 'full' | 'no_home' | 'unreachable' | 'no_chest' | 'cooldown' | 'nothing_to_deposit' | 'disabled'
 */
async function returnHomeAndDeposit(bot, keepItemNames = [], keepAmounts = {}) {
  const label = bot.label
  if (cfg.chest && !cfg.chest.enabled) return 'disabled'
  if (bot._nextDepositAt && Date.now() < bot._nextDepositAt) return 'cooldown'
  if (getDepositableItems(bot, keepItemNames, keepAmounts).length === 0) return 'nothing_to_deposit'
  if (!ensureHome(bot)) {
    bot._nextDepositAt = Date.now() + CHEST_RETRY_MS
    console.warn(`[${label}] 📭 No tengo casa ni veo cofres. Sigo trabajando y reintento en ${CHEST_RETRY_MS / 1000}s.`)
    return 'no_home'
  }

  const workSpot = bot.entity.position.clone()
  const far = !isNearHome(bot)
  if (far) console.log(`[${label}] 🎒 Inventario lleno. Volviendo a casa ${fmtPos(bot.home)} (a ${Math.round(distXZ(workSpot, bot.home))} bloques)...`)

  const result = await depositAtHome(bot, keepItemNames, keepAmounts)
  if (result === 'ok') bot._nextDepositAt = 0
  else {
    const retryMs = result === 'full' ? CHEST_FULL_RETRY_MS : CHEST_RETRY_MS
    bot._nextDepositAt = Date.now() + retryMs
    console.warn(`[${label}] 📦 No pude guardar todo en casa (${result}). Reintento en ${Math.round(retryMs / 60000)} min.`)
  }

  if (far && homeCfg.returnToWorkSpot && !bot.stopped) {
    console.log(`[${label}] 🧭 Regresando a donde trabajaba ${fmtPos(workSpot)}...`)
    await travelTo(bot, workSpot, 3, homeCfg.maxTravelMinutes * 60 * 1000)
  }
  return result
}

/**
 * Lleva al bot a casa: caminando hasta homeCfg.maxTravelMinutes y, si no llega, con /tp.
 * Devuelve true si está en casa.
 */
async function reachHome(bot) {
  if (!bot.home) return false
  if (isNearHome(bot, 8)) return true
  stats.add(bot.botKey, 'viajes')
  const start = Date.now()
  if (await travelTo(bot, bot.home, 2, homeCfg.maxTravelMinutes * 60 * 1000)) return true
  if (bot.stopped) return false
  const secs = Math.round((Date.now() - start) / 1000)
  console.log(`[${bot.label}] 🧭 No pude llegar a casa caminando (lo intenté ${secs} s, estoy en ${fmtPos(bot.entity.position)}).`)
  return stuckCfg.allowTeleport && await teleportHome(bot)
}

// bot.depositing avisa al organizador de que no vacíe estos cofres mientras tanto
async function depositAtHome(bot, keepItemNames, keepAmounts) {
  bot.depositing = true
  try {
    return await depositAtHomeInner(bot, keepItemNames, keepAmounts)
  } finally {
    bot.depositing = false
  }
}

async function depositAtHomeInner(bot, keepItemNames, keepAmounts) {
  if (!await reachHome(bot)) return 'unreachable'

  const chests = findHomeChests(bot)
  if (chests.length === 0) {
    // El cofre de casa ya no existe: olvidar la casa para adoptar otra
    console.warn(`[${bot.label}] 🏚️ No hay cofres en casa ${fmtPos(bot.home)}. Buscaré otra casa.`)
    bot.home = null
    try { fs.unlinkSync(homeFile(bot)) } catch {}
    return 'no_chest'
  }

  let stored = 0
  let fullChests = 0
  let problems = [] // motivos de fallo que no son "cofre lleno", para explicarlos en el registro
  const countPending = () => getDepositableItems(bot, keepItemNames, keepAmounts).reduce((a, i) => a + i.count, 0)
  const pendingBefore = countPending()

  // Si todos los cofres se llenan, se coloca uno nuevo (hasta homeCfg.maxChests) y se sigue guardando en él
  for (let pass = 0; pass < 4; pass++) {
    const r = await depositPass(bot, findHomeChests(bot), keepItemNames, keepAmounts)
    stored += r.stored
    fullChests = r.fullChests
    problems = r.problems
    const allFull = getDepositableItems(bot, keepItemNames, keepAmounts).length > 0 && fullChests > 0 && problems.length === 0
    if (!allFull || !homeCfg.autoChests) break
    if (!await placeNewChest(bot)) break
  }
  bot.homeChestCount = findHomeChests(bot).length

  // Estadísticas: objetos (no tipos) que quedaron guardados
  const storedItems = Math.max(0, pendingBefore - countPending())
  stats.add(bot.botKey, 'guardados', storedItems)
  stats.addHourly(bot.botKey, storedItems)

  if (stored > 0) console.log(`[${bot.label}] ✅ Guardados ${stored} tipos de items en casa.`)
  const left = getDepositableItems(bot, keepItemNames, keepAmounts)
  const count = left.reduce((a, i) => a + i.count, 0)
  bot.lastDeposit = { t: Date.now(), stored, left: count } // el panel lo muestra en la tarjeta
  if (left.length === 0) {
    bot.homeFull = false
    return 'ok'
  }

  // Solo es "lleno" si todos los cofres a los que pudo acceder estaban llenos de verdad
  bot.homeFull = fullChests > 0 && problems.length === 0
  if (bot.homeFull) {
    const why = homeCfg.autoChests && bot.homeChestCount >= homeCfg.maxChests
      ? `ya tengo el máximo de ${homeCfg.maxChests} cofres. Vacía alguno o sube home.maxChests en config.js`
      : `pon más cofres junto a ${fmtPos(bot.home)} (a menos de ${homeCfg.chestRadius} bloques)`
    console.warn(`[${bot.label}] 📦 Los cofres de casa están llenos: me quedan ${count} objetos sin guardar; ${why}.`)
    return 'full'
  }
  console.warn(`[${bot.label}] 📦 No pude guardar ${count} objetos: ${problems.slice(0, 3).join(' · ') || 'motivo desconocido'}`)
  return 'error'
}

// Una pasada por los cofres de casa guardando todo lo posible
async function depositPass(bot, chests, keepItemNames, keepAmounts) {
  let stored = 0
  let fullChests = 0
  const problems = []

  for (const chestBlock of chests) {
    if (getDepositableItems(bot, keepItemNames, keepAmounts).length === 0) break

    // Basta con tener el cofre al alcance de la mano; exigir estar pegado falla con cofres junto a paredes
    if (!inReach(bot, chestBlock)) {
      await safeGoto(bot, new GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2), 15)
      if (!inReach(bot, chestBlock)) {
        problems.push(`no llego al cofre ${fmtPos(chestBlock.position)}`)
        continue
      }
    }

    try {
      const container = await safeOpenContainer(bot, chestBlock)
      let thisChestFull = false
      // Recalcular lo pendiente justo antes de depositar (puede haber cambiado en el cofre anterior)
      for (const item of getDepositableItems(bot, keepItemNames, keepAmounts)) {
        try {
          await container.deposit(item.type, null, item.count)
          stored++
          await sleep(150)
        } catch (e) {
          if (e.message && e.message.includes('destination full')) { thisChestFull = true; break }
          problems.push(`${item.name}: ${e.message}`)
        }
      }
      if (thisChestFull) fullChests++
      try { container.close() } catch {}
      await sleep(300)
    } catch (err) {
      problems.push(`cofre ${fmtPos(chestBlock.position)}: ${err.message}`)
    }
  }
  return { stored, fullChests, problems }
}

// ── Cofres automáticos ───────────────────────────────────────

/**
 * Consigue un cofre (del inventario o con /give) y lo coloca en casa, junto a los existentes.
 * Devuelve true si colocó uno.
 */
async function placeNewChest(bot) {
  const existing = findHomeChests(bot)
  if (existing.length >= homeCfg.maxChests) return false

  // 1. Conseguir el cofre
  let chestItem = bot.inventory.items().find(i => i.name === 'chest')
  if (!chestItem) {
    bot.chat(`/give ${bot.username} chest 1`)
    await waitUntil(() => bot.inventory.items().some(i => i.name === 'chest'), 3000)
    chestItem = bot.inventory.items().find(i => i.name === 'chest')
    if (!chestItem) {
      console.warn(`[${bot.label}] 📦 No pude darme un cofre con /give. ¿Es OP? Ejecuta en la consola del servidor: op ${bot.username}`)
      return false
    }
  }

  // 2. Probar los mejores huecos hasta que uno funcione
  for (const spot of findChestSpots(bot, existing).slice(0, 6)) {
    const ground = bot.blockAt(spot.offset(0, -1, 0))
    if (!inReach(bot, ground)) {
      await safeGoto(bot, new GoalNear(spot.x, spot.y, spot.z, 3), 10)
      if (!inReach(bot, ground)) continue
    }
    // No colocarlo donde está el propio bot
    const feet = bot.entity.position.floored()
    if (feet.equals(spot) || feet.offset(0, 1, 0).equals(spot)) continue

    try {
      await bot.equip(bot.inventory.items().find(i => i.name === 'chest'), 'hand')
      await bot.placeBlock(ground, new Vec3(0, 1, 0))
    } catch {}
    await sleep(300)
    if (bot.blockAt(spot)?.name === 'chest') {
      console.log(`[${bot.label}] 📦 Coloqué un cofre nuevo en ${fmtPos(spot)}. Ahora tengo ${existing.length + 1}/${homeCfg.maxChests}.`)
      stats.add(bot.botKey, 'cofresCreados')
      return true
    }
  }
  console.warn(`[${bot.label}] 📦 No encontré dónde colocar un cofre nuevo junto a casa ${fmtPos(bot.home)}.`)
  return false
}

/**
 * Huecos válidos para un cofre: dentro del radio de casa, aire con aire encima (un cofre
 * con un bloque sólido encima no se puede abrir) y suelo firme debajo. Prioriza los pegados
 * a cofres existentes para mantener el almacén ordenado.
 */
function findChestSpots(bot, existing) {
  const r = homeCfg.chestRadius
  const home = bot.home
  const chestKeys = new Set(existing.map(c => c.position.toString()))
  const spots = []

  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        const p = home.offset(dx, dy, dz)
        if (p.distanceTo(home) > r - 0.5) continue
        const b = bot.blockAt(p)
        const above = bot.blockAt(p.offset(0, 1, 0))
        const below = bot.blockAt(p.offset(0, -1, 0))
        if (!b || !above || !below) continue
        if (!(b.name === 'air' || b.name === 'cave_air')) continue
        if (above.boundingBox === 'block') continue
        if (below.boundingBox !== 'block' || below.name === 'chest' || below.name.includes('leaves') || below.name === 'farmland') continue

        const besideChest = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => chestKeys.has(p.offset(x, 0, z).toString()))
        spots.push({ p, score: (besideChest ? 0 : 100) + p.distanceTo(home) })
      }
    }
  }
  return spots.sort((a, b) => a.score - b.score).map(s => s.p)
}

// ── Órdenes del panel ────────────────────────────────────────
// El panel deja la orden en bot.pendingCommand; cada bot la ejecuta al inicio de su bucle de trabajo.
// Mientras tanto safeGoto devuelve false al momento, así la tarea en curso termina rápido.

function requestCommand(bot, type) {
  bot.pendingCommand = type
  try { bot.pathfinder.stop() } catch {}
  if (bot.fishing) { try { bot.activateItem() } catch {} } // recoger el anzuelo del pescador
}

/** Ejecuta la orden pendiente, si la hay. Devuelve true si ejecutó alguna. */
async function runPendingCommand(bot) {
  const cmd = bot.pendingCommand
  if (!cmd) return false
  bot.commandRunning = true
  try {
    if (cmd === 'gohome') await goHomeNow(bot)
    else if (cmd === 'escape') await escapeAndGoHome(bot)
  } catch (err) {
    console.warn(`[${bot.label}] ⚠️ Orden "${cmd}" falló: ${err.message}`)
  } finally {
    bot.pendingCommand = null
    bot.commandRunning = false
  }
  return true
}

// Vuelve a casa, guarda según bot.depositRules y sigue trabajando desde allí
async function goHomeNow(bot) {
  if (!ensureHome(bot)) {
    console.warn(`[${bot.label}] 🏠 No tengo casa: usa "Fijar casa" junto a un cofre.`)
    return
  }
  console.log(`[${bot.label}] 🏡 Volviendo a casa ${fmtPos(bot.home)} por orden del panel...`)
  const rules = bot.depositRules || { keep: [], amounts: {} }
  const result = await depositAtHome(bot, rules.keep, rules.amounts)
  if (result === 'ok') {
    bot._nextDepositAt = 0
    console.log(`[${bot.label}] 🏡 En casa y con todo guardado. Sigo trabajando desde aquí.`)
  } else if (result === 'full') {
    bot._nextDepositAt = Date.now() + CHEST_FULL_RETRY_MS
    console.warn(`[${bot.label}] 🏡 Estoy en casa, pero no cupo todo en los cofres. Sigo trabajando.`)
  } else if (result === 'unreachable') {
    console.warn(`[${bot.label}] 🏡 No pude llegar a casa ni caminando ni con /tp. ¿Es OP? (op ${bot.username})`)
  } else {
    console.warn(`[${bot.label}] 🏡 No pude completar la vuelta a casa (${result}).`)
  }
}

// ── Rescate de bots atascados ────────────────────────────────

/**
 * Vigila si el bot avanza. Si en stuckCfg.detectSeconds no se aleja más de 3 bloques
 * (y no está en casa ni ocupado con otra orden ni esperando a propósito con bot.idle), pide un rescate.
 */
function startStuckWatch(bot) {
  const windowMs = stuckCfg.detectSeconds * 1000
  const samples = []
  const timer = setInterval(() => {
    if (bot.stopped) return clearInterval(timer)
    if (!bot.entity || bot.pendingCommand || bot.idle || isNearHome(bot, 8)) { samples.length = 0; return }

    const now = Date.now()
    samples.push({ t: now, pos: bot.entity.position.clone() })
    while (samples.length && samples[0].t < now - windowMs) samples.shift()
    if (now - samples[0].t < windowMs - 5000) return // aún no hay suficiente historial

    const last = samples[samples.length - 1].pos
    if (samples.every(s => s.pos.distanceTo(last) < 3)) {
      samples.length = 0
      console.log(`[${bot.label}] 🆘 Llevo ${stuckCfg.detectSeconds}s sin avanzar en ${fmtPos(last)}. Intentando salir...`)
      // Que no vuelva a por lo mismo: prohibir la zona y el objetivo que perseguía durante un rato
      bot.stuckZones.push({ pos: last.clone(), until: Date.now() + STUCK_ZONE_MS })
      stats.add(bot.botKey, 'atascos')
      if (bot.currentTarget) markBad(bot, bot.currentTarget, STUCK_ZONE_MS, true)
      requestCommand(bot, 'escape')
    }
  }, 5000)
  bot.once('end', () => clearInterval(timer))
}

/**
 * Nivel 1: subir a la superficie y volver a casa caminando.
 * Nivel 2 (si falla, o si ya se atascó hace poco): /tp a casa.
 */
async function escapeAndGoHome(bot) {
  const now = Date.now()
  const repeated = bot.lastEscapeAt && now - bot.lastEscapeAt < stuckCfg.repeatMinutes * 60 * 1000
  bot.lastEscapeAt = now
  ensureHome(bot)

  if (repeated) {
    console.log(`[${bot.label}] 🆘 Es la segunda vez en menos de ${stuckCfg.repeatMinutes} min: paso directamente al /tp.`)
  } else {
    if (!canSeeSky(bot)) {
      console.log(`[${bot.label}] ⛏️ Subiendo a la superficie desde ${fmtPos(bot.entity.position)}...`)
      if (await climbToSurface(bot)) console.log(`[${bot.label}] ☀️ En la superficie en ${fmtPos(bot.entity.position)}.`)
      else console.warn(`[${bot.label}] ⚠️ No pude subir a la superficie.`)
    }
    if (bot.home && canSeeSky(bot)) {
      console.log(`[${bot.label}] 🏡 Volviendo a casa ${fmtPos(bot.home)}...`)
      if (await travelTo(bot, bot.home, 2, homeCfg.maxTravelMinutes * 60 * 1000)) return finishRescue(bot)
      console.warn(`[${bot.label}] ⚠️ No encuentro camino a casa.`)
    }
  }

  if (stuckCfg.allowTeleport && await teleportHome(bot)) return finishRescue(bot)
  console.warn(`[${bot.label}] ❌ No pude rescatarme. Hazme /tp manualmente o pulsa "Rescatar" en el panel.`)
}

async function finishRescue(bot) {
  const rules = bot.depositRules || { keep: [], amounts: {} }
  const result = await depositAtHome(bot, rules.keep, rules.amounts)
  if (result === 'ok') {
    bot._nextDepositAt = 0
    const what = bot.lastDeposit && bot.lastDeposit.stored > 0 ? 'inventario guardado' : 'nada pendiente de guardar'
    console.log(`[${bot.label}] ✅ Rescatado: en casa y con ${what}. Sigo trabajando.`)
  } else {
    console.warn(`[${bot.label}] ✅ Rescatado: en casa, pero no pude guardar todo (${result}). Sigo trabajando.`)
  }
}

// Sin bloques sólidos ni líquidos encima de la cabeza hasta el cielo (las hojas no cuentan)
function canSeeSky(bot) {
  if (!bot.entity) return false
  const feet = bot.entity.position.floored()
  const top = Math.min(feet.y + 200, 319)
  for (let y = feet.y + 2; y <= top; y++) {
    const b = bot.blockAt(new Vec3(feet.x, y, feet.z))
    if (!b) continue
    if (b.name === 'water' || b.name === 'lava') return false
    if (b.boundingBox === 'block' && !b.name.includes('leaves')) return false
  }
  return true
}

// Altura del suelo de la superficie sobre el bot: el bloque sólido más alto de su columna
function findSurfaceY(bot) {
  const feet = bot.entity.position.floored()
  for (let y = Math.min(feet.y + 200, 319); y > feet.y + 1; y--) {
    const b = bot.blockAt(new Vec3(feet.x, y, feet.z))
    if (b && b.boundingBox === 'block' && !b.name.includes('leaves')) return y
  }
  return null
}

async function climbToSurface(bot) {
  if (canSeeSky(bot)) return true

  // 1º el pathfinder con torres activadas: sabe excavar escaleras y subir poniendo bloques
  const movements = bot.pathfinder.movements
  const prevTowers = movements.allow1by1towers
  movements.allow1by1towers = true
  try {
    const surfaceY = findSurfaceY(bot)
    if (surfaceY !== null) await safeGoto(bot, new GoalY(surfaceY + 1), 60)
  } finally {
    movements.allow1by1towers = prevTowers
  }
  if (canSeeSky(bot)) return true

  // 2º pilar manual: picar encima, saltar y ponerse un bloque bajo los pies
  console.log(`[${bot.label}] 🧱 Probando a subir en pilar...`)
  return pillarUp(bot)
}

async function pillarUp(bot, maxSteps = 120) {
  let fails = 0
  for (let i = 0; i < maxSteps && !bot.stopped; i++) {
    if (canSeeSky(bot)) return true
    const feet = bot.entity.position.floored()

    // Peligro: líquido justo encima → no seguir por aquí
    const danger = [2, 3].map(dy => bot.blockAt(feet.offset(0, dy, 0)))
    if (danger.some(b => b && (b.name === 'lava' || b.name === 'water'))) {
      console.warn(`[${bot.label}] 🔥 Hay líquido encima, abandono el pilar.`)
      return false
    }

    // Despejar el bloque sobre la cabeza (se repite si cae grava o arena)
    for (let tries = 0; tries < 8; tries++) {
      const above = bot.blockAt(feet.offset(0, 2, 0))
      if (!above || above.boundingBox !== 'block') break
      if (!above.diggable) { // bedrock u otro irrompible
        console.warn(`[${bot.label}] 🧱 Pilar: no puedo romper ${above.name} encima.`)
        return false
      }
      await equipBestTool(bot, PICKAXES)
      await bot.dig(above)
      await sleep(150)
    }

    const block = bot.inventory.items().find(i => SCAFFOLD_ITEMS.includes(i.name))
    if (!block) {
      console.warn(`[${bot.label}] 🧱 Sin bloques para el pilar.`)
      return false
    }
    await bot.equip(block, 'hand')
    const ground = bot.blockAt(feet.offset(0, -1, 0))
    if (!ground || ground.boundingBox !== 'block') {
      console.warn(`[${bot.label}] 🧱 Pilar: no hay suelo firme bajo ${fmtPos(feet)} (${ground ? ground.name : '?'}).`)
      return false
    }

    // Mirar abajo antes de saltar: así colocar el bloque no espera a girar la cabeza
    await bot.look(bot.entity.yaw, -Math.PI / 2, true)
    bot.setControlState('jump', true)
    const rose = await waitUntil(() => bot.entity.position.y > feet.y + 1.05, 800)
    if (rose) { try { await bot.placeBlock(ground, new Vec3(0, 1, 0)) } catch {} }
    bot.setControlState('jump', false)
    await waitUntil(() => bot.entity.onGround, 1500)

    if (bot.entity.position.floored().y <= feet.y) {
      if (++fails >= 4) {
        console.warn(`[${bot.label}] 🧱 Pilar: no consigo colocar bloques bajo los pies en ${fmtPos(feet)}.`)
        return false
      }
    } else {
      fails = 0
    }
  }
  return canSeeSky(bot)
}

// Último recurso: /tp encima del cofre de casa (requiere OP)
async function teleportHome(bot) {
  if (!bot.home || !bot.entity) return false
  console.log(`[${bot.label}] 🌀 Último recurso: /tp a casa ${fmtPos(bot.home)}...`)
  if (await teleportTo(bot, bot.home)) {
    console.log(`[${bot.label}] 🌀 Teletransportado a casa.`)
    return true
  }
  return false
}

/**
 * /tp encima del bloque `pos` (normalmente un cofre) y espera a que carguen los chunks de destino.
 * Requiere OP. Devuelve true si el bot llegó.
 */
async function teleportTo(bot, pos) {
  if (!bot.entity) return false
  if (bot.entity.position.distanceTo(pos.offset(0.5, 1, 0.5)) < 2) return true
  bot.chat(`/tp ${bot.username} ${pos.x + 0.5} ${pos.y + 1} ${pos.z + 0.5}`)
  const moved = await waitUntil(() => bot.entity && bot.entity.position.distanceTo(pos.offset(0.5, 1, 0.5)) < 3, 4000)
  if (!moved) {
    console.warn(`[${bot.label}] 🌀 El /tp a ${fmtPos(pos)} no funcionó. ¿Es OP? Ejecuta en la consola del servidor: op ${bot.username}`)
    return false
  }
  await waitUntil(() => bot.blockAt(pos) !== null, 5000) // chunks de destino cargados
  await sleep(1000)
  stats.add(bot.botKey, 'teletransportes')
  return true
}

async function waitUntil(cond, timeoutMs, stepMs = 50) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(stepMs)
  }
  return cond()
}

/**
 * Se da a sí mismo los objetos de cfg.bots.<bot>.give con /give (requiere OP).
 * Comprueba el resultado mirando si los objetos llegaron al inventario.
 * Devuelve { ok, message }.
 */
async function giveConfiguredItems(bot) {
  const gifts = (cfg.bots[bot.botKey] && cfg.bots[bot.botKey].give) || []
  if (gifts.length === 0) return { ok: false, message: `${bot.label} no tiene objetos configurados en config.js (give)` }

  const countOf = (name) => bot.inventory.items().filter(i => i.name === name).reduce((a, i) => a + i.count, 0)
  const before = Object.fromEntries(gifts.map(g => [g.item, countOf(g.item)]))

  // Capturar las respuestas del servidor para explicar un fallo (p. ej. falta de permisos)
  const replies = []
  const onMessage = (msg, position) => { if (position !== 'chat') replies.push(msg.toString()) }
  bot.on('message', onMessage)
  try {
    for (const g of gifts) {
      bot.chat(`/give ${bot.username} ${g.item} ${g.count}`)
      await sleep(300)
    }
    await sleep(1500)
  } finally {
    bot.removeListener('message', onMessage)
  }

  const received = gifts.filter(g => countOf(g.item) > before[g.item])
  const desc = gifts.map(g => `${g.item.replace(/_/g, ' ')}${g.count > 1 ? ' ×' + g.count : ''}`).join(', ')
  if (received.length === gifts.length) {
    console.log(`[${bot.label}] 🎁 Recibido: ${desc}`)
    return { ok: true, message: `${bot.label} recibió: ${desc}` }
  }

  const reply = replies.filter(Boolean).slice(-1)[0]
  const noPerm = !reply || /permission|permiso|unknown|desconocid|incomplete/i.test(reply)
  const hint = noPerm ? ` ¿Es OP? Ejecuta en la consola del servidor: op ${bot.username}` : ''
  console.warn(`[${bot.label}] 🎁 /give falló${reply ? ': ' + reply : ''}.${hint}`)
  return { ok: false, message: `No se pudo dar la herramienta a ${bot.label}${reply ? ` (${reply})` : ''}.${hint}` }
}

/**
 * Saca una herramienta de los cofres de casa si no tiene ninguna.
 * Solo lo intenta si está cerca de casa, salvo que travel = true (viaja a casa a buscarla).
 */
async function withdrawToolsFromChest(bot, toolNames = [], { travel = false } = {}) {
  if (cfg.chest && !cfg.chest.enabled) return false

  const alreadyHas = bot.inventory.items().some(i => toolNames.includes(i.name))
  if (alreadyHas) return true

  if (bot._nextToolCheckAt && Date.now() < bot._nextToolCheckAt) return false
  if (!ensureHome(bot)) return false
  if (!isNearHome(bot) && !travel) return false

  const found = await doWithdrawTool(bot, toolNames)
  bot._nextToolCheckAt = found ? 0 : Date.now() + CHEST_RETRY_MS
  return found
}

async function doWithdrawTool(bot, toolNames) {
  if (!isNearHome(bot, 8)) {
    console.log(`[${bot.label}] 🛠️ Voy a casa a buscar herramienta...`)
    if (!await reachHome(bot)) return false
  }

  for (const chestBlock of findHomeChests(bot)) {
    if (!inReach(bot, chestBlock)) {
      await safeGoto(bot, new GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2), 15)
      if (!inReach(bot, chestBlock)) continue
    }

    try {
      const container = await safeOpenContainer(bot, chestBlock)
      const itemsInChest = container.containerItems()
      let found = false
      for (const toolName of toolNames) {
        const match = itemsInChest.find(i => i.name === toolName)
        if (match) {
          await container.withdraw(match.type, null, 1)
          console.log(`[${bot.label}] 🛠️ Saqué ${toolName} del cofre`)
          found = true
          break
        }
      }
      try { container.close() } catch {}
      await sleep(200)
      if (found) return true
    } catch {}
  }
  return false
}

// En 1.21 los items del suelo tienen name 'item' y type 'other' (no 'object').
// ignoreNames: items que no merece la pena ir a buscar (p. ej. el relleno que el minero tira)
async function collectNearbyItems(bot, maxDist = 12, ignoreNames = []) {
  if (!bot.entity || isInventoryFull(bot)) return
  const items = Object.values(bot.entities)
    .filter(e => e.name === 'item' && e.position && e.position.distanceTo(bot.entity.position) < maxDist)
    .filter(e => {
      if (ignoreNames.length === 0) return true
      try { return !ignoreNames.includes(e.getDroppedItem()?.name) } catch { return true }
    })
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
    .slice(0, 10)

  for (const item of items) {
    if (bot.stopped) return
    if (!bot.entities[item.id] || !item.position) continue // ya recogido o desaparecido
    await safeGoto(bot, new GoalNear(item.position.x, item.position.y, item.position.z, 1), 6)
    await sleep(200)
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function fmtPos(p) {
  if (!p) return '(?)'
  return `(${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)})`
}

module.exports = {
  SCAFFOLD_ITEMS,
  activeBots,
  teleportTo,
  waitUntil,
  getDepositableItems,
  placeNewChest,
  reachHome,
  botOptions, setupBot, setHomeFromNearestChest, requestCommand, runPendingCommand, giveConfiguredItems, safeGoto, travelTo, explore, equipBestTool, returnHomeAndDeposit, isInventoryFull,
  withdrawToolsFromChest, collectNearbyItems, markBad, isBad, inStuckZone, inReach, sleep, fmtPos
}
