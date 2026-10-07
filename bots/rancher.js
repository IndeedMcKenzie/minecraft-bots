// ============================================================
//  bots/rancher.js — Bot Ganadero (vacas)
//  1. Construye un corral de vallas (con puerta) alrededor de su casa
//  2. Si hay menos de 2 vacas, las invoca con /summon (requiere OP)
//  3. Las alimenta con trigo por parejas para que críen
//  4. Si se supera el máximo, sacrifica adultas sobrantes (carne y cuero)
//  5. Guarda lo obtenido en el cofre de casa (dentro del corral)
//  El material (vallas, trigo, espada) lo consigue con /give si le falta.
// ============================================================
const fs = require('fs')
const path = require('path')
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
const KEEP_AMOUNTS = { wheat: 64, ...Object.fromEntries(SWORDS.map(s => [s, 1])), [FENCE]: 16, [GATE]: 1, dirt: 16 }

function createBot(ctrl = {}) {
  const bot = mineflayer.createBot(botOptions('rancher'))

  bot.loadPlugin(pathfinder)
  bot.loadPlugin(autoEat)

  setupBot(bot, 'Ganadero', () => createBot(ctrl), 'rancher', ctrl)

  bot.once('spawn', () => {
    // Dentro del corral no necesita picar ni poner bloques para moverse. Si se le deja, el pathfinder
    // rompe vallas para "atajar" y usa la tierra de nivelar como andamio, creando escalones junto a
    // las vallas por los que las vacas escapan. Las vallas y la tierra se colocan a propósito en buildPen.
    const movements = bot.pathfinder.movements
    if (movements) {
      movements.canDig = false
      movements.scafoldingBlocks = []
      movements.allow1by1towers = false
    }
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
function ringPositions(bot, center = bot.home) {
  const R = rCfg.penRadius
  const c = center
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
function groundAt(bot, x, z, refY = bot.home.y) {
  const base = refY
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

const FILL_BLOCK = 'dirt'  // para nivelar la base de las vallas en terreno irregular
const MAX_FILL = 3         // como mucho rellena 3 bloques bajo una valla
const PEN_FILE = path.join(__dirname, '..', 'data', 'corral.json')

function isAirLike(block) {
  return !!block && block.boundingBox === 'empty' && !block.name.includes('water') && !block.name.includes('lava')
}

// Suelo interior más alto pegado a una posición del anillo (en esquinas mira los 3 vecinos interiores)
function innerGroundY(bot, spot, center) {
  const R = rCfg.penRadius
  const dx = spot.x - center.x
  const dz = spot.z - center.z
  const sx = Math.abs(dx) === R ? Math.sign(dx) : 0
  const sz = Math.abs(dz) === R ? Math.sign(dz) : 0
  const cands = []
  if (sx) cands.push([spot.x - sx, spot.z])
  if (sz) cands.push([spot.x, spot.z - sz])
  if (sx && sz) cands.push([spot.x - sx, spot.z - sz])
  let max = null
  for (const [x, z] of cands) {
    const g = groundAt(bot, x, z, center.y)
    if (g && (max === null || g.position.y > max)) max = g.position.y
  }
  return max
}

/**
 * Plan de una posición del anillo. La valla debe apoyarse a la altura del suelo interior más alto
 * de al lado: si su columna es más baja, desde dentro solo sobresaldría medio bloque y las vacas
 * la saltarían. En ese caso se rellena con tierra hasta esa altura (como mucho MAX_FILL bloques).
 */
function planSpot(bot, spot) {
  const g = groundAt(bot, spot.x, spot.z)
  if (!g) return null
  const groundY = g.position.y
  const inner = innerGroundY(bot, spot, bot.home)
  const base = Math.min(Math.max(groundY, inner ?? groundY), groundY + MAX_FILL)
  const fenceY = base + 1
  const at = y => bot.blockAt(new Vec3(spot.x, y, spot.z))

  const misplaced = [] // vallas mal puestas por debajo de la altura correcta
  for (let y = groundY + 1; y <= base; y++) if (isFenceLike(at(y))) misplaced.push(y)
  const stacked = isFenceLike(at(fenceY)) && at(fenceY + 1) && at(fenceY + 1).name.endsWith('_fence')
  const fill = base - groundY
  const ok = isFenceLike(at(fenceY)) && misplaced.length === 0 && !stacked
  return { ...spot, groundY, base, fenceY, fill, misplaced, stacked, ok }
}

/** Construye y repara el corral (nivelando desniveles). Devuelve true si queda completo. */
async function buildPen(bot) {
  await removeOldPens(bot)

  const todo = ringPositions(bot).map(s => planSpot(bot, s)).filter(p => p && !p.ok)
  if (todo.length === 0) {
    rememberPen(bot.home)
    return true
  }

  const fills = todo.reduce((a, t) => a + t.fill, 0)
  console.log(`[Ganadero] 🚧 Corral: ${todo.length} postes por hacer o corregir${fills ? ` (nivelando ${fills} bloques de desnivel)` : ''}.`)
  if (!await ensureItem(bot, FENCE, todo.filter(t => !t.gate).length)) return false
  if (todo.some(t => t.gate) && !await ensureItem(bot, GATE, 1)) return false
  if (fills > 0 && !await ensureItem(bot, FILL_BLOCK, fills)) return false

  let done = 0
  for (const t of todo) {
    if (bot.stopped || bot.pendingCommand) break
    if (await fixSpot(bot, t)) done++
    await sleep(100)
  }

  const missing = ringPositions(bot).map(s => planSpot(bot, s)).filter(p => p && !p.ok).length
  if (done > 0) console.log(`[Ganadero] 🚧 Corregidos ${done} postes.${missing ? ` Faltan ${missing} (reintentaré).` : ' ¡Corral terminado y nivelado!'}`)
  if (missing === 0) rememberPen(bot.home)
  return missing === 0
}

async function fixSpot(bot, t) {
  const top = new Vec3(t.x, t.fenceY, t.z)
  // Acercarse desde dentro del corral (2 bloques hacia el centro)
  const inward = new Vec3(t.x + Math.sign(bot.home.x - t.x) * 2, t.base + 1, t.z + Math.sign(bot.home.z - t.z) * 2)
  if (!inReach(bot, bot.blockAt(top))) {
    await safeGoto(bot, new GoalNear(inward.x, inward.y, inward.z, 1), 10)
    if (!inReach(bot, bot.blockAt(top))) return false
  }
  const at = y => bot.blockAt(new Vec3(t.x, y, t.z))
  const feet = bot.entity.position.floored()
  const isBotSpot = y => (feet.x === t.x && feet.z === t.z && (feet.y === y || feet.y + 1 === y))

  try {
    // 1. Quitar vallas apiladas o mal colocadas (más bajas de lo debido)
    if (t.stacked) await bot.dig(at(t.fenceY + 1))
    for (const y of t.misplaced) await bot.dig(at(y))

    // 2. Rellenar con tierra hasta la altura de la base
    for (let y = t.groundY + 1; y <= t.base; y++) {
      const b = at(y)
      if (b.boundingBox === 'block' && !isFenceLike(b)) continue
      if (isBotSpot(y)) return false
      if (!isAirLike(b) && b.diggable) await bot.dig(b)
      await bot.equip(bot.inventory.items().find(i => i.name === FILL_BLOCK), 'hand')
      await bot.placeBlock(at(y - 1), new Vec3(0, 1, 0))
    }

    // 3. Poner la valla (o la puerta) encima
    if (!isFenceLike(at(t.fenceY))) {
      const occupant = at(t.fenceY)
      if (occupant && occupant.name !== 'air' && occupant.name !== 'cave_air') {
        if (!occupant.diggable || occupant.name.includes('chest')) return false
        await bot.dig(occupant)
      }
      if (isBotSpot(t.fenceY)) return false
      await bot.equip(bot.inventory.items().find(i => i.name === (t.gate ? GATE : FENCE)), 'hand')
      await bot.placeBlock(at(t.fenceY - 1), new Vec3(0, 1, 0))
    }
    return true
  } catch {
    return false
  }
}

// ── Corrales construidos (para retirar los viejos si cambia la casa) ──
function loadPens() {
  try { return JSON.parse(fs.readFileSync(PEN_FILE, 'utf8')).centers || [] } catch { return [] }
}

function savePens(centers) {
  try {
    fs.mkdirSync(path.dirname(PEN_FILE), { recursive: true })
    fs.writeFileSync(PEN_FILE, JSON.stringify({ centers }, null, 2))
  } catch {}
}

function rememberPen(center) {
  const pens = loadPens()
  if (!pens.some(p => p.x === center.x && p.y === center.y && p.z === center.z)) {
    pens.push({ x: center.x, y: center.y, z: center.z })
    savePens(pens)
  }
}

/**
 * Si la casa cambió, retira las vallas de los corrales que construyó antes: solo las que están
 * exactamente en el anillo de un corral viejo y no forman parte del actual (nunca vallas tuyas sueltas).
 */
async function removeOldPens(bot) {
  const pens = loadPens()
  const cur = bot.home
  const old = pens.filter(p => !(p.x === cur.x && p.y === cur.y && p.z === cur.z))
  if (old.length === 0) return

  const currentRing = new Set(ringPositions(bot).map(s => `${s.x},${s.z}`))
  const remaining = pens.filter(p => !old.includes(p))
  let removed = 0
  for (const p of old) {
    const center = new Vec3(p.x, p.y, p.z)
    if (center.distanceTo(bot.entity.position) > 64) { remaining.push(p); continue } // lejos: más tarde
    console.log(`[Ganadero] 🧹 Retirando el corral viejo centrado en ${fmtPos(center)}...`)
    for (const s of ringPositions(bot, center)) {
      if (bot.stopped) return
      if (currentRing.has(`${s.x},${s.z}`)) continue
      for (let y = center.y + 5; y >= center.y - 6; y--) {
        const b = bot.blockAt(new Vec3(s.x, y, s.z))
        if (!b || !(b.name.endsWith('_fence') || b.name.endsWith('_fence_gate'))) continue
        if (!inReach(bot, b)) {
          await safeGoto(bot, new GoalNear(s.x, y, s.z, 2), 10)
          if (!inReach(bot, b)) continue
        }
        try { await bot.dig(b); removed++ } catch {}
      }
    }
  }
  savePens(remaining)
  if (removed > 0) {
    console.log(`[Ganadero] 🧹 Quité ${removed} vallas de corrales anteriores.`)
    await sleep(500)
    await collectNearbyItems(bot, rCfg.penRadius + 8)
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
