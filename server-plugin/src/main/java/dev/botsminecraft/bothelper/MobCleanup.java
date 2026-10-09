package dev.botsminecraft.bothelper;

import com.destroystokyo.paper.event.entity.PreCreatureSpawnEvent;
import io.papermc.paper.entity.Bucketable;
import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.World;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.entity.Ambient;
import org.bukkit.entity.Boss;
import org.bukkit.entity.Enemy;
import org.bukkit.entity.EntityType;
import org.bukkit.entity.Mob;
import org.bukkit.entity.Player;
import org.bukkit.entity.Raider;
import org.bukkit.entity.WaterMob;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.CreatureSpawnEvent.SpawnReason;

import java.util.ArrayList;
import java.util.List;

/**
 * Criaturas alrededor de los bots. En Paper 26.2, setAffectsSpawning(false) NO impide que aparezcan criaturas
 * alrededor de los bots (medido: cientos por minuto), pero SÍ impide que desaparezcan solas (Minecraft no encuentra
 * "un jugador que cuente" cerca): se acumulaban por miles en los chunks que los bots mantienen cargados.
 *  - Apariciones: las naturales (y las patrullas) de monstruos, murciélagos y peces se cancelan antes de crear la
 *    criatura si no hay ningún jugador real a menos de `radius` bloques (cerca de ti aparecen como siempre).
 *  - Limpieza: cada minuto se quitan las criaturas "desechables" lejos de todo jugador real (las que se cargan de
 *    chunks guardados, las de generadores…), como haría el juego.
 *  Los bots cazadores (lista hunters) cuentan como jugadores reales: a su alrededor sí aparecen monstruos.
 */
final class MobCleanup implements Runnable, Listener {
    private static final long LOG_EVERY_MS = 10 * 60 * 1000;

    private final BotHelper plugin;
    private boolean enabled, preventSpawns;
    private double radiusSq;
    private int removedSinceLog;
    private long lastLog;
    private boolean firstRun = true;

    MobCleanup(BotHelper plugin) {
        this.plugin = plugin;
        reload();
    }

    void start() {
        Bukkit.getScheduler().runTaskTimer(plugin, this, 20L * 30, 20L * 60); // primera a los 30 s, luego cada minuto
    }

    void reload() {
        FileConfiguration c = plugin.getConfig();
        enabled = c.getBoolean("cleanup.enabled", true);
        preventSpawns = c.getBoolean("cleanup.prevent-spawns", true);
        double r = Math.max(32, c.getDouble("cleanup.radius", 128));
        radiusSq = r * r;
    }

    @Override
    public void run() {
        if (!enabled) return;
        boolean anyBot = false;
        for (Player p : Bukkit.getOnlinePlayers()) if (plugin.isBot(p)) { anyBot = true; break; }
        if (!anyBot) return;

        int removed = 0;
        for (World w : Bukkit.getWorlds()) {
            List<Location> realPlayers = new ArrayList<>();
            for (Player p : w.getPlayers()) if (plugin.countsForMobs(p)) realPlayers.add(p.getLocation());
            for (Mob m : w.getEntitiesByClass(Mob.class)) {
                if (!disposable(m) || nearAny(realPlayers, m.getLocation())) continue;
                m.remove();
                removed++;
            }
        }

        removedSinceLog += removed;
        long now = System.currentTimeMillis();
        if (removedSinceLog > 0 && (firstRun || now - lastLog >= LOG_EVERY_MS)) {
            plugin.getLogger().info("Limpieza: " + removedSinceLog + " monstruos/murciélagos/peces lejos de los jugadores"
                + (firstRun ? " (acumulados porque los bots no cuentan para que desaparezcan)" : " en los últimos minutos") + ".");
            removedSinceLog = 0;
            lastLog = now;
        }
        firstRun = false;
    }

    /** Apariciones naturales lejos de jugadores reales: se cancelan antes de crear la criatura. */
    @EventHandler(ignoreCancelled = true)
    public void onPreSpawn(PreCreatureSpawnEvent e) {
        if (!preventSpawns || (e.getReason() != SpawnReason.NATURAL && e.getReason() != SpawnReason.PATROL)) return;
        Class<?> type = e.getType().getEntityClass();
        if (type == null || !(Enemy.class.isAssignableFrom(type) || Ambient.class.isAssignableFrom(type) || WaterMob.class.isAssignableFrom(type))) return;
        Location at = e.getSpawnLocation();
        for (Player p : at.getWorld().getPlayers()) {
            if (plugin.countsForMobs(p) && p.getLocation().distanceSquared(at) <= radiusSq) return; // hay alguien de verdad (o un cazador) cerca
        }
        e.setCancelled(true);
        e.setShouldAbortSpawn(true); // y que no lo reintente en esta vuelta (ahorra trabajo)
    }

    /** Criaturas que el juego eliminaría al estar lejos de los jugadores. */
    private static boolean disposable(Mob m) {
        if (!(m instanceof Enemy || m instanceof Ambient || m instanceof WaterMob)) return false; // nunca animales ni aldeanos
        if (m instanceof Boss || m instanceof Raider || m.getType() == EntityType.WARDEN) return false;
        if (m instanceof Bucketable b && b.isFromBucket()) return false; // peces de un acuario
        return m.getRemoveWhenFarAway() && m.customName() == null && !m.isLeashed()
            && m.getPassengers().isEmpty() && !m.isInsideVehicle();
    }

    private boolean nearAny(List<Location> players, Location loc) {
        for (Location p : players) if (p.distanceSquared(loc) <= radiusSq) return true;
        return false;
    }
}
