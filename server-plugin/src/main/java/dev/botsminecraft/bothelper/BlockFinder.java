package dev.botsminecraft.bothelper;

import org.bukkit.Bukkit;
import org.bukkit.ChunkSnapshot;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.block.data.Ageable;
import org.bukkit.block.data.BlockData;
import org.bukkit.scheduler.BukkitTask;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Búsqueda de bloques para los bots (POST /find). Los bots buscaban minerales, árboles y cultivos maduros
 * recorriendo cientos de miles de bloques en el panel (Node, un solo hilo para los 6 bots), lo que lo congelaba
 * varios segundos. Aquí lo hace el servidor sin frenar el juego:
 *  - En el hilo del juego solo se copian chunks ya cargados (ChunkSnapshot), de cerca a lejos y con un presupuesto
 *    de tiempo por tick (TICK_BUDGET_NS). Las copias se pasan por una cola al hilo de la petición.
 *  - El hilo de la petición recorre cada copia según llega y, en cuanto tiene suficientes resultados y los chunks
 *    que faltan están más lejos que el último que se quedaría, para: deja de pedir copias (no se copia todo el radio).
 *  - Los mismos filtros que aplicaría el bot (posiciones descartadas y zonas de atasco, suelo natural bajo un tronco,
 *    madurez de un cultivo) se aplican aquí, para no devolver candidatos que el bot tiraría.
 *  - Plazo total MAX_WAIT_MS, menor que el del panel: si el servidor va lento, se rinde antes que el bot.
 * No carga chunks.
 */
final class BlockFinder {
    private static final long TICK_BUDGET_NS = 2_000_000; // 2 ms por tick como mucho en el hilo del juego
    private static final long MAX_WAIT_MS = 4000;         // el panel espera 6 s: aquí nos rendimos antes
    private static final int MAX_RADIUS = 128;
    private static final int MAX_COUNT = 512;

    private final BotHelper plugin;

    BlockFinder(BotHelper plugin) {
        this.plugin = plugin;
    }

    /**
     * exclude: esferas {x, y, z, r} donde no buscar (bloques descartados por el bot, zonas donde se atascó).
     * hRadius: si es > 0, además como mucho a esa distancia en horizontal del centro (zona de trabajo del bot).
     */
    record Request(World world, int cx, int cy, int cz, int radius, int hRadius, Set<Material> types, int count,
                   int minY, int maxY, boolean matureOnly, boolean bottomOnly, Set<Material> groundBelow,
                   List<double[]> exclude) { }

    private record ChunkRef(int x, int z, double minDist) { }

    private record Snap(ChunkSnapshot snapshot, int index) { }

    private record Hit(int x, int y, int z, double dist) { }

    private static final Snap END = new Snap(null, -1);

    /** Hace la búsqueda. Se llama desde un hilo que NO es el del juego. */
    Map<String, Object> find(Request r) throws Exception {
        long t0 = System.nanoTime();
        int radius = Math.min(r.radius(), MAX_RADIUS);
        int count = Math.max(1, Math.min(r.count(), MAX_COUNT));
        double r2 = (double) radius * radius;
        int flat = r.hRadius() > 0 ? Math.min(r.hRadius(), radius) : radius; // alcance en horizontal
        double h2 = (double) flat * flat;
        int worldMin = r.world().getMinHeight();
        int minY = Math.max(r.minY(), worldMin);
        int maxY = Math.min(r.maxY(), r.world().getMaxHeight() - 1);

        // Chunks de la zona, del más cercano al más lejano (distancia mínima del centro al chunk)
        List<ChunkRef> chunks = new ArrayList<>();
        for (int x = (r.cx() - flat) >> 4; x <= (r.cx() + flat) >> 4; x++) {
            for (int z = (r.cz() - flat) >> 4; z <= (r.cz() + flat) >> 4; z++) {
                double dx = Math.max(Math.max((x << 4) - r.cx(), r.cx() - ((x << 4) + 15)), 0);
                double dz = Math.max(Math.max((z << 4) - r.cz(), r.cz() - ((z << 4) + 15)), 0);
                double d = Math.sqrt(dx * dx + dz * dz);
                if (d <= flat) chunks.add(new ChunkRef(x, z, d));
            }
        }
        chunks.sort(Comparator.comparingDouble(ChunkRef::minDist));

        BlockingQueue<Snap> queue = new LinkedBlockingQueue<>();
        AtomicBoolean stop = new AtomicBoolean(false);
        BukkitTask task = startCopying(r.world(), chunks, queue, stop);

        List<Hit> hits = new ArrayList<>();
        int scanned = 0;
        boolean timedOut = false;
        long deadline = System.currentTimeMillis() + MAX_WAIT_MS;
        try {
            while (true) {
                long left = deadline - System.currentTimeMillis();
                Snap item = left > 0 ? queue.poll(left, TimeUnit.MILLISECONDS) : null;
                if (item == null) { timedOut = true; break; }
                if (item == END) break;
                scanned++;
                scanChunk(item.snapshot(), r, r2, h2, minY, maxY, worldMin, hits);
                // ¿Basta ya? Si hay suficientes y el siguiente chunk está más lejos que el último que nos quedaríamos
                if (hits.size() >= count) {
                    hits.sort(Comparator.comparingDouble(Hit::dist));
                    int next = item.index() + 1;
                    if (next >= chunks.size() || chunks.get(next).minDist() > hits.get(count - 1).dist()) break;
                }
            }
        } finally {
            stop.set(true);
            task.cancel();
        }

        hits.sort(Comparator.comparingDouble(Hit::dist));
        List<int[]> out = new ArrayList<>();
        for (int i = 0; i < Math.min(count, hits.size()); i++) out.add(new int[] { hits.get(i).x(), hits.get(i).y(), hits.get(i).z() });
        return Map.of("ok", true, "positions", out, "chunks", scanned, "timedOut", timedOut, "ms", (System.nanoTime() - t0) / 1_000_000);
    }

    private static void scanChunk(ChunkSnapshot s, Request r, double r2, double h2, int minY, int maxY, int worldMin, List<Hit> hits) {
        int baseX = s.getX() << 4, baseZ = s.getZ() << 4;
        for (int lx = 0; lx < 16; lx++) {
            for (int lz = 0; lz < 16; lz++) {
                int wx = baseX + lx, wz = baseZ + lz;
                double hd2 = (double) (wx - r.cx()) * (wx - r.cx()) + (double) (wz - r.cz()) * (wz - r.cz());
                if (hd2 > h2) continue;
                for (int y = minY; y <= maxY; y++) {
                    Material m = s.getBlockType(lx, y, lz);
                    if (!r.types().contains(m)) continue;
                    double d2 = hd2 + (double) (y - r.cy()) * (y - r.cy());
                    if (d2 > r2) continue;
                    if (r.matureOnly()) {
                        BlockData bd = s.getBlockData(lx, y, lz);
                        if (bd instanceof Ageable a && a.getAge() < a.getMaximumAge()) continue;
                    }
                    if (y > worldMin) {
                        Material below = s.getBlockType(lx, y - 1, lz);
                        // La base de un árbol: debajo no hay otro tronco…
                        if (r.bottomOnly() && r.types().contains(below)) continue;
                        // …y es suelo natural (si se pidió): así no cuentan troncos de construcciones
                        if (r.groundBelow() != null && !r.groundBelow().contains(below)) continue;
                    }
                    if (excluded(r.exclude(), wx, y, wz)) continue;
                    hits.add(new Hit(wx, y, wz, Math.sqrt(d2)));
                }
            }
        }
    }

    private static boolean excluded(List<double[]> spheres, int x, int y, int z) {
        for (double[] e : spheres) {
            double dx = x - e[0], dy = y - e[1], dz = z - e[2];
            if (dx * dx + dy * dy + dz * dz <= e[3] * e[3]) return true;
        }
        return false;
    }

    /**
     * Copia en el hilo del juego los chunks cargados de la lista, de cerca a lejos, sin pasar de TICK_BUDGET_NS por
     * tick, y los deja en la cola. Para en cuanto `stop` se activa (ya hay suficientes resultados o se acabó el plazo).
     */
    private BukkitTask startCopying(World world, List<ChunkRef> chunks, BlockingQueue<Snap> queue, AtomicBoolean stop) {
        int[] next = { 0 };
        return Bukkit.getScheduler().runTaskTimer(plugin, () -> {
            if (stop.get() || next[0] >= chunks.size()) return;
            long start = System.nanoTime();
            try {
                while (!stop.get() && next[0] < chunks.size() && System.nanoTime() - start < TICK_BUDGET_NS) {
                    int i = next[0]++;
                    ChunkRef c = chunks.get(i);
                    if (world.isChunkLoaded(c.x(), c.z())) queue.add(new Snap(world.getChunkAt(c.x(), c.z()).getChunkSnapshot(false, false, false), i));
                }
            } catch (Throwable t) {
                plugin.getLogger().warning("Búsqueda de bloques: " + t);
                next[0] = chunks.size();
            }
            if (next[0] >= chunks.size()) queue.add(END);
        }, 0L, 1L);
    }

    /** Convierte nombres de bloque ("diamond_ore", "minecraft:oak_log") en materiales; ignora los desconocidos. */
    static Set<Material> materials(Iterable<String> names) {
        Set<Material> set = EnumSet.noneOf(Material.class);
        for (String n : names) {
            Material m = Material.matchMaterial(n);
            if (m != null && m.isBlock()) set.add(m);
        }
        return set;
    }
}
