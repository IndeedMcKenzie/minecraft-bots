// ============================================================
//  bots/fisher.js — Bot Pescador
//  1. Saca una caña de pescar de los cofres de casa si no tiene
//  2. Busca agua abierta cerca de casa y se coloca en la orilla
//  3. Pesca sin parar y guarda lo pescado en los cofres de casa
// ============================================================
const mineflayer = require('mineflayer')
const { pathfinder, goals: { GoalBlock } } = require('mineflayer-pathfinder')
const cfg = require('../config')
const stats = require('./stats')
const {
  botOptions,
  setupBot,
  safeGoto,
  travelTo,
  equipBestTool,
  returnHomeAndDeposit,
  runPendingCommand,
  getDepositableItems,
  waitUntil,
  setIssue,
  clearIssue,
  isInventoryFull,
  withdrawToolsFromChest,
  markBad,
  isBad,
  sleep,
  fmtPos,
} = require('./common')

const ROD = 'fishing_rod'
const FISH_TIMEOUT_MS = 45 * 1000   // Sin picada en este tiempo: el anzuelo cayó mal o no hay suerte, recoger y relanzar
const DEPOSIT_EVERY = 16            // Guardar en casa al acumular esta cantidad de capturas
const MIN_OPEN_WATER = 9            // Bloques de agua (de 25 alrededor) para considerarla "agua abierta"
const KEEP_AMOUNTS = { [ROD]: 1 }   // Se queda 1 caña; las de sobra van al cofre

function isAir(block) {
  return !!block && (block.name === 'air' || block.name === 'cave_air')
}

function createBot(ctrl = {}) {
  const bot = mineflayer.createBot(botOptions('fisher'))

  bot.loadPlugin(pathfinder)

  setupBot(bot, 'Pescador', () => createBot(ctrl), 'fisher', ctrl)

  bot.once('spawn', () => {
    console.log(`[${cfg.bots.fisher.username}] 🎣 Conectado. Preparando la caña...`)
    setTimeout(() => workLoop(bot), 3000)
  })

  return bot
}

async function workLoop(bot) {
  let catches = 0
  let lastNoRodMsg = 0
  bot.depositRules = { keep: [], amounts: KEEP_AMOUNTS }

  while (!bot.stopped) {
    try {
      // ── 0. Órdenes del panel (p. ej. volver a casa) ──────────
      if (await runPendingCommand(bot)) continue

      const mcData = require('minecraft-data')(bot.version)

      // ── 1. Caña: sacarla del cofre de casa si no tiene ───────
      await withdrawToolsFromChest(bot, [ROD], { travel: true })

      // ── 2. Guardar capturas en casa ──────────────────────────
      if (countCatch(bot) >= DEPOSIT_EVERY || isInventoryFull(bot)) {
        const res = await returnHomeAndDeposit(bot, [], KEEP_AMOUNTS)
        if (res === 'ok') console.log(`[Pescador] 📦 Capturas guardadas. Total pescado en esta sesión: ${catches}`)
      }

      if (!bot.inventory.items().some(i => i.name === ROD)) {
        setIssue(bot, 'tool', 'err', 'Sin caña: no puede pescar hasta que haya una en su cofre')
        if (Date.now() - lastNoRodMsg > 60000) {
          console.log(bot.home
            ? `[Pescador] ⚠️ Sin caña de pescar. Deja una en el cofre de casa ${fmtPos(bot.home)} (3 palos + 2 cuerdas).`
            : '[Pescador] ⚠️ Sin caña y sin casa. Hazme TP junto a un cofre cerca del agua, usa "!casa pescador" (o "Fijar casa" en el panel) y deja una caña en ese cofre.')
          lastNoRodMsg = Date.now()
        }
        await sleep(15000)
        continue
      }

      clearIssue(bot, 'tool')

      // ── 3. Buscar sitio de pesca (se recalcula si cambia la casa) ─
      const homeKey = bot.home ? bot.home.toString() : 'none'
      if (!bot.fishingSpot || bot.fishingSpot.homeKey !== homeKey) {
        // El agua se busca alrededor de casa: si está lejos, ir primero para tener esos chunks cargados
        if (bot.home && bot.entity.position.distanceTo(bot.home) > 32) {
          console.log(`[Pescador] 🏠 Yendo a casa ${fmtPos(bot.home)} para buscar agua cerca...`)
          await travelTo(bot, bot.home, 4)
        }
        bot.fishingSpot = findFishingSpot(bot, mcData)
        if (!bot.fishingSpot) {
          console.log(`[Pescador] 🌊 No encuentro agua abierta cerca de ${bot.home ? 'casa ' + fmtPos(bot.home) : 'aquí'}. Reintento en 30s.`)
          await sleep(30000)
          continue
        }
        bot.fishingSpot.homeKey = homeKey
        console.log(`[Pescador] 🌊 Sitio de pesca: orilla ${fmtPos(bot.fishingSpot.stand)} → agua ${fmtPos(bot.fishingSpot.target)}`)
      }

      // ── 4. Ir a la orilla ────────────────────────────────────
      const { stand, target } = bot.fishingSpot
      if (bot.entity.position.distanceTo(stand.offset(0.5, 0, 0.5)) > 1.2) {
        const reached = await safeGoto(bot, new GoalBlock(stand.x, stand.y, stand.z), 20)
        if (!reached) {
          console.log('[Pescador] ⚠️ No llego a la orilla, buscando otro sitio...')
          markBad(bot, target)
          bot.fishingSpot = null
          continue
        }
      }

      // ── 5. Lanzar y esperar picada ───────────────────────────
      await equipBestTool(bot, [ROD])
      await bot.lookAt(target.offset(0.5, 0.9, 0.5), true)

      const before = inventoryCounts(bot)
      const bite = await fishOnce(bot)

      if (bite) {
        // La captura vuela hacia el bot: esperar a que llegue (a veces tarda más de 1,5 s)
        await waitUntil(() => diffInventory(before, inventoryCounts(bot)).length > 0, 3000)
        await sleep(200)
        const after = inventoryCounts(bot)
        const caught = diffInventory(before, after)
        catches++
        console.log(`[Pescador] 🐟 Pescado: ${caught.length ? caught.join(', ') : 'algo (no llegó al inventario)'}`)
        stats.add('fisher', 'capturas')
        for (const [name, count] of Object.entries(after)) {
          const gained = count - (before[name] || 0)
          // Lo que llega por /give o del cofre no es pesca: solo contar si llegó tras la picada
          if (gained > 0 && name !== ROD) stats.addDetail('pesca', name, gained)
        }
      }
      // Sin picada: se vuelve a lanzar en el mismo sitio (los peces de un bloque de agua no se agotan)

      await sleep(500)
    } catch (err) {
      console.warn(`[Pescador] ⚠️ ${err.message}`)
      await sleep(3000)
    }
  }
}

// Lanza la caña y espera la picada. Si no pica a tiempo, recoge el anzuelo y devuelve false
async function fishOnce(bot) {
  let timer
  bot.fishing = true // permite que una orden del panel recoja el anzuelo
  try {
    await Promise.race([
      bot.fish(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), FISH_TIMEOUT_MS) }),
    ])
    return true
  } catch (err) {
    if (err.message === 'timeout') {
      try { bot.activateItem() } catch {} // recoger el anzuelo
      await sleep(500)
    }
    return false
  } finally {
    clearTimeout(timer)
    bot.fishing = false
  }
}

/**
 * Busca agua abierta (≥ MIN_OPEN_WATER bloques de agua en 5x5, con aire encima) cerca de casa
 * y una orilla firme a 2-4 bloques desde la que lanzar. Evita los canales de 1 bloque de la granja.
 */
function findFishingSpot(bot, mcData) {
  const waterId = mcData.blocksByName.water?.id
  if (!waterId) return null
  const center = bot.home || bot.entity.position.floored()
  const radius = (cfg.fishing && cfg.fishing.searchRadius) || 32

  const waters = bot.findBlocks({
    matching: waterId,
    point: center,
    maxDistance: radius,
    count: 400,
    useExtraInfo: (b) => !isBad(bot, b.position) && isAir(bot.blockAt(b.position.offset(0, 1, 0))),
  })

  for (const w of waters) {
    if (countOpenWater(bot, waterId, w) < MIN_OPEN_WATER) continue
    const stand = findStandSpot(bot, waterId, w)
    if (stand) return { target: w, stand }
  }
  return null
}

function countOpenWater(bot, waterId, pos) {
  let n = 0
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const b = bot.blockAt(pos.offset(dx, 0, dz))
      if (b && b.type === waterId && isAir(bot.blockAt(pos.offset(dx, 1, dz)))) n++
    }
  }
  return n
}

// Orilla: bloque sólido (no agua) con 2 de aire encima, a 2-4 bloques del agua objetivo
// Distancia (en bloques) entre la orilla y el punto de lanzamiento, en orden de preferencia. Lo pescado sale
// disparado hacia el pescador con una fuerza proporcional a la distancia: lanzando a 2 bloques apenas se mueve,
// vuelve a caer al agua y se queda flotando sin llegar al inventario.
const CAST_DISTANCES = [5, 4, 6, 3]

function findStandSpot(bot, waterId, water) {
  for (const r of CAST_DISTANCES) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        for (const dy of [1, 2]) {
          const feet = water.offset(dx, dy, dz)
          const below = bot.blockAt(feet.offset(0, -1, 0))
          if (!below || below.boundingBox !== 'block' || below.type === waterId) continue
          if (!isAir(bot.blockAt(feet)) || !isAir(bot.blockAt(feet.offset(0, 1, 0)))) continue
          if (clearLine(bot, feet.offset(0.5, 1.6, 0.5), water.offset(0.5, 1, 0.5))) return feet
        }
      }
    }
  }
  return null
}

// Nada sólido entre los ojos del pescador y el agua (si no, el anzuelo choca y cae donde no debe)
function clearLine(bot, from, to) {
  const steps = Math.ceil(from.distanceTo(to) * 4)
  for (let i = 1; i < steps; i++) {
    const p = from.plus(to.minus(from).scaled(i / steps))
    const b = bot.blockAt(p.floored())
    if (b && b.boundingBox === 'block') return false
  }
  return true
}

// Lo que guardaría al volver a casa (sin la caña ni la reserva de comida, que también puede ser pescado)
function countCatch(bot) {
  return getDepositableItems(bot, [], KEEP_AMOUNTS).reduce((acc, i) => acc + i.count, 0)
}

function inventoryCounts(bot) {
  const counts = {}
  for (const i of bot.inventory.items()) counts[i.name] = (counts[i.name] || 0) + i.count
  return counts
}

function diffInventory(before, after) {
  return Object.entries(after)
    .filter(([name, count]) => count > (before[name] || 0))
    .map(([name, count]) => `${name.replace(/_/g, ' ')} ×${count - (before[name] || 0)}`)
}

module.exports = { createBot }

// Ejecutado directamente (node bots/fisher.js) arranca solo; desde el panel lo controla panel.js
if (require.main === module) createBot()
