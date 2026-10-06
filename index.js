// ============================================================
//  index.js — Lanzador principal: inicia todos los bots
// ============================================================
const { spawn } = require('child_process')
const path = require('path')

const bots = [
  { name: 'Bot_Leñador',  file: 'bots/woodcutter.js' },
  { name: 'Bot_Minero',   file: 'bots/miner.js'      },
  { name: 'Bot_Granjero', file: 'bots/farmer.js'     },
]

console.log('🤖 Iniciando sistema de bots de Minecraft...\n')

bots.forEach(({ name, file }) => {
  const botPath = path.join(__dirname, file)
  const proc = spawn('node', [botPath], { stdio: 'inherit' })

  proc.on('close', (code) => {
    console.log(`[${name}] Proceso terminó con código ${code}`)
  })

  proc.on('error', (err) => {
    console.error(`[${name}] Error al iniciar: ${err.message}`)
  })

  console.log(`✅ ${name} iniciado (${file})`)
})
