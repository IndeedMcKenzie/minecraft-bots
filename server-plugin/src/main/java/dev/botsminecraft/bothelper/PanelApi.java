package dev.botsminecraft.bothelper;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.core.LogEvent;
import org.apache.logging.log4j.core.Logger;
import org.apache.logging.log4j.core.appender.AbstractAppender;
import org.apache.logging.log4j.core.config.Property;
import org.bukkit.Bukkit;
import org.bukkit.Chunk;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.block.BlockState;
import org.bukkit.block.Container;
import org.bukkit.block.Sign;
import org.bukkit.block.sign.Side;
import org.bukkit.entity.Player;
import org.bukkit.inventory.DoubleChestInventory;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.logging.Level;

/**
 * Pequeño servidor HTTP solo para este PC (127.0.0.1) que usa el panel de los bots.
 * Todas las peticiones llevan la cabecera X-Token con la clave de token.txt.
 *  GET  /status   → TPS, tiempo por tick, memoria, jugadores y entidades
 *  POST /chests   → { world, x, y, z, radius } → contenido de los cofres y barriles de esa zona
 *  POST /command  → { command } → ejecuta un comando como la consola y devuelve la respuesta
 */
final class PanelApi {
    private static final Gson GSON = new Gson();
    private static final Set<Material> STORAGE = Set.of(Material.CHEST, Material.TRAPPED_CHEST, Material.BARREL);
    private static final BlockFace[] SIGN_FACES = { BlockFace.UP, BlockFace.NORTH, BlockFace.SOUTH, BlockFace.EAST, BlockFace.WEST };

    private final BotHelper plugin;
    private final int port;
    private final byte[] token;
    private HttpServer server;
    private ExecutorService executor;
    // Carril aparte para /find: una búsqueda puede tardar varios ticks y no debe dejar en cola al estado,
    // los teletransportes ni la consola (si /status no responde, el panel cree que el plugin se ha caído)
    private ExecutorService findLane;

    PanelApi(BotHelper plugin, int port, String token) {
        this.plugin = plugin;
        this.port = port;
        this.token = token.getBytes(StandardCharsets.UTF_8);
        this.finder = new BlockFinder(plugin);
    }

    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 0);
        executor = Executors.newFixedThreadPool(2, r -> {
            Thread t = new Thread(r, "BotHelper-HTTP");
            t.setDaemon(true);
            return t;
        });
        findLane = Executors.newFixedThreadPool(2, r -> {
            Thread t = new Thread(r, "BotHelper-Find");
            t.setDaemon(true);
            return t;
        });
        server.setExecutor(executor);
        server.createContext("/status", ex -> handle(ex, "GET", body -> status()));
        server.createContext("/chests", ex -> handle(ex, "POST", this::chests));
        server.createContext("/command", ex -> handle(ex, "POST", this::command));
        server.createContext("/events", ex -> handle(ex, "POST", this::events));
        server.createContext("/teleport", ex -> handle(ex, "POST", this::teleport));
        server.createContext("/markers", ex -> handle(ex, "POST", this::markers));
        // El hilo HTTP solo entrega la petición al carril de búsquedas y queda libre al momento
        server.createContext("/find", ex -> findLane.execute(() -> {
            try { handle(ex, "POST", this::find); } catch (IOException ignored) { }
        }));
        server.start();
    }

    void stop() {
        if (server != null) server.stop(0);
        if (executor != null) executor.shutdownNow();
        if (findLane != null) findLane.shutdownNow();
    }

    private interface Handler {
        Object run(JsonObject body) throws Exception;
    }

    private void handle(HttpExchange ex, String method, Handler handler) throws IOException {
        // Sin try-with-resources: cerraría la conexión antes del catch y el error nunca llegaría al panel
        try {
            String given = ex.getRequestHeaders().getFirst("X-Token");
            if (given == null || !MessageDigest.isEqual(token, given.getBytes(StandardCharsets.UTF_8))) {
                send(ex, 403, Map.of("ok", false, "error", "Clave incorrecta"));
                return;
            }
            if (!ex.getRequestMethod().equals(method)) {
                send(ex, 405, Map.of("ok", false, "error", "Método no permitido"));
                return;
            }
            JsonObject body = new JsonObject();
            if (method.equals("POST")) {
                byte[] raw = ex.getRequestBody().readNBytes(8192);
                if (raw.length > 0) body = JsonParser.parseString(new String(raw, StandardCharsets.UTF_8)).getAsJsonObject();
            }
            send(ex, 200, handler.run(body));
        } catch (Throwable e) {
            plugin.getLogger().log(Level.WARNING, "Error atendiendo al panel (" + ex.getRequestURI() + ")", e);
            Throwable root = e;
            while (root.getCause() != null && root.getCause() != root) root = root.getCause();
            String msg = root.getClass().getSimpleName() + (root.getMessage() != null ? ": " + root.getMessage() : "");
            try { send(ex, 500, Map.of("ok", false, "error", msg)); } catch (Throwable ignored) { }
        } finally {
            ex.close();
        }
    }

    private static void send(HttpExchange ex, int code, Object data) throws IOException {
        byte[] out = GSON.toJson(data).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(code, out.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(out); }
    }

    /** Ejecuta en el hilo principal del servidor (el mundo solo se puede tocar desde ahí). */
    private <T> T sync(Callable<T> task) throws Exception {
        return Bukkit.getScheduler().callSyncMethod(plugin, task).get(5, TimeUnit.SECONDS);
    }

    // ── /status ──────────────────────────────────────────────

    private Object status() throws Exception {
        return sync(() -> {
            Map<String, Object> out = new LinkedHashMap<>();
            double[] tps = Bukkit.getTPS();
            out.put("tps", new double[] { round(tps[0]), round(tps[1]), round(tps[2]) });
            out.put("mspt", round(Bukkit.getAverageTickTime()));
            Runtime rt = Runtime.getRuntime();
            out.put("memory", Map.of("usedMB", (rt.totalMemory() - rt.freeMemory()) / 1048576, "maxMB", rt.maxMemory() / 1048576));
            List<Map<String, Object>> players = new ArrayList<>();
            for (Player p : Bukkit.getOnlinePlayers()) {
                Location l = p.getLocation();
                Map<String, Object> info = new LinkedHashMap<>(Map.of("name", p.getName(), "bot", plugin.isBot(p), "world", l.getWorld().getName(),
                    "x", l.getBlockX(), "y", l.getBlockY(), "z", l.getBlockZ(), "health", round(p.getHealth())));
                if (plugin.isBot(p) && plugin.assist() != null) info.putAll(plugin.assist().info(p));
                players.add(info);
            }
            out.put("players", players);
            List<Map<String, Object>> worlds = new ArrayList<>();
            for (World w : Bukkit.getWorlds()) {
                worlds.add(Map.of("name", w.getName(), "entities", w.getEntityCount(), "chunks", w.getLoadedChunks().length));
            }
            out.put("worlds", worlds);
            return out;
        });
    }

    private static double round(double v) {
        return Math.round(v * 100) / 100.0;
    }

    // ── /chests ──────────────────────────────────────────────

    private Object chests(JsonObject body) throws Exception {
        String worldName = body.has("world") ? body.get("world").getAsString() : "world";
        int cx = body.get("x").getAsInt(), cy = body.get("y").getAsInt(), cz = body.get("z").getAsInt();
        int radius = Math.min(body.has("radius") ? body.get("radius").getAsInt() : 32, 160);
        return sync(() -> {
            World w = Bukkit.getWorld(worldName);
            if (w == null) return Map.of("ok", false, "error", "No existe el mundo " + worldName);
            Location center = new Location(w, cx, cy, cz);
            double r2 = (double) radius * radius;
            List<Map<String, Object>> result = new ArrayList<>();
            Set<String> seen = new HashSet<>();
            int minCX = (cx - radius) >> 4, maxCX = (cx + radius) >> 4, minCZ = (cz - radius) >> 4, maxCZ = (cz + radius) >> 4;
            int notLoaded = 0;
            for (int x = minCX; x <= maxCX; x++) {
                for (int z = minCZ; z <= maxCZ; z++) {
                    // Solo chunks ya cargados: no se carga mundo por esto
                    if (!w.isChunkLoaded(x, z)) { notLoaded++; continue; }
                    Chunk chunk = w.getChunkAt(x, z);
                    for (BlockState state : chunk.getTileEntities(false)) {
                        if (!(state instanceof Container container) || !STORAGE.contains(state.getType())) continue;
                        Location loc = state.getLocation();
                        if (loc.distanceSquared(center) > r2) continue;
                        Inventory inv = container.getInventory();
                        List<int[]> halves = new ArrayList<>();
                        Location key = loc;
                        if (inv instanceof DoubleChestInventory dc) {
                            // Un cofre doble se cuenta una vez, con la posición de su mitad izquierda
                            Location left = dc.getLeftSide().getLocation(), right = dc.getRightSide().getLocation();
                            if (left != null) key = left;
                            if (left != null) halves.add(pos(left));
                            if (right != null) halves.add(pos(right));
                        } else {
                            halves.add(pos(loc));
                        }
                        if (!seen.add(key.getBlockX() + "," + key.getBlockY() + "," + key.getBlockZ())) continue;
                        Map<String, Integer> items = new TreeMap<>();
                        for (ItemStack it : inv.getContents()) {
                            if (it == null || it.getType().isAir()) continue;
                            items.merge(it.getType().getKey().getKey(), it.getAmount(), Integer::sum);
                        }
                        String label = null;
                        for (int[] h : halves) {
                            label = signLabel(w.getBlockAt(h[0], h[1], h[2]));
                            if (label != null) break;
                        }
                        Map<String, Object> entry = new LinkedHashMap<>();
                        entry.put("pos", pos(key));
                        entry.put("halves", halves);
                        entry.put("type", state.getType().getKey().getKey());
                        entry.put("label", label);
                        entry.put("slots", inv.getSize());
                        entry.put("items", items);
                        result.add(entry);
                    }
                }
            }
            return Map.of("ok", true, "chests", result, "chunksNotLoaded", notLoaded);
        });
    }

    private static int[] pos(Location l) {
        return new int[] { l.getBlockX(), l.getBlockY(), l.getBlockZ() };
    }

    /** Primera línea con texto del cartel encima o al lado del cofre (igual que lo leen los bots). */
    private static String signLabel(Block chest) {
        for (BlockFace face : SIGN_FACES) {
            if (!(chest.getRelative(face).getState(false) instanceof Sign sign)) continue;
            for (Side side : Side.values()) {
                for (var line : sign.getSide(side).lines()) {
                    String text = PlainTextComponentSerializer.plainText().serialize(line).trim();
                    if (!text.isEmpty()) return text;
                }
            }
        }
        return null;
    }

    // ── /find ────────────────────────────────────────────────
    // { x, y, z, radius, types: ["diamond_ore", …], count?, minY?, maxY?, mature?, bottom?, world? }
    // → { positions: [[x,y,z], …] } del más cercano al más lejano. Ver BlockFinder.

    private final BlockFinder finder;

    private Object find(JsonObject body) throws Exception {
        // Mundo: el del bot que busca (si está en el Nether, se busca allí); si no, el que se indique o el principal
        World w = null;
        if (body.has("player")) {
            Player p = Bukkit.getPlayerExact(body.get("player").getAsString());
            if (p != null) w = p.getWorld();
        }
        if (w == null && body.has("world")) w = Bukkit.getWorld(body.get("world").getAsString());
        if (w == null) w = Bukkit.getWorlds().get(0);
        var types = BlockFinder.materials(strings(body, "types"));
        if (types.isEmpty()) return Map.of("ok", false, "error", "Ningún tipo de bloque válido");
        var ground = body.has("groundBelow") ? BlockFinder.materials(strings(body, "groundBelow")) : null;
        List<double[]> exclude = new ArrayList<>();
        if (body.has("exclude")) {
            for (var e : body.getAsJsonArray("exclude")) {
                var a = e.getAsJsonArray();
                exclude.add(new double[] { a.get(0).getAsDouble(), a.get(1).getAsDouble(), a.get(2).getAsDouble(), a.size() > 3 ? a.get(3).getAsDouble() : 0 });
            }
        }
        return finder.find(new BlockFinder.Request(w,
            body.get("x").getAsInt(), body.get("y").getAsInt(), body.get("z").getAsInt(),
            body.has("radius") ? body.get("radius").getAsInt() : 32,
            body.has("hRadius") && !body.get("hRadius").isJsonNull() ? body.get("hRadius").getAsInt() : 0, types,
            body.has("count") ? body.get("count").getAsInt() : 64,
            body.has("minY") ? body.get("minY").getAsInt() : Integer.MIN_VALUE,
            body.has("maxY") ? body.get("maxY").getAsInt() : Integer.MAX_VALUE,
            body.has("mature") && body.get("mature").getAsBoolean(),
            body.has("bottom") && body.get("bottom").getAsBoolean(),
            ground, exclude));
    }

    private static List<String> strings(JsonObject body, String key) {
        List<String> out = new ArrayList<>();
        for (var e : body.getAsJsonArray(key)) out.add(e.getAsString());
        return out;
    }

    // ── /teleport ────────────────────────────────────────────
    // { player, x, y, z, world? } o { player, to: "OtroJugador" }. Sin comando de chat: no aparece "[Bot: Teleported…]"
    // en el chat de los OP ni en la consola, y el bot no necesita ser OP para esto.

    private Object teleport(JsonObject body) throws Exception {
        String name = body.get("player").getAsString();
        return sync(() -> {
            Player p = Bukkit.getPlayerExact(name);
            if (p == null) return Map.of("ok", false, "error", name + " no está conectado");
            if (!plugin.isBot(p)) return Map.of("ok", false, "error", "Solo se puede teletransportar a los bots");
            Location dest;
            if (body.has("to")) {
                Player target = Bukkit.getPlayerExact(body.get("to").getAsString());
                if (target == null) return Map.of("ok", false, "error", "Ese jugador no está conectado");
                dest = target.getLocation();
            } else {
                World w = body.has("world") ? Bukkit.getWorld(body.get("world").getAsString()) : p.getWorld();
                if (w == null) return Map.of("ok", false, "error", "Mundo desconocido");
                double x = body.get("x").getAsDouble(), z = body.get("z").getAsDouble();
                // surface: encima del bloque más alto de esa columna (zona de trabajo elegida en el mapa: la altura
                // de la vista del mapa no tiene por qué ser la del suelo)
                double y = body.has("surface") && body.get("surface").getAsBoolean()
                    ? w.getHighestBlockYAt((int) Math.floor(x), (int) Math.floor(z)) + 1
                    : body.get("y").getAsDouble();
                dest = new Location(w, x, y, z, p.getLocation().getYaw(), p.getLocation().getPitch());
            }
            boolean ok = p.teleport(dest, org.bukkit.event.player.PlayerTeleportEvent.TeleportCause.PLUGIN);
            if (ok && plugin.assist() != null) plugin.assist().resetTracking(p);
            return Map.of("ok", ok);
        });
    }

    // ── /markers (BlueMap) ───────────────────────────────────
    // { bots: [{ key, label, color, trail: [[x,y,z]…], home: [x,y,z] | null, zone: {x,y,z,radius} | null }] }
    // Sustituye todo lo dibujado; el panel lo manda cada 30 s.
    private Object markers(JsonObject body) {
        MapMarkers m = plugin.markers();
        boolean ok = m != null && m.update(body);
        return Map.of("ok", ok, "bluemap", m != null && m.available());
    }

    // ── /events (registro de diagnóstico) ─────────────────────

    private Object events(JsonObject body) {
        DebugLog log = plugin.debug();
        if (body.has("enable")) log.setEnabled(body.get("enable").getAsBoolean());
        long since = body.has("since") ? body.get("since").getAsLong() : 0;
        String player = body.has("player") && !body.get("player").isJsonNull() ? body.get("player").getAsString() : null;
        int limit = body.has("limit") ? Math.min(body.get("limit").getAsInt(), 3000) : 500;
        return Map.of("ok", true, "enabled", log.isEnabled(), "events", log.query(since, player, limit));
    }

    // ── /command ─────────────────────────────────────────────

    private Object command(JsonObject body) throws Exception {
        String cmd = body.has("command") ? body.get("command").getAsString().trim() : "";
        if (cmd.startsWith("/")) cmd = cmd.substring(1);
        if (cmd.isEmpty()) return Map.of("ok", false, "error", "Comando vacío");
        final String command = cmd;
        List<String> output = Collections.synchronizedList(new ArrayList<>());
        // Se ejecuta como la consola real (funciona con todos los comandos, también los de Mojang) y se
        // captura lo que el comando escribe en el registro del servidor desde el hilo principal mientras dura.
        // El registro puede ser asíncrono: se filtra por el hilo que originó cada mensaje y se espera un poco.
        Logger root = (Logger) LogManager.getRootLogger();
        String[] mainThread = { null };
        long[] window = { Long.MAX_VALUE, Long.MAX_VALUE }; // inicio y fin del comando (hora de cada mensaje)
        // ignoreExceptions = true y todo dentro de try: pase lo que pase al leer un mensaje, el comando no se rompe
        AbstractAppender capture = new AbstractAppender("BotHelperCapture", null, null, true, Property.EMPTY_ARRAY) {
            @Override
            public void append(LogEvent event) {
                try {
                    long t = event.getTimeMillis();
                    if (t < window[0] || t > window[1] || mainThread[0] == null || !mainThread[0].equals(event.getThreadName())) return;
                    String text;
                    try { text = event.getMessage().getFormattedMessage(); } catch (Throwable e) { text = String.valueOf(event.getMessage().getFormat()); }
                    output.add(text);
                } catch (Throwable ignored) { }
            }
        };
        capture.start();
        boolean ok;
        try {
            ok = sync(() -> {
                plugin.getLogger().info("Comando desde el panel: /" + command);
                mainThread[0] = Thread.currentThread().getName();
                root.addAppender(capture);
                window[0] = System.currentTimeMillis();
                try {
                    return Bukkit.dispatchCommand(Bukkit.getConsoleSender(), command);
                } finally {
                    window[1] = System.currentTimeMillis();
                }
            });
            Thread.sleep(200); // dejar llegar los mensajes que se escriben de forma asíncrona
        } finally {
            root.removeAppender(capture);
            capture.stop();
        }
        synchronized (output) {
            // Quitar colores (§x) y códigos de terminal que pueda traer el texto
            List<String> clean = new ArrayList<>();
            for (String line : output) clean.add(line.replaceAll("§.", "").replaceAll("\u001B\\[[;\\d]*m", ""));
            return Map.of("ok", true, "known", ok, "output", clean);
        }
    }
}
