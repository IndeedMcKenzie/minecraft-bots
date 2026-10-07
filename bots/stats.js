// ============================================================
//  bots/stats.js — Estadísticas de los bots
//  Contadores por bot (desde siempre y en esta sesión), desgloses
//  (minerales por tipo, peces, almacén por categoría) y objetos
//  guardados por hora. Se guardan en data/stats.json cada minuto.
// ============================================================
const fs = require('fs')
const path = require('path')

const FILE = path.join(__dirname, '..', 'data', 'stats.json')
const HOURLY_KEEP_MS = 48 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

function emptyData() {
  return { since: Date.now(), bots: {}, detail: {}, hourly: {} }
}

let data = load()
const session = { since: Date.now(), bots: {}, detail: {} }
let dirty = false

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return { ...emptyData(), ...d }
  } catch {
    return emptyData()
  }
}

function bump(obj, key, n) {
  obj[key] = (obj[key] || 0) + n
}

/** Suma n al contador `metric` del bot (en el total y en la sesión). */
function add(botKey, metric, n = 1) {
  if (!botKey || !n) return
  bump(data.bots[botKey] || (data.bots[botKey] = {}), metric, n)
  bump(session.bots[botKey] || (session.bots[botKey] = {}), metric, n)
  dirty = true
}

/** Desglose global, p. ej. addDetail('minerales', 'diamante', 1). */
function addDetail(group, name, n = 1) {
  if (!group || !name || !n) return
  bump(data.detail[group] || (data.detail[group] = {}), name, n)
  bump(session.detail[group] || (session.detail[group] = {}), name, n)
  dirty = true
}

/** Objetos guardados en casa en la hora actual (para el gráfico por horas). */
function addHourly(botKey, n) {
  if (!botKey || !n) return
  const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS
  bump(data.hourly[hour] || (data.hourly[hour] = {}), botKey, n)
  const cutoff = Date.now() - HOURLY_KEEP_MS
  for (const h of Object.keys(data.hourly)) if (Number(h) < cutoff) delete data.hourly[h]
  dirty = true
}

function snapshot() {
  return { total: data, session }
}

function save() {
  if (!dirty) return
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(data))
    dirty = false
  } catch {}
}

setInterval(save, 60 * 1000).unref()

module.exports = { add, addDetail, addHourly, snapshot, save }
