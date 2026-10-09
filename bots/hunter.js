// ============================================================
//  bots/hunter.js — Bot Cazador
//  Caza monstruos con espada (cuerpo a cuerpo) y con arco (de lejos: calcula la caída de la flecha, se adelanta al
//  movimiento del monstruo y no dispara si hay alguien o algo en la trayectoria). Qué hace se elige en el panel
//  (su tarjeta o la pestaña ⚙️ Ajustes) o desde el juego con !cazador:
//   · 🛡️ seguir: va con un jugador y caza los monstruos que se le acercan
//   · 🧭 explorar: recorre su zona del mapa (o los alrededores de su casa) cazando lo que encuentra
//   · 🔄 automático: sigue al jugador mientras está conectado; si no, explora
//  Con el plugin BotHelper 1.6 lo que sueltan los monstruos le llega directo al inventario y a su alrededor aparecen
//  monstruos como alrededor de un jugador (alrededor de los demás bots, no). Lo guarda en casa; el Organizador lo ordena.
// ============================================================
const mineflayer = require('mineflayer')
const { pathfinder, goals: { GoalFollow, GoalNear, GoalNearXZ } } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const cfg = require('../config')
const stats = require('./stats')
const {
  botOptions,
  setupBot,
  returnHomeAndDeposit,
  runPendingCommand,
  requestCommand,
  isInventoryFull,
  withdrawToolsFromChest,
  collectNearbyItems,
  getZone,
  goToZone,
  teleportTo,
  waitUntil,
  idleSleep,
  haltPathfinder,
  giveItem,
  setIssue,
  clearIssue,
  sleep,
  fmtPos,
} = require('./common')

// Del panel: se cargan al usarlos (dependen a su vez de módulos de los bots)
const link = () => require('../panel/serverlink')

const TAG = '[Cazador]'
const KEY = 'hunter'

// Ajustes (config.js → hunter; se pueden cambiar en vivo desde el panel): se leen en cada uso
const hunterCfg = () => Object.assign({ mode: 'auto', player: '', guardRadius: 16, exploreRadius: 160, useBow: true }, cfg.hunter)

// Monstruos que caza (nombre del juego → en español). No caza: endermans ni piglins (neutrales: atacar a uno enfada a
// los de alrededor), warden ni creaking (no se pueden matar a espadazos), guardianes (en el agua de los monumentos), nada
// con nombre (la mascota o el adorno de alguien) ni, por supuesto, jugadores, aldeanos o animales
const PREY_ES = {
  zombie: 'zombi', husk: 'zombi del desierto', drowned: 'ahogado', zombie_villager: 'aldeano zombi',
  skeleton: 'esqueleto', stray: 'esqueleto de las nieves', bogged: 'esqueleto del pantano', wither_skeleton: 'esqueleto wither',
  spider: 'araña', cave_spider: 'araña de cueva', creeper: 'creeper', witch: 'bruja', slime: 'slime', magma_cube: 'cubo de magma',
  phantom: 'phantom', pillager: 'saqueador', vindicator: 'vindicador', evoker: 'invocador', vex: 'vex',
  silverfish: 'lepisma', endermite: 'endermite', blaze: 'blaze', zoglin: 'zoglin', breeze: 'breeze',
}
const preyName = n => PREY_ES[n] || String(n).replace(/_/g, ' ')

// Botín más habitual, para el registro
const LOOT_ES = {
  rotten_flesh: 'carne podrida', bone: 'hueso', arrow: 'flecha', string: 'cuerda', spider_eye: 'ojo de araña',
  gunpowder: 'pólvora', slime_ball: 'bola de slime', phantom_membrane: 'membrana de phantom', ender_pearl: 'perla de ender',
  glass_bottle: 'botella', glowstone_dust: 'polvo de piedra luminosa', redstone: 'redstone', sugar: 'azúcar', stick: 'palo',
  iron_ingot: 'lingote de hierro', copper_ingot: 'lingote de cobre', gold_ingot: 'lingote de oro', carrot: 'zanahoria',
  potato: 'patata', emerald: 'esmeralda', crossbow: 'ballesta', ominous_bottle: 'botella ominosa', blaze_rod: 'vara de blaze',
  magma_cream: 'crema de magma', coal: 'carbón', breeze_rod: 'vara de breeze', tipped_arrow: 'flecha con efecto',
  totem_of_undying: 'tótem de la inmortalidad',
}

const SWORDS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'golden_sword', 'stone_sword', 'wooden_sword']
// Al guardar se queda una espada de cada tipo, el arco y unas flechas
const KEEP_AMOUNTS = Object.fromEntries([...SWORDS.map(s => [s, 1]), ['bow', 1], ['arrow', 192]])

const MELEE_REACH = 3          // golpe: hasta 3 bloques desde los ojos hasta el cuerpo del monstruo (como un jugador)
const SWORD_COOLDOWN_MS = 650  // la espada recarga en 0,625 s: antes, el golpe hace mucho menos daño
const BOW_MIN = 7, BOW_MAX = 40 // distancia de arco (más cerca, la espada es más rápida)
const BOW_DRAW_MS = 1150       // tensado completo (1 s): la flecha sale a la velocidad máxima
const ARROW_SPEED = 3, ARROW_GRAVITY = 0.05, ARROW_DRAG = 0.99 // física de la flecha del juego (bloques y ticks)
const MAX_SHOTS = 8            // flechas por monstruo; después, a por él con la espada
const FIGHT_MAX_MS = 45000     // tiempo máximo con un mismo monstruo
const CHASE_STALL_MS = 8000    // sin acercarse ni darle en este tiempo: no puede llegar, lo deja
const IGNORE_MS = 90000        // y lo ignora este rato
const SIGHT_NO_LOS = 10        // uno que no se ve (tras una pared, en una cueva) solo cuenta si está así de cerca
const FOLLOW_RANGE = 3         // distancia a la que va del jugador
const FOLLOW_TP_DISTANCE = 32  // más lejos (o fuera de su vista), se teletransporta a su lado
const FOLLOW_TP_GAP_MS = 4000
const EXPLORE_STEP = 28        // largo de cada tramo al explorar
const ARROWS_LOW = 16, ARROWS_GIVE = 64, ARROWS_GIVE_GAP_MS = 2 * 60 * 1000
// Lo que no frena una flecha (el resto de entidades que no son presas sí cuentan como "alguien en medio")
const ARROW_PASSES = new Set([
  'item', 'experience_orb', 'arrow', 'spectral_arrow', 'trident', 'snowball', 'egg', 'ender_pearl', 'potion',
  'experience_bottle', 'fireball', 'small_fireball', 'dragon_fireball', 'wither_skull', 'shulker_bullet', 'llama_spit',
  'firework_rocket', 'fishing_bobber', 'area_effect_cloud', 'marker', 'block_display', 'item_display', 'text_display',
  'interaction', 'lightning_bolt', 'falling_block', 'evoker_fangs', 'eye_of_ender', 'wind_charge', 'breeze_wind_charge',
  'ominous_item_spawner',
])

const distXZ = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const countOf = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((a, i) => a + i.count, 0)
const hasItem = (bot, name) => bot.inventory.items().some(i => i.name === name)
const bestSword = bot => SWORDS.map(n => bot.inventory.items().find(i => i.name === n)).find(Boolean) || null
const eyePos = bot => bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
const canUseBow = bot => hunterCfg().useBow !== false && hasItem(bot, 'bow') && countOf(bot, 'arrow') > 0
const plain = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const botNames = () => new Set(Object.values(cfg.bots).map(b => b.username.toLowerCase()))

function createBot(ctrl = {}) {
  const bot = mineflayer.createBot(botOptions(KEY))

  bot.loadPlugin(pathfinder)

  setupBot(bot, 'Cazador', () => createBot(ctrl), KEY, ctrl)
  trackCombat(bot)
  bot.on('chat', (username, message) => handleChat(bot, username, message))

  bot.once('spawn', () => {
    console.log(`[${cfg.bots.hunter.username}] 🏹 Conectado. ${modeText()}`)
    setTimeout(() => workLoop(bot), 3000)
  })

  return bot
}

function modeText() {
  const h = hunterCfg()
  if (h.mode === 'follow') return `Modo seguir: voy con ${h.player || '(nadie elegido)'} y le protejo.`
  if (h.mode === 'explore') return 'Modo explorar: cazo por mi cuenta.'
  return `Modo automático: sigo a ${h.player || '(nadie elegido)'} cuando está conectado; si no, exploro.`
}

// ════════════════════════════════════════════════════════════
//  BUCLE PRINCIPAL
// ════════════════════════════════════════════════════════════
async function workLoop(bot) {
  bot.depositRules = { keep: [], amounts: KEEP_AMOUNTS }
  let lastPlan = null

  while (!bot.stopped) {
    try {
      // 0. Órdenes del panel (volver a casa, rescate)
      if (await runPendingCommand(bot)) { bot._followGoalEntity = null; continue }
      if (!bot.entity) { await sleep(1000); continue }
      pruneMemory(bot)

      // 1. Espada, arco y flechas
      await ensureGear(bot)

      // 2. Qué toca hacer (cambia en vivo con los ajustes y cuando el jugador entra o sale)
      const plan = makePlan(bot)
      const planKey = `${plan.mode}|${plan.player || ''}|${plan.reason || ''}|${plan.zone ? `${plan.zone.x},${plan.zone.z},${plan.zone.radius}` : ''}`
      if (planKey !== lastPlan) {
        lastPlan = planKey
        console.log(`${TAG} ${plan.text}.`)
        haltPathfinder(bot)
        bot._followGoalEntity = null
      }
      bot.huntState = plan.text

      // 3. Inventario lleno: guardar en casa. Siguiendo a alguien no vuelve al sitio de antes: va de nuevo a su lado
      if (isInventoryFull(bot) && bot.home) {
        haltPathfinder(bot)
        bot._followGoalEntity = null
        await returnHomeAndDeposit(bot, [], KEEP_AMOUNTS, { returnToWork: plan.mode === 'explore' })
        continue
      }

      // 4. Un monstruo a tiro: a por él
      const prey = findPrey(bot, plan)
      if (prey) {
        bot._followGoalEntity = null
        await fight(bot, prey, plan)
        continue
      }

      // 5. Si no, lo que toque
      if (plan.mode === 'follow') await followStep(bot, plan)
      else if (plan.mode === 'explore') await exploreStep(bot, plan)
      else await waitStep(bot)
    } catch (err) {
      console.warn(`${TAG} ⚠️ ${err.message}`)
      haltPathfinder(bot)
      bot._followGoalEntity = null
      await sleep(2000)
    }
  }
}

/**
 * Qué hacer ahora: { mode: 'follow' | 'explore' | 'wait', text, anchor(), radius, … }.
 * anchor/radius: zona que protege (alrededor del jugador, de su casa o de sí mismo al explorar).
 */
function makePlan(bot) {
  const h = hunterCfg()
  const mode = ['follow', 'explore', 'auto'].includes(h.mode) ? h.mode : 'auto'
  let reason = null
  if (mode !== 'explore') {
    const w = whereIsPlayer(bot, h.player)
    if (w.ok) {
      return {
        mode: 'follow', player: w.name, entity: w.entity, info: w.info, radius: h.guardRadius,
        anchor: () => playerPos(bot, w) || bot.entity.position,
        text: `🛡️ Sigo a ${w.name}`,
      }
    }
    reason = w.reason
    if (mode === 'follow') {
      return {
        mode: 'wait', reason, radius: h.guardRadius, anchor: () => bot.home || bot.entity.position,
        text: `🏠 Vigilo la casa: ${reason}`,
      }
    }
  }
  const zone = getZone(KEY)
  if (!bot._exploreOrigin) bot._exploreOrigin = bot.entity.position.clone()
  return {
    mode: 'explore', reason, zone, center: zone ? zone.pos : (bot.home || bot._exploreOrigin),
    roam: zone ? zone.radius : h.exploreRadius, radius: 24, anchor: () => bot.entity.position,
    text: (zone ? `🧭 Exploro mi zona (${zone.x}, ${zone.z}), radio ${zone.radius}` : `🧭 Exploro hasta ${h.exploreRadius} bloques de casa`) +
      (reason ? ` (${reason})` : ''),
  }
}

/** ¿Se puede seguir al jugador? { ok, name, entity, info } o { ok: false, reason }. */
function whereIsPlayer(bot, name) {
  if (!name) return { ok: false, reason: 'no hay ningún jugador elegido para seguir' }
  const key = Object.keys(bot.players).find(n => n.toLowerCase() === name.toLowerCase())
  if (!key) return { ok: false, reason: `${name} no está conectado` }
  const sl = link()
  const info = sl.playerInfo(key)
  const me = sl.playerInfo(bot.username)
  if (info && info.gamemode === 'SPECTATOR') return { ok: false, reason: `${key} está en modo espectador` }
  // No le sigue al Nether ni al End: allí hay lava por todas partes y su casa está en el mundo normal
  if (info && me && info.world !== me.world) return { ok: false, reason: `${key} está en ${dimensionName(info.world)}` }
  const entity = bot.players[key].entity || null
  if (!info && !entity) return { ok: false, reason: `no sé dónde está ${key}` }
  return { ok: true, name: key, entity, info }
}

function dimensionName(world) {
  if (/nether/i.test(world)) return 'el Nether'
  if (/the_end|_end$/i.test(world)) return 'el End'
  return `el mundo "${world}"`
}

// Dónde está el jugador: lo que ve el bot (exacto) o lo que dice el servidor (cada 5 s)
function playerPos(bot, w) {
  if (w.entity && bot.entities[w.entity.id] === w.entity) return w.entity.position
  return w.info ? new Vec3(w.info.x + 0.5, w.info.y, w.info.z + 0.5) : null
}

// ════════════════════════════════════════════════════════════
//  SEGUIR, EXPLORAR, VIGILAR
// ════════════════════════════════════════════════════════════
async function followStep(bot, plan) {
  const now = Date.now()
  const pe = plan.entity && bot.entities[plan.entity.id] === plan.entity ? plan.entity : null
  if (pe) bot._seenPlayerAt = now
  const where = playerPos(bot, plan)
  const d = where ? bot.entity.position.distanceTo(where) : Infinity
  if (d <= 8) bot._followCloseAt = now

  // Fuera de su vista o muy lejos: a su lado con teletransporte. Si acaba de dejar de verlo, esperar unos segundos:
  // puede haber cruzado un portal y el servidor tarda un poco en decir en qué mundo está (no hay que seguirle allí)
  // Y si caminando no consigue acercarse en 10 s (un río, un muro, el jugador volando…), también
  const tooFar = !pe || d > FOLLOW_TP_DISTANCE || (d > 8 && now - (bot._followCloseAt || now) > 10000)
  if (tooFar) {
    const justLost = !pe && now - (bot._seenPlayerAt || 0) < 6000
    if (!justLost && now - (bot._followTpAt || 0) > FOLLOW_TP_GAP_MS) {
      bot._followTpAt = now
      if (now - (bot._followTpLogAt || 0) > 60000) {
        bot._followTpLogAt = now
        console.log(`${TAG} 🌀 ${plan.player} está ${Number.isFinite(d) ? `a ${Math.round(d)} bloques` : 'lejos'}: me teletransporto a su lado.`)
      }
      if (await teleportToPlayer(bot, plan.player, !!pe)) bot._followCloseAt = Date.now()
      bot._followGoalEntity = null
    }
    await sleep(400)
    return
  }

  // Caminando a su lado. Objetivo dinámico: el pathfinder solo recalcula la ruta cuando el jugador se mueve
  if (bot._followGoalEntity !== pe || !bot.pathfinder.goal) {
    bot.pathfinder.setGoal(new GoalFollow(pe, FOLLOW_RANGE), true)
    bot._followGoalEntity = pe
  }
  await holdSword(bot)
  await sleep(300)
}

/**
 * Teletransporte al lado del jugador. Con el plugin, solo si están en el mismo mundo (sameWorld): el /tp normal le
 * llevaría también al Nether. Sin el plugin, solo con /tp si lo está viendo (entonces seguro que están en el mismo).
 */
async function teleportToPlayer(bot, name, visible) {
  if (!bot.entity) return false
  const before = bot.entity.position.clone()
  haltPathfinder(bot)
  const sl = link()
  if (sl.isOnline()) {
    let r = null
    try { r = await sl.teleport(bot.username, { to: name, sameWorld: true }) } catch {}
    if (!r || !r.ok) return false
  } else if (visible) {
    bot.chat(`/tp ${bot.username} ${name}`)
  } else return false
  const moved = await waitUntil(() => bot.entity && bot.entity.position.distanceTo(before) > 3, 4000)
  if (moved) {
    stats.add(KEY, 'teletransportes')
    await sleep(800) // chunks de destino
  }
  return moved
}

async function exploreStep(bot, plan) {
  // Con zona en el mapa: primero ir a ella (con /tp si está lejos)
  if (plan.zone && await goToZone(bot)) return
  const pos = bot.entity.position
  const center = plan.center

  // Muy lejos de su sitio (p. ej. sin zona y tras una persecución larga): volver a casa con /tp y explorar desde allí
  if (!plan.zone && bot.home && distXZ(pos, center) > plan.roam + 48) {
    console.log(`${TAG} 🧭 Estoy a ${Math.round(distXZ(pos, center))} bloques de casa: vuelvo y exploro desde allí.`)
    await teleportTo(bot, bot.home)
    return
  }

  const wp = pickWaypoint(bot, center, plan.roam)
  if (!wp) { await sleep(2000); return }
  const r = await moveUntil(bot, new GoalNearXZ(wp.x, wp.z, 3), {
    maxMs: 30000, stallMs: 8000, check: () => (findPrey(bot, plan) ? 'prey' : null),
  })
  if (r === 'arrived' || r === 'prey' || r === 'command') { bot._exploreFails = 0; return }
  // No pudo avanzar: otro rumbo; tras varios intentos fallidos, de vuelta al centro con /tp
  bot._heading = Math.random() * Math.PI * 2
  bot._exploreFails = (bot._exploreFails || 0) + 1
  if (bot._exploreFails >= 4) {
    bot._exploreFails = 0
    console.log(`${TAG} 🧭 No consigo avanzar desde ${fmtPos(pos)}: vuelvo al centro de ${plan.zone ? 'mi zona' : 'mi zona de caza'}.`)
    if (plan.zone) {
      try { await link().teleport(bot.username, { x: plan.zone.x + 0.5, y: plan.zone.y, z: plan.zone.z + 0.5, surface: true }) } catch {}
      await sleep(1500)
    } else if (bot.home) await teleportTo(bot, bot.home)
  }
}

/** Siguiente punto al explorar: unos EXPLORE_STEP bloques en un rumbo que cambia poco a poco, sin salirse de `roam`. */
function pickWaypoint(bot, center, roam) {
  const pos = bot.entity.position
  if (bot._heading === undefined) bot._heading = Math.random() * Math.PI * 2
  for (let i = 0; i < 8; i++) {
    bot._heading += (Math.random() - 0.5) * (i === 0 ? 0.8 : 2.5)
    let tx = pos.x + Math.cos(bot._heading) * EXPLORE_STEP
    let tz = pos.z + Math.sin(bot._heading) * EXPLORE_STEP
    // Se saldría de su zona: girar hacia el centro
    if (center && Math.hypot(tx - center.x, tz - center.z) > roam) {
      bot._heading = Math.atan2(center.z - pos.z, center.x - pos.x) + (Math.random() - 0.5) * 1.2
      tx = pos.x + Math.cos(bot._heading) * EXPLORE_STEP
      tz = pos.z + Math.sin(bot._heading) * EXPLORE_STEP
    }
    // Al agua no (nadando no caza y se puede quedar atascado)
    const top = surfaceAt(bot, tx, tz, pos.y)
    if (top && (top.name === 'water' || top.name === 'lava')) continue
    return { x: Math.floor(tx), z: Math.floor(tz) }
  }
  return null
}

// Primer bloque sólido o líquido bajando desde un poco por encima de y. null si la columna no está cargada
function surfaceAt(bot, x, z, nearY) {
  const fx = Math.floor(x), fz = Math.floor(z)
  for (let y = Math.floor(nearY) + 12; y > nearY - 20; y--) {
    const b = bot.blockAt(new Vec3(fx, y, fz))
    if (!b) return null
    if (b.name === 'water' || b.name === 'lava' || b.boundingBox === 'block') return b
  }
  return null
}

// Vigilando la casa (el jugador que sigue no está): esperar junto a ella sin gastar CPU
async function waitStep(bot) {
  if (bot.home && bot.entity.position.distanceTo(bot.home) > 12) {
    if (bot.entity.position.distanceTo(bot.home) > 40) await teleportTo(bot, bot.home)
    else await moveUntil(bot, new GoalNear(bot.home.x, bot.home.y, bot.home.z, 3), { maxMs: 30000 })
    return
  }
  await holdSword(bot)
  await idleSleep(bot, 2000)
}

/**
 * Camina hacia `goal` hasta llegar, o hasta que check() devuelva un motivo para parar (p. ej. 'prey'). Devuelve
 * 'arrived' | 'nopath' | 'stuck' (sin acercarse stallMs) | 'timeout' | 'command' | 'stopped' | lo que devuelva check.
 */
function moveUntil(bot, goal, { maxMs = 30000, stallMs = 10000, check = null } = {}) {
  return new Promise(resolve => {
    if (bot.stopped || !bot.entity) return resolve('stopped')
    let done = false
    const start = Date.now()
    let best = Infinity, lastProgress = start
    const dist = () => (goal.x !== undefined && goal.z !== undefined ? distXZ(bot.entity.position, goal) : 0)
    const finish = (r) => {
      if (done) return
      done = true
      clearInterval(timer)
      bot.removeListener('path_update', onPath)
      bot.removeListener('goal_reached', onReached)
      if (r !== 'arrived') haltPathfinder(bot)
      resolve(r)
    }
    const onPath = (res) => { if (res && res.status === 'noPath') finish('nopath') }
    const onReached = () => finish('arrived')
    bot.on('path_update', onPath)
    bot.on('goal_reached', onReached)
    const timer = setInterval(() => {
      if (bot.stopped || !bot.entity) return finish('stopped')
      if (bot.pendingCommand) return finish('command')
      const why = check && check()
      if (why) return finish(why)
      const d = dist()
      if (d < best - 0.5) { best = d; lastProgress = Date.now() }
      const now = Date.now()
      if (now - lastProgress > stallMs) return finish('stuck')
      if (now - start > maxMs) return finish('timeout')
    }, 300)
    try {
      bot.pathfinder.setGoal(null) // descartar una parada pendiente de una ruta anterior
      bot.pathfinder.setGoal(goal)
    } catch { finish('nopath') }
  })
}

// Con la espada en la mano mientras no dispara (queda mejor que con flechas o carne podrida)
async function holdSword(bot) {
  const sword = bestSword(bot)
  if (sword && (!bot.heldItem || bot.heldItem.name !== sword.name)) {
    try { await bot.equip(sword, 'hand') } catch {}
  }
}

// ════════════════════════════════════════════════════════════
//  PRESAS
// ════════════════════════════════════════════════════════════
function isPrey(e) {
  if (!e || !e.position || !PREY_ES[e.name]) return false
  if (e.metadata && e.metadata[2]) return false // tiene nombre: es la mascota o el adorno de alguien
  return true
}

function alive(bot, e) {
  if (!e || bot.entities[e.id] !== e || e.isValid === false || bot._dead.has(e.id)) return false
  const hp = e.metadata && e.metadata[9] // vida (LivingEntity)
  return !(typeof hp === 'number' && hp <= 0)
}

/** El monstruo más urgente a tiro: cerca del jugador (o de casa, o de él), primero los creepers. */
function findPrey(bot, plan) {
  if (!bot.entity) return null
  const me = bot.entity.position
  const now = Date.now()
  const reach = canUseBow(bot) ? BOW_MAX : 24
  const anchor = plan.anchor()
  let best = null, bestScore = Infinity
  for (const e of Object.values(bot.entities)) {
    if (!isPrey(e) || !alive(bot, e)) continue
    const until = bot._ignore.get(e.id)
    if (until && until > now) continue
    const d = e.position.distanceTo(me)
    if (d > reach) continue
    // Dentro de lo que protege (los que tiene casi encima, siempre)
    const fromAnchor = e.position.distanceTo(anchor)
    if (fromAnchor > plan.radius && d > 6) continue
    // En el agua no se llega bien y las flechas se frenan: solo si está al lado
    if (d > 5 && inWater(bot, e)) continue
    // Uno que no se ve (tras una pared, bajo tierra) solo si está cerca y a su altura
    if (!canSee(bot, e) && (d > SIGHT_NO_LOS || Math.abs(e.position.y - me.y) > 4)) continue
    let score = d + (plan.mode === 'follow' ? fromAnchor : 0)
    if (e.name === 'creeper') score -= 12 // los creepers primero: revientan lo que tengan cerca
    if (score < bestScore) { best = e; bestScore = score }
  }
  return best
}

function inWater(bot, e) {
  const b = bot.blockAt(e.position.floored())
  return !!b && (b.name === 'water' || b.name === 'bubble_column')
}

// ¿Lo ve? Recta desde sus ojos hasta el centro del monstruo sin bloques en medio
function canSee(bot, e) {
  const eye = eyePos(bot)
  const target = e.position.offset(0, (e.height || 1) * 0.6, 0)
  const delta = target.minus(eye)
  const dist = delta.norm()
  if (dist < 1) return true
  try {
    return !bot.world.raycast(eye, delta.normalize(), dist)
  } catch {
    return true
  }
}

// Distancia de sus ojos al punto más cercano del cuerpo del monstruo (lo que cuenta para un golpe)
function reachDistance(bot, e) {
  const eye = eyePos(bot)
  const w = (e.width || 0.6) / 2, h = e.height || 1.8
  const cx = clamp(eye.x, e.position.x - w, e.position.x + w)
  const cy = clamp(eye.y, e.position.y, e.position.y + h)
  const cz = clamp(eye.z, e.position.z - w, e.position.z + w)
  return Math.hypot(eye.x - cx, eye.y - cy, eye.z - cz)
}

function ignore(bot, e, ms = IGNORE_MS) {
  bot._ignore.set(e.id, Date.now() + ms)
}

// ════════════════════════════════════════════════════════════
//  COMBATE
// ════════════════════════════════════════════════════════════
async function fight(bot, target, plan) {
  const startedAt = Date.now()
  const startPos = bot.entity.position.clone()
  let lastSwing = 0, lastProgressAt = startedAt, best = Infinity, chasing = false, shots = 0, bowPausedUntil = 0
  bot._lastPreyId = target.id
  bot._lootMark = inventoryCounts(bot)
  bot.huntState = `⚔️ Cazando: ${preyName(target.name)}`
  try {
    while (!bot.stopped && !bot.pendingCommand && bot.entity && alive(bot, target)) {
      const now = Date.now()
      bot._lastPreyAt = now
      trackTarget(bot, target)
      if (now - startedAt > FIGHT_MAX_MS) { ignore(bot, target); break }

      // No alejarse por perseguirlo: del jugador (o de casa) cuando protege, del punto de partida cuando explora
      if (plan.mode === 'explore') {
        if (target.position.distanceTo(startPos) > 48) { ignore(bot, target); break }
      } else if (target.position.distanceTo(plan.anchor()) > plan.radius + 12) {
        ignore(bot, target, 30000)
        break
      }

      const d = reachDistance(bot, target)
      if (d < best - 0.3) { best = d; lastProgressAt = now }
      if (bot._lastHitOn === target.id && now - (bot._lastHitAt || 0) < 2000) lastProgressAt = now
      if (now - lastProgressAt > CHASE_STALL_MS) {
        console.log(`${TAG} 🤷 No llego hasta el monstruo (${preyName(target.name)}) de ${fmtPos(target.position)}: lo dejo.`)
        ignore(bot, target)
        break
      }

      if (d <= MELEE_REACH) {
        // Cuerpo a cuerpo. Al cambiar de objeto en la mano la espada empieza a recargar de cero
        const sword = bestSword(bot)
        if (sword && (!bot.heldItem || bot.heldItem.name !== sword.name)) {
          try { await bot.equip(sword, 'hand') } catch {}
          lastSwing = Date.now()
        }
        if (Date.now() - lastSwing >= SWORD_COOLDOWN_MS && alive(bot, target)) {
          await bot.lookAt(target.position.offset(0, (target.height || 1) * 0.6, 0), true)
          bot._lastSwingAt = Date.now()
          bot.attack(target)
          lastSwing = bot._lastSwingAt
        }
      } else if (now >= bowPausedUntil && shots < MAX_SHOTS && d >= BOW_MIN && d <= BOW_MAX && canUseBow(bot)) {
        // De lejos, con el arco
        if (chasing) { haltPathfinder(bot); chasing = false }
        const r = await shootBow(bot, target)
        if (r === 'shot') { shots++; lastProgressAt = Date.now() }
        else if (r === 'blocked') bowPausedUntil = Date.now() + 3000 // sin tiro limpio: acercarse un poco y volver a probar
        continue
      } else if (!chasing) {
        bot.pathfinder.setGoal(new GoalFollow(target, 1.5), true)
        chasing = true
      }
      await sleep(100)
    }
  } finally {
    haltPathfinder(bot)
    bot._track.delete(target.id)
    // Tras una pelea lejos del jugador, 10 s para volver andando antes de recurrir al teletransporte
    bot._followCloseAt = Date.now()
  }
  // Sin el plugin 1.6 el botín cae al suelo: recogerlo
  if (!alive(bot, target) && !link().hasFeature('mob-loot')) {
    await sleep(400)
    await collectNearbyItems(bot, 8)
  }
}

/**
 * Un flechazo: tensa el arco (1 s) apuntando todo el rato y suelta. Devuelve 'shot', 'blocked' (no hay tiro limpio:
 * una pared, o alguien que no es una presa en la trayectoria) o 'gone' (el monstruo murió o desapareció).
 */
async function shootBow(bot, target) {
  const bow = bot.inventory.items().find(i => i.name === 'bow')
  if (!bow) return 'blocked'
  let aim = aimAt(bot, target)
  if (!aim || !shotIsClear(bot, aim, target)) return 'blocked'
  if (!bot.heldItem || bot.heldItem.name !== 'bow') {
    try { await bot.equip(bow, 'hand') } catch { return 'blocked' }
  }
  await bot.look(aim.yaw, aim.pitch, true)
  bot.activateItem()
  const drawStart = Date.now()
  while (Date.now() - drawStart < BOW_DRAW_MS) {
    await sleep(100)
    if (bot.stopped || bot.pendingCommand || !bot.entity || !alive(bot, target)) { await cancelDraw(bot); return 'gone' }
    trackTarget(bot, target)
    aim = aimAt(bot, target)
    if (aim) await bot.look(aim.yaw, aim.pitch, true)
  }
  aim = aimAt(bot, target)
  if (!aim || !shotIsClear(bot, aim, target)) { await cancelDraw(bot); return 'blocked' }
  await bot.look(aim.yaw, aim.pitch, true)
  // Soltar cuando el servidor ya tenga la nueva dirección (se manda en el siguiente tick de física)
  try { await bot.waitForTicks(2) } catch {}
  bot.deactivateItem()
  bot._lastShotAt = Date.now()
  stats.add(KEY, 'flechas')
  await sleep(200)
  return 'shot'
}

// Cancelar el disparo sin soltar la flecha: cambiar de objeto en la mano
async function cancelDraw(bot) {
  const sword = bestSword(bot)
  try {
    if (sword) await bot.equip(sword, 'hand')
    else bot.setQuickBarSlot((bot.quickBarSlot + 1) % 9)
  } catch {}
  bot.usingHeldItem = false
}

/**
 * Hacia dónde apuntar: dirección (yaw) y ángulo (pitch) del tiro tenso que pasa por el centro del monstruo, contando
 * con la caída de la flecha y con dónde estará el monstruo cuando llegue (su velocidad de los últimos 0,6 s).
 */
function aimAt(bot, target) {
  const src = bot.entity.position.offset(0, (bot.entity.eyeHeight || 1.62) - 0.1, 0) // sale 0,1 bajo los ojos
  const vel = velocityOf(bot, target)
  const lift = (target.height || 1) * 0.5
  let point = target.position.offset(0, lift, 0)
  let sol = null
  for (let i = 0; i < 3; i++) {
    sol = solvePitch(distXZ(src, point), point.y - src.y)
    if (!sol) return null
    if (i < 2) point = target.position.offset(vel.x * sol.ticks, lift + clamp(vel.y * sol.ticks, -3, 3), vel.z * sol.ticks)
  }
  return { yaw: Math.atan2(-(point.x - src.x), -(point.z - src.z)), pitch: sol.pitch, ticks: sol.ticks, point, src }
}

/** Altura (relativa a la salida) de la flecha al recorrer `dist` bloques en horizontal con el ángulo `pitch`. */
function arrowAt(pitch, dist) {
  let x = 0, y = 0
  let vx = Math.cos(pitch) * ARROW_SPEED, vy = Math.sin(pitch) * ARROW_SPEED
  for (let t = 0; t < 100; t++) {
    if (x + vx >= dist) {
      const f = (dist - x) / vx
      return { y: y + vy * f, ticks: t + f }
    }
    x += vx
    y += vy
    vx *= ARROW_DRAG
    vy = vy * ARROW_DRAG - ARROW_GRAVITY
  }
  return null
}

/** Ángulo más bajo (tiro tenso) con el que la flecha pasa por (dist, dy), y los ticks que tarda. null si no llega. */
function solvePitch(dist, dy) {
  // Hasta el ángulo con el que la flecha llega más alto a esa distancia (de lejos ronda los 40°; de cerca, para una araña
  // en una pared o un phantom encima, es más empinado). Por encima de ese ángulo serían tiros bombeados, lentos e imprecisos
  let hi = 0, hiY = -Infinity
  for (let p = 0; p <= 1.35; p += 0.05) {
    const r = arrowAt(p, dist)
    if (r && r.y > hiY) { hiY = r.y; hi = p }
  }
  if (hiY < dy) return null
  let lo = -1.35
  for (let i = 0; i < 25; i++) {
    const mid = (lo + hi) / 2
    const r = arrowAt(mid, dist)
    if (r && r.y >= dy) hi = mid
    else lo = mid
  }
  const r = arrowAt(hi, dist)
  return r ? { pitch: hi, ticks: r.ticks } : null
}

/**
 * ¿Tiro limpio? Recorre la trayectoria de la flecha (en cuartos de tick) hasta el monstruo: ni bloques sólidos ni
 * nadie que no sea una presa (jugadores, otros bots, aldeanos, animales, mascotas, soportes de armadura…) cerca.
 */
function shotIsClear(bot, aim, target) {
  const { src, yaw, pitch } = aim
  const goal = distXZ(src, aim.point) - (target.width || 0.6) / 2
  const others = Object.values(bot.entities).filter(e => e !== bot.entity && e !== target && e.position &&
    !isPrey(e) && !ARROW_PASSES.has(e.name) && e.position.distanceTo(src) < goal + 4)
  let pos = src.clone()
  let vel = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).scaled(ARROW_SPEED)
  for (let t = 0; t < 100; t++) {
    for (let s = 1; s <= 4; s++) {
      const p = pos.plus(vel.scaled(s / 4))
      if (distXZ(src, p) >= goal) return true
      const b = bot.blockAt(p.floored())
      if (!b || b.boundingBox === 'block') return false // sin cargar, o un bloque en medio
      if (others.some(e => insideBox(p, e, 0.4))) return false
    }
    pos = pos.plus(vel)
    vel = new Vec3(vel.x * ARROW_DRAG, vel.y * ARROW_DRAG - ARROW_GRAVITY, vel.z * ARROW_DRAG)
  }
  return false
}

function insideBox(p, e, pad) {
  const w = (e.width || 0.6) / 2 + pad
  const h = e.height || 1.8
  return Math.abs(p.x - e.position.x) <= w && Math.abs(p.z - e.position.z) <= w &&
    p.y >= e.position.y - pad && p.y <= e.position.y + h + pad
}

// Posiciones recientes del monstruo (para calcular su velocidad: la que manda el servidor no es fiable con ViaBackwards)
function trackTarget(bot, e) {
  const list = bot._track.get(e.id) || []
  const now = Date.now()
  list.push({ t: now, p: e.position.clone() })
  while (list.length && now - list[0].t > 600) list.shift()
  bot._track.set(e.id, list)
}

// Bloques por tick
function velocityOf(bot, e) {
  const list = bot._track.get(e.id)
  if (!list || list.length < 2) return new Vec3(0, 0, 0)
  const a = list[0], b = list[list.length - 1]
  const ticks = (b.t - a.t) / 50
  if (ticks < 2) return new Vec3(0, 0, 0)
  return b.p.minus(a.p).scaled(1 / ticks)
}

/**
 * Golpes y presas: el servidor avisa de cada daño con quién lo causó (también de los flechazos: el causante es quien
 * disparó) y de cada muerte. Una presa que muere poco después de un golpe o flechazo suyo cuenta como cazada.
 */
function trackCombat(bot) {
  bot._hits = new Map()   // id → { t, by: 'espada' | 'arco' }
  bot._ignore = new Map() // id → hasta cuándo no perseguirlo
  bot._track = new Map()  // id → posiciones recientes
  bot._dead = new Set()

  bot.on('entityHurt', (e, source) => {
    if (!e || !source || !bot.entity || source.id !== bot.entity.id || !PREY_ES[e.name]) return
    const melee = Date.now() - (bot._lastSwingAt || 0) < 500
    bot._hits.set(e.id, { t: Date.now(), by: melee ? 'espada' : 'arco' })
    bot._lastHitOn = e.id
    bot._lastHitAt = Date.now()
    if (!melee) stats.add(KEY, 'aciertos')
  })

  bot.on('entityDead', (e) => {
    if (!e || !PREY_ES[e.name]) return
    bot._dead.add(e.id)
    let hit = bot._hits.get(e.id)
    if (hit && Date.now() - hit.t > 5000) hit = null
    // Por si el servidor no dijo quién le dio: el que estaba cazando ahora mismo
    if (!hit && bot._lastPreyId === e.id && Date.now() - (bot._lastPreyAt || 0) < 4000) hit = { by: 'espada' }
    if (!hit) return
    bot._hits.delete(e.id)
    stats.add(KEY, 'cazados')
    stats.addDetail('caza', e.name)
    const dist = bot.entity ? Math.round(bot.entity.position.distanceTo(e.position)) : 0
    setTimeout(() => logKill(bot, e, hit, dist), 400) // que llegue antes el botín al inventario
  })
}

function logKill(bot, e, hit, dist) {
  if (bot.stopped) return
  const loot = lootSinceMark(bot)
  const how = hit.by === 'arco' ? `de un flechazo a ${dist} bloques` : 'con la espada'
  console.log(`${TAG} ${hit.by === 'arco' ? '🎯' : '🗡️'} Caza: ${preyName(e.name)} ${how}${loot ? ` (+${loot})` : ''}.`)
}

// Botín: lo que hay de más en el inventario desde que empezó la pelea (o desde la presa anterior de esa pelea). Se mide
// desde el principio de cada pelea para no contar como botín las flechas de /give ni lo que saca de su cofre
function inventoryCounts(bot) {
  const c = {}
  for (const i of bot.inventory.items()) c[i.name] = (c[i.name] || 0) + i.count
  return c
}
function lootSinceMark(bot) {
  const now = inventoryCounts(bot)
  const before = bot._lootMark || now
  bot._lootMark = now
  return Object.entries(now)
    .filter(([name, n]) => n > (before[name] || 0))
    .map(([name, n]) => `${LOOT_ES[name] || name.replace(/_/g, ' ')} ×${n - (before[name] || 0)}`)
    .join(', ')
}

// Limpieza de memorias de presas que ya no existen
function pruneMemory(bot) {
  const now = Date.now()
  if (now - (bot._prunedAt || 0) < 30000) return
  bot._prunedAt = now
  for (const [id, until] of bot._ignore) if (until < now) bot._ignore.delete(id)
  for (const [id, h] of bot._hits) if (now - h.t > 60000) bot._hits.delete(id)
  for (const id of bot._track.keys()) if (!bot.entities[id]) bot._track.delete(id)
  for (const id of bot._dead) if (!bot.entities[id]) bot._dead.delete(id)
}

// ════════════════════════════════════════════════════════════
//  EQUIPO
// ════════════════════════════════════════════════════════════
async function ensureGear(bot) {
  const h = hunterCfg()
  // Sin espada o sin arco: a casa a por el repuesto que deja el Artesano (como mucho un viaje cada 10 min)
  if (bot.home && !bestSword(bot)) await withdrawToolsFromChest(bot, SWORDS, { travel: true })
  if (bot.home && h.useBow !== false && !hasItem(bot, 'bow')) await withdrawToolsFromChest(bot, ['bow'], { travel: true })

  if (bestSword(bot)) clearIssue(bot, 'sword')
  else setIssue(bot, 'sword', 'warn', 'Sin espada: pelea con los puños (el Artesano le hará una)')
  if (h.useBow === false || hasItem(bot, 'bow')) clearIssue(bot, 'bow')
  else setIssue(bot, 'bow', 'warn', 'Sin arco: solo caza cuerpo a cuerpo')

  // Flechas: las que sueltan los esqueletos y, si se acaban, se las da con /give
  if (h.useBow !== false && hasItem(bot, 'bow') && countOf(bot, 'arrow') < ARROWS_LOW &&
      Date.now() - (bot._arrowsGivenAt || 0) > ARROWS_GIVE_GAP_MS) {
    bot._arrowsGivenAt = Date.now()
    console.log(`${TAG} 🏹 Me quedan ${countOf(bot, 'arrow')} flechas: me doy ${ARROWS_GIVE}.`)
    await giveItem(bot, 'arrow', ARROWS_GIVE)
  }
}

// ════════════════════════════════════════════════════════════
//  ÓRDENES DESDE EL JUEGO
// ════════════════════════════════════════════════════════════
/**
 *   !cazador sigueme  → modo seguir (a quien lo escribe)
 *   !cazador explora  → modo explorar
 *   !cazador auto     → modo automático (sigue a quien lo escribe cuando está conectado)
 *   !cazador ven      → se teletransporta a su lado ahora
 *   !cazador casa     → vuelve a casa a guardar lo que lleva
 */
function handleChat(bot, username, message) {
  if (!username || username === bot.username || !/^!cazador\b/i.test(String(message).trim())) return
  if (botNames().has(username.toLowerCase())) return
  const arg = plain(String(message).trim().split(/\s+/)[1])
  const settings = require('../panel/settings')
  const set = (p, v) => settings.update(p, v).ok

  if (['sigueme', 'seguir', 'sigue'].includes(arg)) {
    set('hunter.player', username)
    set('hunter.mode', 'follow')
    bot.chat(`Te sigo, ${username}. (!cazador explora para que cace por mi cuenta)`)
  } else if (['explora', 'explorar'].includes(arg)) {
    set('hunter.mode', 'explore')
    bot.chat('Me voy a explorar y cazar por mi cuenta. (!cazador sigueme para volver contigo)')
  } else if (['auto', 'automatico'].includes(arg)) {
    set('hunter.player', username)
    set('hunter.mode', 'auto')
    bot.chat(`Modo automatico: te sigo cuando estes conectado, ${username}; si no, exploro.`)
  } else if (['ven', 'aqui'].includes(arg)) {
    bot.chat('Voy.')
    teleportToPlayer(bot, username, !!(bot.players[username] && bot.players[username].entity)).catch(() => {})
  } else if (arg === 'casa') {
    requestCommand(bot, 'gohome')
    bot.chat('Voy a casa a guardar lo que llevo.')
  } else {
    bot.chat('Ordenes: !cazador sigueme | explora | auto | ven | casa')
    return
  }
  console.log(`${TAG} 🗣️ ${username}: ${String(message).trim()}`)
}

module.exports = { createBot }

// Ejecutado directamente (node bots/hunter.js) arranca solo; desde el panel lo controla panel.js
if (require.main === module) createBot()
