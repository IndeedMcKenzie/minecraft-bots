package dev.botsminecraft.bothelper;

import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.configuration.file.FileConfiguration;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Item;
import org.bukkit.entity.Player;
import org.bukkit.entity.Projectile;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockDropItemEvent;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.entity.EntityDeathEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.player.PlayerAdvancementDoneEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.util.Vector;

import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Ayudas a los bots (solo afectan a los bots, nunca a jugadores normales):
 * - No pueden tapar cofres: se anula cualquier bloque sólido que pongan justo encima de uno
 *   (un cofre con un bloque sólido encima no se abre; con un cofre doble basta con una mitad).
 * - Silencio: sin mensajes de entrada, salida, muerte ni logros de los bots en el chat.
 * - Imán: lo que suelta un bloque que rompe un bot aparece a sus pies; lo que suelta una criatura que mata un bot (y su
 *   experiencia) va directamente a su inventario.
 * - Vigilancia para el rescate: cuánto tiempo lleva cada bot sin moverse (aunque se reconecte) y si está
 *   en peligro (lava, fuego, asfixia, ahogándose). El panel decide si lo devuelve a casa.
 */
final class BotAssist implements Listener {
    private static final Set<Material> CHESTS = EnumSet.of(Material.CHEST, Material.TRAPPED_CHEST);
    private static final Set<EntityDamageEvent.DamageCause> HAZARDS = EnumSet.of(
        EntityDamageEvent.DamageCause.LAVA, EntityDamageEvent.DamageCause.FIRE, EntityDamageEvent.DamageCause.FIRE_TICK,
        EntityDamageEvent.DamageCause.SUFFOCATION, EntityDamageEvent.DamageCause.DROWNING);
    private static final long HAZARD_WINDOW_MS = 15000;
    private static final double MOVE_THRESHOLD = 2.0;

    private final BotHelper plugin;
    private boolean guardChests, silence, magnet, mobLoot;

    // Por nombre de bot (sobrevive a las reconexiones): dónde estaba quieto y desde cuándo; último peligro
    private final Map<String, Location> anchor = new ConcurrentHashMap<>();
    private final Map<String, Long> stillSince = new ConcurrentHashMap<>();
    private final Map<String, Object[]> hazard = new ConcurrentHashMap<>(); // { causa, ms }
    private final Map<String, Map<String, Object>> lastDeath = new ConcurrentHashMap<>(); // causa, quién, cuándo, dónde

    BotAssist(BotHelper plugin) {
        this.plugin = plugin;
        reload();
        // Cada 5 s: actualizar desde cuándo está quieto cada bot conectado
        Bukkit.getScheduler().runTaskTimer(plugin, this::trackMovement, 100L, 100L);
    }

    void reload() {
        FileConfiguration c = plugin.getConfig();
        guardChests = c.getBoolean("protection.no-blocks-on-chests", true);
        silence = c.getBoolean("chat.silence-bots", true);
        magnet = c.getBoolean("magnet.enabled", true);
        mobLoot = c.getBoolean("magnet.mob-loot", true);
    }

    private boolean isBot(Player p) {
        return p != null && plugin.isBot(p);
    }

    // ── Vigilancia (para el rescate desde el panel) ──────────

    private void trackMovement() {
        long now = System.currentTimeMillis();
        for (Player p : Bukkit.getOnlinePlayers()) {
            if (!isBot(p)) continue;
            String name = p.getName();
            Location loc = p.getLocation();
            Location a = anchor.get(name);
            if (a == null || a.getWorld() != loc.getWorld() || a.distance(loc) > MOVE_THRESHOLD) {
                anchor.put(name, loc);
                stillSince.put(name, now);
            }
        }
    }

    /** Datos de vigilancia de un bot para /status: segundos quieto y peligro reciente (o null). */
    Map<String, Object> info(Player p) {
        Map<String, Object> out = new LinkedHashMap<>();
        Long since = stillSince.get(p.getName());
        out.put("stillSeconds", since == null ? 0 : (System.currentTimeMillis() - since) / 1000);
        Object[] h = hazard.get(p.getName());
        out.put("hazard", h != null && System.currentTimeMillis() - (long) h[1] < HAZARD_WINDOW_MS ? h[0] : null);
        Map<String, Object> d = lastDeath.get(p.getName());
        if (d != null) out.put("lastDeath", d);
        return out;
    }

    /** Tras teletransportar a un bot, no seguir contándolo como "quieto en el mismo sitio". */
    void resetTracking(Player p) {
        anchor.put(p.getName(), p.getLocation());
        stillSince.put(p.getName(), System.currentTimeMillis());
        hazard.remove(p.getName());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onHazard(EntityDamageEvent e) {
        if (e.getEntity() instanceof Player p && isBot(p) && HAZARDS.contains(e.getCause())) {
            hazard.put(p.getName(), new Object[] { e.getCause().name(), System.currentTimeMillis() });
        }
    }

    // ── No tapar cofres ──────────────────────────────────────

    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    public void onPlace(BlockPlaceEvent e) {
        if (!guardChests || !isBot(e.getPlayer())) return;
        Block placed = e.getBlockPlaced();
        if (!placed.getType().isOccluding()) return; // carteles, antorchas… no impiden abrir el cofre
        if (CHESTS.contains(placed.getRelative(BlockFace.DOWN).getType())) {
            e.setCancelled(true);
            plugin.getLogger().info(e.getPlayer().getName() + " iba a tapar el cofre en " + pos(placed.getRelative(BlockFace.DOWN).getLocation()) + ": anulado.");
        }
    }

    // ── Silencio en el chat ──────────────────────────────────

    @EventHandler(priority = EventPriority.HIGH)
    public void onJoin(PlayerJoinEvent e) {
        if (silence && isBot(e.getPlayer())) e.joinMessage(null);
    }

    @EventHandler(priority = EventPriority.HIGH)
    public void onQuit(PlayerQuitEvent e) {
        if (silence && isBot(e.getPlayer())) e.quitMessage(null);
    }

    /**
     * Muerte de un bot: el mensaje no sale en el chat (silencio), así que la causa se apunta en la consola y se da al
     * panel en /status (lastDeath). El 09/10 el Minero murió y no quedó rastro de por qué.
     */
    @EventHandler(priority = EventPriority.HIGH)
    public void onDeath(PlayerDeathEvent e) {
        Player p = e.getEntity();
        if (!isBot(p)) return;
        EntityDamageEvent last = p.getLastDamageCause();
        String cause = last != null ? last.getCause().name() : "UNKNOWN";
        String by = null;
        if (last instanceof EntityDamageByEntityEvent byEntity) {
            Entity damager = byEntity.getDamager();
            if (damager instanceof Projectile proj && proj.getShooter() instanceof Entity shooter) damager = shooter;
            by = damager.getType().getKey().getKey();
        }
        Location l = p.getLocation();
        Map<String, Object> info = new LinkedHashMap<>();
        info.put("cause", cause);
        if (by != null) info.put("by", by);
        info.put("at", System.currentTimeMillis());
        info.put("pos", new int[] { l.getBlockX(), l.getBlockY(), l.getBlockZ() });
        lastDeath.put(p.getName(), info);
        plugin.getLogger().info(p.getName() + " murió: " + cause + (by != null ? " (" + by + ")" : "") + " en " + pos(l));
        if (silence) e.deathMessage(null);
    }

    @EventHandler(priority = EventPriority.HIGH)
    public void onAdvancement(PlayerAdvancementDoneEvent e) {
        if (silence && isBot(e.getPlayer())) e.message(null);
    }

    // ── Imán ─────────────────────────────────────────────────

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onDrops(BlockDropItemEvent e) {
        if (!magnet || !isBot(e.getPlayer()) || e.getItems().isEmpty()) return;
        Player p = e.getPlayer();
        var items = java.util.List.copyOf(e.getItems());
        // En el siguiente tick, cuando los objetos ya existen en el mundo
        Bukkit.getScheduler().runTask(plugin, () -> {
            if (!p.isOnline()) return;
            for (Item item : items) {
                if (!item.isValid()) continue;
                item.teleport(p.getLocation());
                item.setVelocity(new Vector());
                item.setPickupDelay(0);
            }
        });
    }

    /** Botín de una criatura que mata un bot (espada o flecha): a su inventario, sin perseguir objetos por el suelo. */
    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    public void onMobDeath(EntityDeathEvent e) {
        if (!mobLoot || e.getEntity() instanceof Player) return;
        Player killer = e.getEntity().getKiller();
        if (!isBot(killer)) return;
        var drops = java.util.List.copyOf(e.getDrops());
        e.getDrops().clear();
        for (ItemStack it : drops) {
            for (ItemStack over : killer.getInventory().addItem(it).values()) killer.getWorld().dropItem(killer.getLocation(), over);
        }
        if (e.getDroppedExp() > 0) {
            killer.giveExp(e.getDroppedExp());
            e.setDroppedExp(0);
        }
    }

    private static String pos(Location l) {
        return l.getBlockX() + "," + l.getBlockY() + "," + l.getBlockZ();
    }
}
