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
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Búsqueda de bloques para los bots (POST /find). Los bots buscaban minerales, árboles y cultivos maduros
 * recorriendo cientos de miles de bloques en el panel (Node, un solo hilo para los 6 bots), lo que lo congelaba
 * varios segundos. Aquí lo hace el servidor sin frenar el juego:
 *  1. En el hilo principal solo se copian los chunks cargados de la zona (ChunkSnapshot), de cerca a lejos y con
 *     un presupuesto de tiempo por tick (TICK_BUDGET_NS), repartido en varios ticks si hace falta.
 *  2. El recorrido de los bloques se hace en el hilo de la petición HTTP (no en el del juego), chunk a chunk de
 *     cerca a lejos, y se para en cuanto hay suficientes resultados y los chunks que quedan están más lejos.
 * No carga chunks: solo mira los que ya están cargados.
 */
final class BlockFinder {
    private static final long TICK_BUDGET_NS = 2_000_000; // 2 ms por tick como mucho en el hilo del juego
    private static final int MAX_RADIUS = 128;
    private static final int MAX_COUNT = 512;

    private final BotHelper plugin;

    BlockFinder(BotHelper plugin) {
        this.plugin = plugin;
    }

    record Request(World world, int cx, int cy, int cz, int radius, Set<Material> types, int count,
                   int minY, int maxY, boolean matureOnly, boolean bottomOnly) { }

    private record ChunkRef(int x, int z, double minDist) { }

    private record Hit(int x, int y, int z, double dist) { }

    /** Hace la búsqueda. Se llama desde un hilo que NO es el del juego. */
    Map<String, Object> find(Request r) throws Exception {
        long t0 = System.nanoTime();
        int radius = Math.min(r.radius(), MAX_RADIUS);
        int count = Math.max(1, Math.min(r.count(), MAX_COUNT));
        double r2 = (double) radius * radius;

        // Chunks de la zona, del más cercano al más lejano (distancia mínima del centro al chunk)
        List<ChunkRef> chunks = new ArrayList<>();
        for (int x = (r.cx() - radius) >> 4; x <= (r.cx() + radius) >> 4; x++) {
            for (int z = (r.cz() - radius) >> 4; z <= (r.cz() + radius) >> 4; z++) {
                double dx = Math.max(Math.max((x << 4) - r.cx(), r.cx() - ((x << 4) + 15)), 0);
                double dz = Math.max(Math.max((z << 4) - r.cz(), r.cz() - ((z << 4) + 15)), 0);
                double d = Math.sqrt(dx * dx + dz * dz);
                if (d <= radius) chunks.add(new ChunkRef(x, z, d));
            }
        }
        chunks.sort(Comparator.comparingDouble(ChunkRef::minDist));

        // 1. Copias de los chunks cargados, en el hilo del juego y con presupuesto por tick
        List<ChunkSnapshot> snaps = snapshot(r.world(), chunks);

        // 2. Recorrer las copias de cerca a lejos
        int minY = Math.max(r.minY(), r.world().getMinHeight());
        int maxY = Math.min(r.maxY(), r.world().getMaxHeight() - 1);
        List<Hit> hits = new ArrayList<>();
        int scanned = 0;
        for (int i = 0; i < snaps.size(); i++) {
            ChunkSnapshot s = snaps.get(i);
            scanned++;
            int baseX = s.getX() << 4, baseZ = s.getZ() << 4;
            for (int lx = 0; lx < 16; lx++) {
                for (int lz = 0; lz < 16; lz++) {
                    int wx = baseX + lx, wz = baseZ + lz;
                    double hd2 = (double) (wx - r.cx()) * (wx - r.cx()) + (double) (wz - r.cz()) * (wz - r.cz());
                    if (hd2 > r2) continue;
                    for (int y = minY; y <= maxY; y++) {
                        Material m = s.getBlockType(lx, y, lz);
                        if (!r.types().contains(m)) continue;
                        double d2 = hd2 + (double) (y - r.cy()) * (y - r.cy());
                        if (d2 > r2) continue;
                        if (r.matureOnly()) {
                            BlockData bd = s.getBlockData(lx, y, lz);
                            if (bd instanceof Ageable a && a.getAge() < a.getMaximumAge()) continue;
                        }
                        // La base de un árbol: el bloque de debajo no es del mismo tipo (tronco)
                        if (r.bottomOnly() && y > r.world().getMinHeight() && r.types().contains(s.getBlockType(lx, y - 1, lz))) continue;
                        hits.add(new Hit(wx, y, wz, Math.sqrt(d2)));
                    }
                }
            }
            // ¿Se puede parar ya? Si hay suficientes y el siguiente chunk está más lejos que el último que nos quedaríamos
            if (hits.size() >= count && i + 1 < snaps.size()) {
                hits.sort(Comparator.comparingDouble(Hit::dist));
                double kth = hits.get(count - 1).dist();
                double next = minDistOf(chunks, snaps.get(i + 1));
                if (next > kth) break;
            }
        }
        hits.sort(Comparator.comparingDouble(Hit::dist));
        List<int[]> out = new ArrayList<>();
        for (int i = 0; i < Math.min(count, hits.size()); i++) out.add(new int[] { hits.get(i).x(), hits.get(i).y(), hits.get(i).z() });
        return Map.of("ok", true, "positions", out, "chunks", scanned, "ms", (System.nanoTime() - t0) / 1_000_000);
    }

    private static double minDistOf(List<ChunkRef> chunks, ChunkSnapshot s) {
        for (ChunkRef c : chunks) if (c.x() == s.getX() && c.z() == s.getZ()) return c.minDist();
        return 0;
    }

    /** Copia los chunks cargados de la lista en el hilo del juego, sin pasar de TICK_BUDGET_NS por tick. */
    private List<ChunkSnapshot> snapshot(World world, List<ChunkRef> chunks) throws Exception {
        CompletableFuture<List<ChunkSnapshot>> done = new CompletableFuture<>();
        List<ChunkSnapshot> snaps = new ArrayList<>();
        int[] next = { 0 };
        BukkitTask[] task = { null };
        task[0] = Bukkit.getScheduler().runTaskTimer(plugin, () -> {
            long start = System.nanoTime();
            try {
                while (next[0] < chunks.size() && System.nanoTime() - start < TICK_BUDGET_NS) {
                    ChunkRef c = chunks.get(next[0]++);
                    if (world.isChunkLoaded(c.x(), c.z())) snaps.add(world.getChunkAt(c.x(), c.z()).getChunkSnapshot(false, false, false));
                }
            } catch (Throwable t) {
                done.completeExceptionally(t);
            }
            if (next[0] >= chunks.size() && !done.isDone()) done.complete(snaps);
            if (done.isDone() && task[0] != null) task[0].cancel();
        }, 0L, 1L);
        try {
            return done.get(8, TimeUnit.SECONDS);
        } finally {
            if (task[0] != null) task[0].cancel();
        }
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
