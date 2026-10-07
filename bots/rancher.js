// ============================================================
//  bots/rancher.js — Bot Ganadero (vacas)
//  1. Construye un corral de vallas (con puerta) alrededor de su casa
//  2. Si hay menos de 2 vacas, las invoca con /summon (requiere OP)
//  3. Las alimenta con trigo por parejas para que críen
//  4. Si se supera el máximo, sacrifica adultas sobrantes (carne y cuero)
//  5. Guarda lo obtenido en el cofre de casa (dentro del corral)
//  El material (vallas, trigo, espada) lo consigue con /give si le falta.
// ============================================================
const mineflayer = require('mineflayer')
const { pathfinder, goals: { GoalNear } } = require('mineflayer-pathfinder')
const { loader: autoEat } = require('mineflayer-auto-eat')
const Vec3 = require('vec3')
const cfg = require('../config')
const stats = require('./stats')
const {
  botOptions,
  setupBot,
  safeGoto,
  inReach,
  teleportTo,
  waitUntil,
  returnHomeAndDeposit,
  runPendingCommand,
  isInventoryFull,
  collectNearbyItems,
  sleep,
  fmtPos,
} = require('./common')

const rCfg = Object.assign({
  penRadius: 6, maxCows: 10, minBreeders: 2, breedCooldownMinutes: 5, cycleSeconds: 15,
}, cfg.rancher)

const FENCE = 'oak_fence'
const GATE = 'oak_fence_gate'
const SWORDS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword']
const BABY_METADATA_INDEX = 16 // metadata "baby" de los animales (minecraft-data 1.21.4)
const PEN_CHECK_MS = 5 * 60 * 1000
const SUMMON_RETRY_MS = 2 * 60 * 1000
const DEPOSIT_AT = 16

// Al guardar se queda trigo para criar y su espada
const KEEP_AMOUNTS = { wheat: 64, ...Object.fromEntries(SWORDS.map(s => [s, 1])), [FENCE]: 16, [GATE]: 1 }

function createBot(ctrl = {}) {
  const bot = mineflayer.createBot(botOptions('rancher'))

  bot.loadPlugin(pathfinder)
  bot.loadPlugin(autoEat)

  setupBot(bot, 'Ganadero', () => createBot(ctrl), 'rancher', ctrl)

  bot.once('spawn', () => {
    console.log(`[${cfg.bots.rancher.username}] 🐄 Conectado. Preparando el corral...`)
    setTimeout(() => workLoop(bot), 3000)
  })

  return bot
}

async function workLoop(bot) {
  bot.depositRules = { keep: [], amounts: KEEP_AMOUNTS }
  const lastFed = new Map() // id de vaca → momento en que comió (no puede volver a criar hasta el cooldown)
  let nextPenCheck = 0
  let penComplete = false
  let lastSummon = 0
  let lastNoHomeMsg = 0
  let lastSummary = ''
  // Nada más conectarse el servidor aún no ha enviado las vacas cercanas: sin esta espera
  // el corral "parece" vacío y se invocarían vacas de más
  const summonAllowedAt = Date.now() + 20000
  let prevBabies = null // para contar nacimientos (sube el número de crías)

  while (!bot.stopped) {
    try {
      if (await runPendingCommand(bot)) continue

      if (!bot.home) {
        if (Date.now() - lastNoHomeMsg > 60000) {
          console.log('[Ganadero] 🏠 Sin casa. Pon un cofre donde quieras el corral, hazme TP al lado y usa "!casa ganadero" (o "Fijar casa").')
          lastNoHomeMsg = Date.now()
        }
        await sleep(10000)
        continue
      }

      // Si se ha salido del corral (empujado, caída…), volver dentro
      if (!inPen(bot, bot.entity.position)) {
        await teleportTo(bot, bot.home)
      }

      // ── 1. Corral ────────────────────────────────────────────
      if (Date.now() >= nextPenCheck) {
        penComplete = await buildPen(bot)
        nextPenCheck = Date.now() + (penComplete ? PEN_CHECK_MS : 30000)
      }

      // ── 2. Población ─────────────────────────────────────────
      let cows = cowsInPen(bot)
      let adults = cows.filter(c => !isBaby(c))

      // Pocas vacas: invocar las que falten hasta 2 (solo con el corral cerrado, si no se escapan)
      if (penComplete && Date.now() >= summonAllowedAt && adults.length < 2 && cows.length < rCfg.maxCows && Date.now() - lastSummon > SUMMON_RETRY_MS) {
        lastSummon = Date.now()
        await summonCows(bot, 2 - adults.length)
        cows = cowsInPen(bot)
        adults = cows.filter(c => !isBaby(c))
      }

      // Nacimientos: el número de crías sube (tras la espera inicial, cuando ya se ven todas las vacas)
      const babies = cows.length - adults.length
      if (Date.now() >= summonAllowedAt) {
        if (prevBabies !== null && babies > prevBabies) stats.add('rancher', 'terneros', babies - prevBabies)
        prevBabies = babies
      }

      const summary = `${adults.length} adultas + ${cows.length - adults.length} crías`
      if (summary !== lastSummary) {
        console.log(`[Ganadero] 🐄 Vacas: ${summary} (máximo ${rCfg.maxCows}).`)
        lastSummary = summary
      }

      // ── 3. Sacrificar si se supera el máximo ─────────────────
      if (cows.length > rCfg.maxCows) {
        await cull(bot, adults, cows.length - rCfg.maxCows)
      } else if (cows.length < rCfg.maxCows && adults.length >= 2) {
        // ── 4. Criar ───────────────────────────────────────────
        await breed(bot, adults, rCfg.maxCows - cows.length, lastFed)
      }

      // ── 5. Recoger y guardar ─────────────────────────────────
      await collectNearbyItems(bot, rCfg.penRadius + 2)
      if (depositableCount(bot) >= DEPOSIT_AT || isInventoryFull(bot)) {
        await returnHomeAndDeposit(bot, [], KEEP_AMOUNTS)
      }

      await sleep(rCfg.cycleSeconds * 1000)
    } catch (err) {
      console.warn(`[Ganadero] ⚠️ ${err.message}`)
      await sleep(5000)
    }
  }
}

// ── Corral ───────────────────────────────────────────────────
function inPen(bot, pos) {
  const c = bot.home
  return Math.abs(pos.x - (c.x + 0.5)) < rCfg.penRadius && Math.abs(pos.z - (c.z + 0.5)) < rCfg.penRadius
}

// Posiciones (x, z) del anillo de vallas, recorriéndolo en orden; la puerta va en el centro del lado sur
function ringPositions(bot) {
  const R = rCfg.penRadius
  const c = bot.home
  const ring = []
  for (let dx = -R; dx <= R; dx++) ring.push([dx, -R])
  for (let dz = -R + 1; dz <= R; dz++) ring.push([R, dz])
  for (let dx = R - 1; dx >= -R; dx--) ring.push([dx, R])
  for (let dz = R - 1; dz > -R; dz--) ring.push([-R, dz])
  return ring.map(([dx, dz]) => ({ x: c.x + dx, z: c.z + dz, gate: dx === 0 && dz === R }))
}

// Altura del suelo en (x, z) cerca de la altura de casa: bloque sólido (que no sea una valla)
// con encima algo no sólido o una valla. Las vallas tienen caja de colisión de bloque completo,
// así que sin excluirlas el bot tomaría una valla ya puesta por suelo y pondría otra encima.
function groundAt(bot, x, z) {
  const base = bot.home.y
  for (let y = base + 4; y >= base - 5; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    const above = bot.blockAt(new Vec3(x, y + 1, z))
    if (!b || !above || isFenceLike(b)) continue
    if (b.boundingBox === 'block' && (above.boundingBox !== 'block' || isFenceLike(above))) return b
  }
  return null
}

function isFenceLike(block) {
  return !!block && (block.name.endsWith('_fence') || block.name.endsWith('_fence_gate') || block.name.endsWith('_wall'))
}

/** Coloca las vallas que falten. Devuelve true si el corral queda completo. */
async function buildPen(bot) {
  await removeStackedFences(bot)
  const todo = []
  let unevenWarned = false
  let prevY = null
  for (const spot of ringPositions(bot)) {
    const ground = groundAt(bot, spot.x, spot.z)
    if (!ground) continue
    if (prevY !== null && Math.abs(ground.position.y - prevY) > 1 && !unevenWarned) {
      console.warn('[Ganadero] ⛰️ El terreno del corral es irregular: las vacas podrían escaparse por los desniveles. Mejor un sitio llano.')
      unevenWarned = true
    }
    prevY = ground.position.y
    const target = bot.blockAt(ground.position.offset(0, 1, 0))
    if (isFenceLike(target)) continue
    todo.push({ ...spot, ground })
  }
  if (todo.length === 0) return true

  console.log(`[Ganadero] 🚧 Construyendo el corral: faltan ${todo.length} vallas.`)
  const fencesNeeded = todo.filter(t => !t.gate).length
  if (!await ensureItem(bot, FENCE, fencesNeeded)) return false
  if (todo.some(t => t.gate) && !await ensureItem(bot, GATE, 1)) return false

  let placed = 0
  for (const t of todo) {
    if (bot.stopped || bot.pendingCommand) break
    const targetPos = t.ground.position.offset(0, 1, 0)

    // Acercarse desde dentro del corral (2 bloques hacia el centro)
    const inward = new Vec3(
      targetPos.x + Math.sign(bot.home.x - targetPos.x) * 2,
      targetPos.y,
      targetPos.z + Math.sign(bot.home.z - targetPos.z) * 2,
    )
    if (!inReach(bot, t.ground)) {
      await safeGoto(bot, new GoalNear(inward.x, inward.y, inward.z, 1), 10)
      if (!inReach(bot, t.ground)) continue
    }

    // Quitar hierba, flores o lo que ocupe el hueco
    const occupant = bot.blockAt(targetPos)
    if (occupant && occupant.name !== 'air' && occupant.name !== 'cave_air') {
      if (!occupant.diggable || occupant.name.includes('chest')) continue
      try { await bot.dig(occupant) } catch { continue }
    }
    // No ponerla donde está el propio bot
    const feet = bot.entity.position.floored()
    if (feet.equals(targetPos) || feet.offset(0, 1, 0).equals(targetPos)) continue

    try {
      await bot.equip(bot.inventory.items().find(i => i.name === (t.gate ? GATE : FENCE)), 'hand')
      await bot.placeBlock(bot.blockAt(t.ground.position), new Vec3(0, 1, 0))
      placed++
    } catch {}
    await sleep(100)
  }

  const missing = ringPositions(bot).filter(s => {
    const g = groundAt(bot, s.x, s.z)
    return g && !isFenceLike(bot.blockAt(g.position.offset(0, 1, 0)))
  }).length
  if (placed > 0) console.log(`[Ganadero] 🚧 Colocadas ${placed} vallas.${missing ? ` Faltan ${missing} (reintentaré).` : ' ¡Corral terminado!'}`)
  return missing === 0
}

/** Quita vallas apiladas sobre otras en el anillo del corral (una versión anterior las ponía por error). */
async function removeStackedFences(bot) {
  let removed = 0
  for (const spot of ringPositions(bot)) {
    if (bot.stopped || bot.pendingCommand) break
    const ground = groundAt(bot, spot.x, spot.z)
    if (!ground) continue
    const first = bot.blockAt(ground.position.offset(0, 1, 0))
    const extra = bot.blockAt(ground.position.offset(0, 2, 0))
    if (!isFenceLike(first) || !extra || !extra.name.endsWith('_fence')) continue

    if (!inReach(bot, extra)) {
      const inward = new Vec3(
        extra.position.x + Math.sign(bot.home.x - extra.position.x) * 2,
        ground.position.y + 1,
        extra.position.z + Math.sign(bot.home.z - extra.position.z) * 2,
      )
      await safeGoto(bot, new GoalNear(inward.x, inward.y, inward.z, 1), 10)
      if (!inReach(bot, extra)) continue
    }
    try {
      await bot.dig(extra)
      removed++
    } catch {}
  }
  if (removed > 0) {
    console.log(`[Ganadero] 🧹 Quité ${removed} vallas que estaban apiladas sobre otras.`)
    await sleep(500)
    await collectNearbyItems(bot, rCfg.penRadius + 2)
  }
}

// ── Vacas ────────────────────────────────────────────────────
function cowsInPen(bot) {
  return Object.values(bot.entities).filter(e => e.name === 'cow' && e.position && inPen(bot, e.position))
}

function isBaby(entity) {
  return !!(entity.metadata && entity.metadata[BABY_METADATA_INDEX])
}

async function summonCows(bot, n) {
  const g = groundAt(bot, bot.home.x + 2, bot.home.z + 2) || groundAt(bot, bot.home.x, bot.home.z)
  const y = g ? g.position.y + 1 : bot.home.y + 1
  const before = cowsInPen(bot).length
  for (let i = 0; i < n; i++) {
    bot.chat(`/summon cow ${bot.home.x + 2.5} ${y} ${bot.home.z + 2.5}`)
    await sleep(400)
  }
  const ok = await waitUntil(() => cowsInPen(bot).length > before, 3000)
  if (ok) console.log(`[Ganadero] ✨ Invoqué ${n} vaca(s) para empezar la cría.`)
  else console.warn(`[Ganadero] No pude invocar vacas con /summon. ¿Es OP? Ejecuta en la consola del servidor: op ${bot.username}`)
}

/** Da de comer trigo a parejas de adultas que puedan criar (sin pasarse del máximo). */
async function breed(bot, adults, room, lastFed) {
  const cooldown = rCfg.breedCooldownMinutes * 60 * 1000 + 15000
  const now = Date.now()
  const ready = adults.filter(c => now - (lastFed.get(c.id) || 0) > cooldown)
  const pairs = Math.min(Math.floor(ready.length / 2), room) // cada pareja da 1 cría
  if (pairs === 0) return
  if (!await ensureItem(bot, 'wheat', pairs * 2)) return

  let fed = 0
  for (const cow of ready.slice(0, pairs * 2)) {
    if (bot.stopped || bot.pendingCommand) break
    if (!bot.entities[cow.id]) continue
    if (bot.entity.position.distanceTo(cow.position) > 2.5) {
      await safeGoto(bot, new GoalNear(cow.position.x, cow.position.y, cow.position.z, 1), 6)
    }
    // El alcance para interactuar con animales es de unos 3 bloques
    if (!bot.entities[cow.id] || bot.entity.position.distanceTo(cow.position) > 3) continue
    try {
      await bot.equip(bot.inventory.items().find(i => i.name === 'wheat'), 'hand')
      const before = countItem(bot, ['wheat'])
      // En este servidor el clic simple (activateEntity) no da de comer: hay que hacer clic
      // en un punto del animal (interact_at), como hace el cliente de verdad
      await bot.activateEntityAt(cow, cow.position.offset(0, 1, 0))
      await sleep(400)
      if (countItem(bot, ['wheat']) < before) {
        lastFed.set(cow.id, Date.now())
        fed++
      }
    } catch {}
  }
  if (fed > 0) {
    console.log(`[Ganadero] 💕 Alimenté ${fed} vaca(s) (comieron de verdad) para criar.`)
    stats.add('rancher', 'alimentadas', fed)
  }
}

/** Sacrifica `excess` adultas, dejando siempre rCfg.minBreeders para seguir criando. */
async function cull(bot, adults, excess) {
  const n = Math.min(excess, adults.length - rCfg.minBreeders)
  if (n <= 0) return
  if (!await ensureItem(bot, 'diamond_sword', 1, SWORDS)) return

  let killed = 0
  for (const cow of adults.slice(0, n)) {
    if (bot.stopped || bot.pendingCommand) break
    const sword = bot.inventory.items().find(i => SWORDS.includes(i.name))
    if (sword) await bot.equip(sword, 'hand')
    const deadline = Date.now() + 12000
    while (bot.entities[cow.id] && Date.now() < deadline && !bot.stopped) {
      if (bot.entity.position.distanceTo(cow.position) > 3) {
        await safeGoto(bot, new GoalNear(cow.position.x, cow.position.y, cow.position.z, 2), 5)
        continue
      }
      await bot.lookAt(cow.position.offset(0, 1, 0), true)
      bot.attack(cow)
      await sleep(700) // cadencia de ataque de la espada
    }
    if (!bot.entities[cow.id]) killed++
  }
  if (killed > 0) {
    console.log(`[Ganadero] 🔪 Sacrifiqué ${killed} vaca(s) para no pasar de ${rCfg.maxCows}.`)
    stats.add('rancher', 'sacrificadas', killed)
    await sleep(800)
    await collectNearbyItems(bot, rCfg.penRadius + 2)
  }
}

// ── Inventario ───────────────────────────────────────────────
function countItem(bot, names) {
  return bot.inventory.items().filter(i => names.includes(i.name)).reduce((a, i) => a + i.count, 0)
}

function depositableCount(bot) {
  return bot.inventory.items()
    .reduce((acc, i) => acc + i.count, 0) - Object.entries(KEEP_AMOUNTS)
    .reduce((acc, [name, keep]) => acc + Math.min(keep, countItem(bot, [name])), 0)
}

/**
 * Se asegura de tener al menos `needed` del objeto; si no, se lo da con /give (requiere OP).
 * `anyOf` permite aceptar alternativas (p. ej. cualquier espada).
 */
async function ensureItem(bot, itemName, needed, anyOf = [itemName]) {
  if (countItem(bot, anyOf) >= needed) return true
  const amount = Math.max(needed - countItem(bot, anyOf), itemName === 'diamond_sword' ? 1 : 16)
  bot.chat(`/give ${bot.username} ${itemName} ${amount}`)
  const ok = await waitUntil(() => countItem(bot, anyOf) >= needed, 3000)
  if (!ok) console.warn(`[Ganadero] No pude darme ${itemName} con /give. ¿Es OP? Ejecuta en la consola del servidor: op ${bot.username}`)
  return ok
}

module.exports = { createBot }

// Ejecutado directamente (node bots/rancher.js) arranca solo; desde el panel lo controla panel.js
if (require.main === module) createBot()
