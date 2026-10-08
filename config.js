// ============================================================
//  config.js — Configuración central de todos los bots
// ============================================================

module.exports = {
  server: {
    host: 'localhost',   // IP del servidor
    port: 25565,         // Puerto del servidor Paper
    version: '1.21.4',  // Versión que usa Mineflayer (ViaBackwards traduce a 26.2)
    auth: 'offline',     // 'offline' = cuentas locales / sin autenticación Microsoft
    viewDistance: 'short', // Chunks que carga cada bot: 'tiny'(6) 'short'(8) 'normal'(10) 'far'(12). Menos = menos RAM/CPU en bots y servidor
  },

  // Rendimiento
  performance: {
    // Milisegundos de cada tick (50 ms) que el pathfinder puede usar calculando rutas. El valor de
    // fábrica es 40 (hasta 80% de un núcleo por bot mientras calcula). Menos = menos CPU, pero rutas
    // a trozos: con 20 el bot se queda "dudando" ante desniveles. Se puede fijar por bot con
    // bots.<bot>.pathfinderTickMs (minero y leñador usan 40 porque recorren terreno difícil).
    pathfinderTickMs: 20,
  },

  // Panel de control (node panel.js / abrir_panel.bat)
  panel: {
    port: 3000,          // http://127.0.0.1:3000 en este PC
    // Acceso desde la red local: '0.0.0.0' escucha en la red; '127.0.0.1' = solo este PC.
    // El panel no tiene contraseña: solo se aceptan este PC y las IPs de allowedIps.
    host: '0.0.0.0',
    allowedIps: ['192.168.1.9'], // tu otra PC (http://192.168.1.10:3000)
    autoStart: true,     // Iniciar los bots al abrir el panel
    bluemapUrl: 'http://127.0.0.1:8100', // Pestaña 🗺️ Mapa (web de BlueMap). null = sin pestaña
  },

  // Plugin BotHelper del servidor (server-plugin/): estado del servidor, almacén en vivo y consola en el panel.
  // Si el plugin no está instalado, el panel funciona igual que sin él.
  serverPlugin: {
    url: 'http://127.0.0.1:8200',
    tokenFile: 'C:/Server/plugins/BotHelper/token.txt', // la clave la crea el plugin al arrancar
  },

  // Comportamientos globales
  reconnect: {
    enabled: true,
    delayMs: 5000,       // Esperar 5 segundos antes de reconectar
  },

  // Distancias de búsqueda en bloques (ampliadas para detectar recursos alejados del spawn)
  search: {
    woodRadius: 96,      // Radio para buscar árboles (los árboles están a unos 35+ bloques del spawn)
    mineRadius: 64,      // Radio para buscar minerales
    farmRadius: 48,      // Radio para buscar hierba y cultivos
    chestRadius: 48,     // Radio para buscar cofres de depósito
  },

  // Almacenamiento en cofres (automático)
  chest: {
    enabled: true,       // Si es true, depositan items en cofres
    position: null,      // Opcional: casa común para todos los bots { x: 0, y: 64, z: 0 }
  },

  // Casa de cada bot: los bots exploran libremente y vuelven a casa a guardar.
  // La casa se toma de bots.<bot>.home, si no de chest.position, si no del cofre más
  // cercano al aparecer (se recuerda en data/home_<bot>.json; borra ese archivo para cambiarla).
  home: {
    returnWhenFreeSlots: 2,  // Vuelve a casa cuando le quedan ≤ N huecos libres en el inventario
    returnToWorkSpot: true,  // Tras guardar, regresa al sitio donde estaba trabajando
    maxTravelMinutes: 3,     // Si caminando no llega a casa en este tiempo, usa /tp (requiere OP y stuck.allowTeleport)
    chestRadius: 6,          // Cofres a esta distancia del cofre de casa también se usan
    autoChests: true,        // Si todos los cofres de casa están llenos, se da uno nuevo con /give y lo coloca (requiere OP)
    maxChests: 15,           // Máximo de cofres por casa (cuenta cada mitad de un cofre doble)
  },

  // Granja autónoma
  farm: {
    autoCreate: true,    // Si no hay cultivos, busca agua y prepara la tierra
    searchWaterRadius: 48,
  },

  // Fix de física de salto en Minecraft 1.21+ (bug conocido de mineflayer)
  // Requiere que los bots tengan OP: ejecuta en consola del servidor:
  //   op Bot_Lenador | op Bot_Minero | op Bot_Granjero | op Bot_Pescador | op Bot_Organizador | op Bot_Ganadero
  //   op Bot_Artesano
  // Se ejecutan cada vez que un bot aparece (también al reaparecer tras morir)
  starterCommands: [
    '/attribute {username} minecraft:scale base set 0.9999',
    // Sin hambre: los bots no necesitan comer (saturación infinita, sin partículas)
    '/effect give {username} minecraft:saturation infinite 0 true',
  ],

  // Rescate de bots atascados (los que tienen stuckWatch: true)
  // 1º sube a la superficie (escaleras/torre y, si no, pilar manual) y vuelve a casa; 2º /tp a casa
  stuck: {
    detectSeconds: 90,   // Sin alejarse más de 3 bloques en este tiempo (fuera de casa) = atascado
    allowTeleport: true, // Último recurso: /tp a casa (el bot debe ser OP)
    repeatMinutes: 10,   // Si vuelve a atascarse antes de este tiempo, va directo al /tp
  },

  // Organizador: recoge lo guardado en las casas de los demás bots (con /tp) y lo ordena
  // en un almacén central (su casa), con un cofre con cartel por categoría.
  organizer: {
    intervalMinutes: 20,   // Cada cuánto hace una ronda (también hay un botón en el panel)
    warehouseRadius: 12,   // Radio inicial del almacén alrededor de su casa (crece solo si se llena)
    // Hasta dónde puede crecer. El organizador carga 8 chunks (128 bloques) a su alrededor,
    // así que no conviene pasar de ~112 (más allá no "vería" los cofres desde su casa)
    maxWarehouseRadius: 112,
    maxChests: 0,          // Máximo de cofres del almacén. 0 = ilimitado
    // Buzón: el cofre de su casa (si no tiene cartel) se vacía y se ordena en cada ronda, y lo usa de
    // colchón si se queda sin sitio. ¡Si ese cofre tiene cosas tuyas, las moverá! Por eso viene apagado.
    inbox: false,
    // Lo que NUNCA saca de las casas de los otros bots (son sus herramientas de repuesto)
    protect: ['*_pickaxe', '*_axe', '*_hoe', '*_shovel', '*_sword', 'fishing_rod', 'shears'],
    // Categorías en orden: cada objeto va a la primera que encaje (* = cualquier texto).
    // El nombre es lo que se escribe en el cartel del cofre. Puedes añadir, quitar o reordenar.
    categories: {
      'Madera':     ['*_log', '*_wood', '*_planks', 'stick', '*_sapling', 'mangrove_propagule', 'apple'],
      'Minerales':  ['diamond', 'emerald', 'raw_iron', 'raw_gold', 'raw_copper', '*_ingot', 'coal', 'lapis_lazuli', 'redstone', 'quartz', 'amethyst_shard'],
      'Piedra':     ['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'granite', 'diorite', 'andesite', 'tuff', 'calcite', 'gravel', 'flint', 'dirt', 'sand'],
      'Cultivos':   ['wheat', 'wheat_seeds', 'carrot', 'potato', 'poisonous_potato', 'beetroot', 'beetroot_seeds', 'pumpkin*', 'melon*'],
      'Pesca':      ['cod', 'salmon', 'pufferfish', 'tropical_fish', 'nautilus_shell', 'ink_sac', 'lily_pad'],
      'Comida':     ['bread', 'cooked_*', 'baked_potato', 'golden_apple', 'beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'milk_bucket'],
      'Mobs':       ['rotten_flesh', 'bone', 'string', 'spider_eye', 'gunpowder', 'arrow', 'leather', 'feather'],
      'Varios':     ['*'],
    },
  },

  // Ganadero: construye un corral de vallas alrededor de su casa y cría vacas dentro
  rancher: {
    penRadius: 6,          // Vallas a esta distancia del cofre de casa (interior de 11x11)
    maxCows: 10,           // Máximo de vacas (adultas + crías). Si se supera, sacrifica adultas sobrantes
    minBreeders: 2,        // Adultas que nunca sacrifica (para seguir criando)
    breedCooldownMinutes: 5, // Tiempo que una vaca tarda en poder volver a criar
    cycleSeconds: 15,      // Cada cuánto revisa el corral
  },

  // Artesano · hornos: fila de hornos junto a su casa (taller); materiales y combustible del almacén
  smelter: {
    furnaces: 4,           // Hornos que coloca junto a su casa
    cycleSeconds: 30,      // Cada cuánto revisa los hornos
    batchPerFurnace: 64,   // Cuánto mete en cada horno de una vez
    // Lo que funde o cocina (lo saca del almacén: Minerales, Comida, Pesca, Cultivos)
    smelt: ['raw_iron', 'raw_gold', 'raw_copper', 'beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato'],
    fuels: ['coal', 'charcoal', '*_log', '*_planks'], // combustible, en orden de preferencia
  },

  // Artesano · herramientas: fabrica repuestos con materiales del almacén y se los lleva a cada bot
  smith: {
    checkMinutes: 10,      // Cada cuánto revisa los repuestos
    sparesPerBot: 1,       // Herramientas de repuesto que debe haber en la casa de cada bot
    // Qué herramienta necesita cada bot
    tools: { woodcutter: 'axe', miner: 'pickaxe', farmer: 'hoe', fisher: 'fishing_rod', rancher: 'sword' },
    tiers: ['diamond', 'iron', 'stone'], // material preferido (si no hay, el siguiente)
  },

  // Pescador
  fishing: {
    searchRadius: 32,    // Busca agua abierta a esta distancia de su casa
  },

  // Bots disponibles (nombre en el servidor). home opcional: { x, y, z } de su cofre.
  // viewDistance opcional por bot (sustituye a server.viewDistance).
  // give: lo que entrega el botón "Dar herramienta" del panel con /give (el bot debe ser OP).
  bots: {
    woodcutter: { username: 'Bot_Lenador',  home: null, stuckWatch: true, pathfinderTickMs: 40, give: [{ item: 'diamond_axe', count: 1 }] },
    miner:      { username: 'Bot_Minero',   home: null, stuckWatch: true, pathfinderTickMs: 40, give: [{ item: 'diamond_pickaxe', count: 1 }] },
    farmer:     { username: 'Bot_Granjero', home: null, give: [{ item: 'diamond_hoe', count: 1 }, { item: 'wheat_seeds', count: 32 }] },
    fisher:     { username: 'Bot_Pescador', home: null, give: [{ item: 'fishing_rod', count: 1 }], viewDistance: 'tiny' }, // no explora: carga menos chunks
    organizer:  { username: 'Bot_Organizador', home: null, autoHome: false, pathfinderTickMs: 40 }, // su casa es el almacén central (la eliges tú)
    artisan:    { username: 'Bot_Artesano', home: null, autoHome: false, viewDistance: 'tiny' }, // funde, cocina y fabrica herramientas; su casa es el taller (la eliges tú)
    rancher:    { username: 'Bot_Ganadero', home: null, autoHome: false, viewDistance: 'tiny', give: [{ item: 'wheat', count: 64 }, { item: 'diamond_sword', count: 1 }] }, // su casa es el centro del corral (la eliges tú)
  },
}
