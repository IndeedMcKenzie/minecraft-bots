// ============================================================
//  bots/enchanter.js — Encantar herramientas (un trabajo más del Artesano)
//  Junto al taller monta una estación: mesa de encantamientos con 15 librerías alrededor (lo justo para la opción de
//  nivel 30). Cada herramienta de repuesto que fabrica el Artesano la encanta ahí antes de llevársela a su bot: el
//  Minero recibe picos con Fortuna/Eficiencia, todos duran más con Irrompibilidad, etc. (el juego elige los encantamientos
//  al azar entre los de esa herramienta). Lapislázuli del almacén; la experiencia, con /xp (config.js → enchanting).
// ============================================================
const fs = require('fs')
const path = require('path')
const Vec3 = require('vec3')
const cfg = require('../config')
const stats = require('./stats')
const { requestTeleport, teleportTo, waitUntil, giveItem, sleep, fmtPos } = require('./common')
const { fetchFromWarehouse } = require('./warehouse')

const link = () => require('../panel/serverlink')
const TAG = '[Artesano]'
const STATION_FILE = path.join(__dirname, '..', 'data', 'enchant_station.json')
const enchCfg = () => Object.assign({ enabled: true }, cfg.enchanting)

// Lo que se puede encantar en la mesa (los libros, no: harían falta yunques)
const ENCHANTABLE = /_(pickaxe|axe|shovel|hoe|sword)$|^(bow|fishing_rod)$/
const LAPIS_PER_ENCHANT = 3
const LEVELS_NEEDED = 30 // la opción de abajo pide tener 30 niveles (gasta 3)
const STEP_MS = 5000     // plazo de cada paso en la mesa (las esperas de mineflayer no tienen plazo)

// Librerías: a 2 bloques de la mesa, sin las esquinas; 11 a su altura (con un hueco para llegar) y 4 encima = 15
const RING = [[-2, -1], [-2, 0], [-2, 1], [2, -1], [2, 0], [2, 1], [-1, -2], [0, -2], [1, -2], [-1, 2], [1, 2]]
const RING_UP = [[-2, 0], [2, 0], [0, -2], [-2, -1]]
const GAP = [0, 2] // por aquí entra el Artesano

const ES = {
  efficiency: 'Eficiencia', unbreaking: 'Irrompibilidad', fortune: 'Fortuna', silk_touch: 'Toque de seda',
  sharpness: 'Filo', smite: 'Castigo', bane_of_arthropods: 'Perdición de los artrópodos', looting: 'Botín',
  knockback: 'Empuje', fire_aspect: 'Aspecto ígneo', sweeping_edge: 'Barrido', power: 'Poder', punch: 'Retroceso',
  flame: 'Fuego', infinity: 'Infinidad', lure: 'Atracción', luck_of_the_sea: 'Suerte marina', mending: 'Reparación',
}
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V']

const withTimeout = (promise, ms, what) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`${what}: el servidor no respondió en ${ms / 1000} s`)), ms)
  promise.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
})
// Encantamientos de un objeto como [{ name, lvl }] (common.js ya los da así; esto es por si llegan sin convertir)
function enchantsOf(bot, item) {
  const e = item && item.enchants
  if (Array.isArray(e)) return e
  if (e && Array.isArray(e.enchantments)) {
    const server = bot.registry.serverEnchantments || []
    return e.enchantments.map(x => ({ name: server[x.id] || (bot.registry.enchantments[x.id] || {}).name || String(x.id), lvl: x.level }))
  }
  return []
}
const countOf = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((a, i) => a + i.count, 0)

// Encantamientos que estropean una herramienta para su bot: con Toque de seda el pico del Minero (y su veta entera, con
// Veinminer) suelta bloques de mineral en vez de diamantes, carbón o mineral en bruto (ni Fortuna ni nada que fundir)
const UNWANTED = { pickaxe: ['silk_touch'], shovel: ['silk_touch'] }
function unwantedOf(bot, item) {
  const family = (item.name.match(/_(pickaxe|shovel)$/) || [])[1]
  const bad = UNWANTED[family] || []
  return enchantsOf(bot, item).filter(e => bad.includes(e.name))
}
const hasUnwanted = (bot, item) => unwantedOf(bot, item).length > 0
const describe = list => list.map(e => `${ES[e.name] || e.name.replace(/_/g, ' ')} ${ROMAN[e.lvl] || e.lvl}`).join(', ')

/**
 * Encanta `itemName` (uno sin encantar del inventario) en la estación. Devuelve true si quedó encantado, false si no
 * (se entrega tal cual) y 'unwanted' si salió con un encantamiento que no le sirve a su bot (ver UNWANTED): esa se aparta.
 */
async function enchantTool(bot, itemName) {
  if (!enchCfg().enabled || !ENCHANTABLE.test(itemName) || !bot.home) return false
  try {
    const station = await ensureStation(bot)
    if (!station) return false
    if (!await ensureLapis(bot) || !await ensureLevels(bot)) return false

    // Al hueco del anillo de librerías, a 2 bloques de la mesa
    const spot = station.offset(GAP[0], 0, GAP[1])
    if (bot.entity.position.distanceTo(spot.offset(0.5, 0, 0.5)) > 2) {
      await requestTeleport(bot, { x: spot.x + 0.5, y: spot.y, z: spot.z + 0.5 })
      await waitUntil(() => bot.entity.position.distanceTo(spot.offset(0.5, 0, 0.5)) < 2, 4000)
      await sleep(800)
    }
    const block = bot.blockAt(station)
    if (!block || block.name !== 'enchanting_table') { forgetStation(); return false }

    // Las encantadas que ya llevaba (por si la mesa no devuelve el resultado: entonces se busca la nueva en el inventario)
    const sig = i => `${i.slot}:${enchantsOf(bot, i).map(e => e.name + e.lvl).join(',')}`
    const enchantedNow = () => bot.inventory.items().filter(i => i.name === itemName && enchantsOf(bot, i).length > 0)
    const before = new Set(enchantedNow().map(sig))

    const table = await withTimeout(bot.openEnchantmentTable(block), STEP_MS, 'Abrir la mesa')
    let done = null
    try {
      // Con la mesa abierta los huecos del inventario van numerados según la ventana: buscar en table.items()
      const item = table.items().find(i => i.name === itemName && !enchantsOf(bot, i).length)
      const lapis = table.items().find(i => i.name === 'lapis_lazuli')
      if (!item || !lapis) return false
      await withTimeout(table.putTargetItem(item), STEP_MS, 'Poner la herramienta')
      await withTimeout(table.putLapis(lapis), STEP_MS, 'Poner el lapislázuli')
      await waitUntil(() => table.enchantments[2].level >= 0, STEP_MS)
      const option = table.enchantments[2]
      if (option.level < 0) throw new Error('la mesa no ofrece encantamientos (¿faltan librerías?)')
      if (option.level < LEVELS_NEEDED) console.warn(`${TAG} ✨ La mesa solo ofrece nivel ${option.level} (¿alguna librería tapada?).`)
      // El resultado es la herramienta tal como queda en la mesa (mirarla en el inventario podía dar otra igual)
      done = await withTimeout(table.enchant(2), STEP_MS, 'Encantar')
      await withTimeout(table.takeTargetItem(), STEP_MS, 'Recoger la herramienta')
    } finally {
      try { table.close() } catch {}
    }
    await sleep(500)
    if (!done || enchantsOf(bot, done).length === 0) done = enchantedNow().find(i => !before.has(sig(i))) || done
    const got = done ? enchantsOf(bot, done) : []
    if (got.length === 0) {
      console.warn(`${TAG} ✨ No quedó encantado ${itemName.replace(/_/g, ' ')}: lo entrego tal cual.`)
      return false
    }
    stats.add('artisan', 'encantados')
    for (const e of got) stats.addDetail('encantamientos', e.name)
    const bad = unwantedOf(bot, done)
    if (bad.length > 0) {
      console.warn(`${TAG} ✨ ${itemName.replace(/_/g, ' ')} ha salido con ${describe(got)}: ${describe(bad)} no le sirve a su bot ` +
        '(soltaría bloques de mineral en vez de minerales). Lo aparto en el taller.')
      return 'unwanted'
    }
    console.log(`${TAG} ✨ Encantado: ${itemName.replace(/_/g, ' ')} → ${describe(got)}.`)
    return true
  } catch (err) {
    console.warn(`${TAG} ✨ No pude encantar ${itemName.replace(/_/g, ' ')}: ${err.message}. Lo entrego sin encantar.`)
    try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
    return false
  }
}

async function ensureLapis(bot) {
  if (countOf(bot, 'lapis_lazuli') >= LAPIS_PER_ENCHANT) return true
  await fetchFromWarehouse(bot, [{ test: n => n === 'lapis_lazuli', max: 64, cats: ['Minerales', 'Varios'] }], 'Artesano')
  if (countOf(bot, 'lapis_lazuli') >= LAPIS_PER_ENCHANT) return true
  console.log(`${TAG} ✨ No hay lapislázuli en el almacén: me doy 64 con /give.`)
  await giveItem(bot, 'lapis_lazuli', 64)
  return waitUntil(() => countOf(bot, 'lapis_lazuli') >= LAPIS_PER_ENCHANT, 3000)
}

// Experiencia para la opción de nivel 30, con /xp (por la consola del plugin; si no, por el chat: el bot es OP)
async function ensureLevels(bot) {
  const missing = LEVELS_NEEDED - bot.experience.level
  if (missing <= 0) return true
  const cmd = `xp add ${bot.username} ${missing} levels`
  try {
    if (link().isOnline()) await link().runCommand(cmd)
    else bot.chat('/' + cmd)
  } catch { bot.chat('/' + cmd) }
  return waitUntil(() => bot.experience.level >= LEVELS_NEEDED, 4000)
}

// ── La estación (mesa + 15 librerías) ───────────────────────
function loadStation() {
  try { const p = JSON.parse(fs.readFileSync(STATION_FILE, 'utf8')); return new Vec3(p.x, p.y, p.z) } catch { return null }
}
function forgetStation() { try { fs.unlinkSync(STATION_FILE) } catch {} }

/** Posición de la mesa; si no existe, la monta en un hueco llano junto al taller. */
async function ensureStation(bot) {
  const saved = loadStation()
  if (saved) {
    const b = bot.blockAt(saved)
    if (!b && bot.entity.position.distanceTo(saved) > 48) return saved // lejos (sin cargar): se comprueba al llegar
    if (b && b.name === 'enchanting_table') return saved
    forgetStation() // la quitaron: buscar sitio otra vez
  }
  if (bot.entity.position.distanceTo(bot.home) > 12) await teleportTo(bot, bot.home)
  const spot = findStationSpot(bot)
  if (!spot) {
    console.warn(`${TAG} ✨ No encuentro sitio junto al taller para la mesa de encantamientos (5×5 de terreno natural a menos de 24 bloques).`)
    return null
  }
  // Allanar: suelo de tablones de 5×5 y aire encima (solo había terreno natural: ver levelingCost)
  const cmds = [
    `fill ${spot.x - 2} ${spot.y - 1} ${spot.z - 2} ${spot.x + 2} ${spot.y - 1} ${spot.z + 2} minecraft:spruce_planks`,
    `fill ${spot.x - 2} ${spot.y} ${spot.z - 2} ${spot.x + 2} ${spot.y + 2} ${spot.z + 2} minecraft:air`,
    `setblock ${spot.x} ${spot.y} ${spot.z} minecraft:enchanting_table`,
  ]
  for (const [dx, dz] of RING) cmds.push(`setblock ${spot.x + dx} ${spot.y} ${spot.z + dz} minecraft:bookshelf`)
  for (const [dx, dz] of RING_UP) cmds.push(`setblock ${spot.x + dx} ${spot.y + 1} ${spot.z + dz} minecraft:bookshelf`)
  for (const c of cmds) {
    if (link().isOnline()) await link().runCommand(c)
    else bot.chat('/' + c)
    await sleep(50)
  }
  await waitUntil(() => bot.blockAt(spot)?.name === 'enchanting_table', 4000)
  fs.mkdirSync(path.dirname(STATION_FILE), { recursive: true })
  fs.writeFileSync(STATION_FILE, JSON.stringify({ x: spot.x, y: spot.y, z: spot.z }))
  console.log(`${TAG} ✨ Estación de encantamientos montada en ${fmtPos(spot)} (mesa + 15 librerías).`)
  return spot
}

// Terreno natural que se puede allanar para la estación (nunca algo construido)
const NATURAL = /^(air|cave_air|short_grass|tall_grass|grass|fern|large_fern|dead_bush|.*_flower|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|.*_leaves|snow|vine|sweet_berry_bush|pink_petals|leaf_litter|wildflowers|bush|firefly_bush|short_dry_grass|tall_dry_grass|.*_sapling|.*_mushroom|moss_carpet)$/
const NATURAL_FLOOR = /^(grass_block|dirt|coarse_dirt|podzol|rooted_dirt|mycelium|stone|andesite|diorite|granite|tuff|deepslate|gravel|sand|red_sand|clay|moss_block|snow_block|air|cave_air|short_grass|tall_grass|.*_leaves)$/
const KEEP = /chest|barrel|furnace|crafting_table|smoker|sign|composter|hopper|enchanting_table|bookshelf|door|fence|wall|stairs|slab|planks|bricks|glass|torch|lantern|bed|farmland/

/**
 * Centro de un cuadrado de 5×5 junto al taller (a 6–24 bloques del cofre) donde solo hay terreno natural (hierba,
 * flores, hojas, tierra, piedra): se allana (suelo de tablones y aire encima) sin tocar nada construido. Se elige el
 * que menos bloques haya que cambiar, y nada del taller ni del almacén a 3 bloques.
 */
function findStationSpot(bot) {
  const home = bot.home
  let best = null
  for (let dx = -24; dx <= 24; dx++) {
    for (let dz = -24; dz <= 24; dz++) {
      const d = Math.hypot(dx, dz)
      if (d < 6 || d > 24) continue
      for (let dy = -4; dy <= 4; dy++) {
        const c = home.offset(dx, dy, dz)
        const cost = levelingCost(bot, c)
        if (cost === null) continue
        const score = cost * 4 + d
        if (!best || score < best.score) best = { c, score }
      }
    }
  }
  return best ? best.c : null
}

// Bloques que hay que cambiar para montar la estación en c, o null si no se puede (algo construido, sin cargar…)
function levelingCost(bot, c) {
  let cost = 0
  for (let x = -2; x <= 2; x++) {
    for (let z = -2; z <= 2; z++) {
      const floor = bot.blockAt(c.offset(x, -1, z))
      if (!floor || !NATURAL_FLOOR.test(floor.name)) return null
      if (floor.boundingBox !== 'block' || /leaves/.test(floor.name)) cost++
      for (let y = 0; y <= 2; y++) {
        const b = bot.blockAt(c.offset(x, y, z))
        if (!b || !NATURAL.test(b.name)) return null
        if (b.name !== 'air' && b.name !== 'cave_air') cost++
      }
    }
  }
  if (cost > 40) return null
  for (let x = -5; x <= 5; x++) {
    for (let z = -5; z <= 5; z++) {
      for (let y = -2; y <= 3; y++) {
        const n = bot.blockAt(c.offset(x, y, z))
        if (n && KEEP.test(n.name)) return null
      }
    }
  }
  return cost
}

module.exports = { enchantTool, enchantsOf, hasUnwanted }
