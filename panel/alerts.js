// ============================================================
//  panel/alerts.js — Alertas de los bots
//  Vigila cada bot y avisa si algo va mal:
//  · Produce poco: sin talar/minar/pescar… durante un rato estando conectado
//  · Desconectado, atascado varias veces o muerto hace poco
//  · Cofres de casa llenos
//  · Lo que el propio bot avisa (setIssue): sin herramienta, sin combustible…
//  Niveles: 'err' (rojo), 'warn' (amarillo), 'info' (gris, no cuenta como alerta)
// ============================================================
const cfg = require('../config')
const stats = require('../bots/stats')

const SAMPLE_MS = 60 * 1000
const KEEP_SAMPLES = 61           // una hora de muestras por minuto
const OFFLINE_ALERT_MS = 2 * 60 * 1000
const STUCK_WINDOW_MIN = 30
const STUCK_ALERT_COUNT = 3
const DEATH_WINDOW_MIN = 15

// Qué debe subir en cada bot y en cuántos minutos, para considerar que trabaja con normalidad
const orgMinutes = ((cfg.organizer && cfg.organizer.intervalMinutes) || 20) * 2 + 10
const PRODUCTIVITY = {
  woodcutter: { metric: 'arboles', minutes: 20, what: 'árboles talados' },
  miner: { metric: 'minerales', minutes: 20, what: 'minerales' },
  farmer: { metric: 'cosechas', minutes: 30, what: 'cosechas' },
  fisher: { metric: 'capturas', minutes: 10, what: 'capturas' },
  artisan: { metric: 'producidos', minutes: 45, what: 'objetos fundidos o cocinados' },
  organizer: { metric: 'rondas', minutes: orgMinutes, what: 'rondas terminadas' },
}
const TRACKED = ['atascos', 'muertes', ...new Set(Object.values(PRODUCTIVITY).map(p => p.metric))]
const LEVEL_ORDER = { err: 0, warn: 1, info: 2 }

function createAlerts({ keys, getInfo, onChange }) {
  const samples = Object.fromEntries(keys.map(k => [k, []]))
  const onlineSince = {}
  const offlineSince = {}
  const active = Object.fromEntries(keys.map(k => [k, new Map()]))

  const counters = key => (stats.snapshot().session.bots[key]) || {}

  function sample() {
    const now = Date.now()
    for (const key of keys) {
      const c = counters(key)
      const list = samples[key]
      list.push({ t: now, ...Object.fromEntries(TRACKED.map(m => [m, c[m] || 0])) })
      if (list.length > KEEP_SAMPLES) list.shift()
    }
  }

  // Valor de una métrica hace `minutes` minutos (la muestra más cercana sin pasarse), o null si no hay historial
  function valueAgo(key, metric, minutes) {
    const target = Date.now() - minutes * 60 * 1000
    let found = null
    for (const s of samples[key]) {
      if (s.t <= target) found = s
      else break
    }
    return found ? found[metric] : null
  }

  function compute(key) {
    const { status, enabled, bot, issue, homeFull } = getInfo(key)
    const now = Date.now()
    const out = []

    // Seguimiento de conexión
    if (status === 'online') { onlineSince[key] = onlineSince[key] || now; delete offlineSince[key] }
    else { delete onlineSince[key]; if (enabled) offlineSince[key] = offlineSince[key] || now; else delete offlineSince[key] }

    if (!enabled) return out
    if (status !== 'online') {
      const since = offlineSince[key]
      if (now - since >= OFFLINE_ALERT_MS) {
        out.push({ id: 'offline', level: 'err', since, text: `Sin conexión desde hace ${Math.round((now - since) / 60000)} min${issue ? ` (${issue})` : ''}` })
      }
      return out
    }

    // Avisos del propio bot
    for (const [id, i] of (bot.issues || new Map())) out.push({ id: `bot:${id}`, level: i.level, since: i.since, text: i.text })
    if (homeFull) out.push({ id: 'homeFull', level: 'warn', since: now, text: 'Cofres de casa llenos: no puede guardar más' })

    const c = counters(key)

    // Atascos repetidos
    const stuckBefore = valueAgo(key, 'atascos', STUCK_WINDOW_MIN)
    if (stuckBefore !== null && (c.atascos || 0) - stuckBefore >= STUCK_ALERT_COUNT) {
      out.push({ id: 'stuck', level: 'warn', since: now, text: `Se ha atascado ${(c.atascos || 0) - stuckBefore} veces en ${STUCK_WINDOW_MIN} min` })
    }

    // Muerte reciente
    const deathsBefore = valueAgo(key, 'muertes', DEATH_WINDOW_MIN)
    if (deathsBefore !== null && (c.muertes || 0) > deathsBefore) {
      out.push({ id: 'death', level: 'warn', since: now, text: `Ha muerto en los últimos ${DEATH_WINDOW_MIN} min` })
    }

    // Productividad: solo si lleva conectado todo el periodo y el bot no ha explicado ya por qué no trabaja
    const rule = PRODUCTIVITY[key]
    const explained = out.some(a => a.id.startsWith('bot:'))
    if (rule && !explained && now - onlineSince[key] >= rule.minutes * 60 * 1000) {
      const before = valueAgo(key, rule.metric, rule.minutes)
      if (before !== null && (c[rule.metric] || 0) - before <= 0) {
        out.push({ id: 'idle', level: 'warn', since: now, text: `0 ${rule.what} en ${rule.minutes} min` })
      }
    }
    return out
  }

  /** Alertas actuales de un bot, ordenadas por gravedad. Avisa con onChange de las que aparecen o se resuelven. */
  function evaluate(key) {
    const list = compute(key).sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
    const prev = active[key]
    const next = new Map()
    for (const a of list) {
      const old = prev.get(a.id)
      if (old && old.text === a.text) a.since = old.since // conservar desde cuándo existe
      next.set(a.id, a)
      if (!old && a.level !== 'info') onChange(key, a, true)
    }
    for (const [id, a] of prev) if (!next.has(id) && a.level !== 'info') onChange(key, a, false)
    active[key] = next
    return list
  }

  sample()
  setInterval(sample, SAMPLE_MS).unref()
  return { evaluate, current: key => [...active[key].values()] }
}

module.exports = { createAlerts }
