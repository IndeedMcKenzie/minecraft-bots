package dev.botsminecraft.bothelper;

import com.destroystokyo.paper.event.player.PlayerClientOptionsChangeEvent;
import org.bukkit.Bukkit;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Enemy;
import org.bukkit.entity.Item;
import org.bukkit.entity.Entity;
import org.bukkit.entity.Player;
import org.bukkit.entity.Projectile;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageByEntityEvent;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.EntityTargetLivingEntityEvent;
import org.bukkit.event.player.PlayerFishEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.projectiles.ProjectileSource;
import org.bukkit.util.Vector;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.SecureRandom;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Set;

/**
 * BotHelper: ayuda a los bots de Mineflayer desde dentro del servidor.
 * - Rendimiento: los bots no hacen aparecer criaturas, no cuentan para dormir y el servidor solo carga a su alrededor
 *   los chunks que piden (su distancia de visión). Las criaturas que se acumulan lejos de jugadores reales se limpian
 *   (ver {@link MobCleanup}).
 * - Protección: sin daño de monstruos ni de caída, y los monstruos no los persiguen.
 * - Conexión con el panel (ver {@link PanelApi}): estado del servidor, contenido de cofres y consola.
 */
public final class BotHelper extends JavaPlugin implements Listener {

    private final Set<String> bots = new HashSet<>();
    private String prefix = "";
    private boolean noMobSpawning, ignoreSleep, botViewDistance, noMonsterDamage, noFallDamage, noMonsterTarget, deliverCatch;
    private PanelApi api;
    private DebugLog debug;
    private BotAssist assist;
    private MapMarkers markers;
    private MobCleanup cleanup;

    @Override
    public void onEnable() {
        saveDefaultConfig();
        loadSettings();
        getServer().getPluginManager().registerEvents(this, this);
        debug = new DebugLog(this, getConfig().getBoolean("debug.enabled", false));
        getServer().getPluginManager().registerEvents(debug, this);
        assist = new BotAssist(this);
        getServer().getPluginManager().registerEvents(assist, this);
        // Recorridos, casas y zonas de los bots en BlueMap (si está instalado: se carga antes por softdepend)
        markers = new MapMarkers(this);
        markers.start();
        cleanup = new MobCleanup(this);
        cleanup.start();
        getServer().getPluginManager().registerEvents(cleanup, this);
        startApi();
    }

    @Override
    public void onDisable() {
        stopApi();
        if (markers != null) markers.stop();
    }

    private void loadSettings() {
        reloadConfig();
        var c = getConfig();
        bots.clear();
        for (String name : c.getStringList("bots")) bots.add(name.toLowerCase(Locale.ROOT));
        prefix = c.getString("prefix", "");
        noMobSpawning = c.getBoolean("performance.no-mob-spawning", true);
        ignoreSleep = c.getBoolean("performance.ignore-sleep", true);
        botViewDistance = c.getBoolean("performance.bot-view-distance", true);
        noMonsterDamage = c.getBoolean("protection.no-monster-damage", true);
        noFallDamage = c.getBoolean("protection.no-fall-damage", true);
        noMonsterTarget = c.getBoolean("protection.no-monster-target", true);
        deliverCatch = c.getBoolean("fishing.deliver-catch", true);
        for (Player p : Bukkit.getOnlinePlayers()) if (isBot(p)) applyTo(p);
    }

    private void startApi() {
        var c = getConfig();
        if (!c.getBoolean("http.enabled", true)) return;
        String token = c.getString("http.token", "");
        if (token == null || token.isBlank()) {
            byte[] bytes = new byte[24];
            new SecureRandom().nextBytes(bytes);
            token = HexFormat.of().formatHex(bytes);
            c.set("http.token", token);
            saveConfig();
        }
        try {
            // El panel lee la clave de aquí (mismo PC)
            Files.writeString(getDataFolder().toPath().resolve("token.txt"), token, StandardCharsets.UTF_8);
            api = new PanelApi(this, c.getInt("http.port", 8200), token);
            api.start();
            getLogger().info("Conexión con el panel en http://127.0.0.1:" + c.getInt("http.port", 8200));
        } catch (IOException e) {
            getLogger().warning("No pude abrir la conexión con el panel: " + e.getMessage());
        }
    }

    private void stopApi() {
        if (api != null) api.stop();
        api = null;
    }

    DebugLog debug() {
        return debug;
    }

    BotAssist assist() {
        return assist;
    }

    MapMarkers markers() {
        return markers;
    }

    public boolean isBot(Player p) {
        String name = p.getName();
        return bots.contains(name.toLowerCase(Locale.ROOT)) || (!prefix.isEmpty() && name.startsWith(prefix));
    }

    private void applyTo(Player p) {
        if (noMobSpawning) p.setAffectsSpawning(false);
        if (ignoreSleep) p.setSleepingIgnored(true);
        applyViewDistance(p, p.getClientViewDistance());
    }

    /**
     * La distancia de visión que pide el cliente solo limita lo que el servidor le ENVÍA: Paper carga igualmente
     * view-distance (server.properties) alrededor de cada jugador. Con 6 bots eran ~3.500 chunks cargados para
     * nada; con la distancia que pide cada bot (config.js del panel) son unos 700.
     */
    private void applyViewDistance(Player p, int requested) {
        if (!botViewDistance || requested <= 0 || !p.isOnline()) return;
        int vd = Math.max(2, Math.min(requested, Bukkit.getViewDistance()));
        try {
            if (p.getViewDistance() != vd) p.setViewDistance(vd);
        } catch (Throwable t) {
            getLogger().warning("No pude fijar la distancia de visión de " + p.getName() + ": " + t);
        }
    }

    // ── Eventos ──────────────────────────────────────────────

    @EventHandler
    public void onJoin(PlayerJoinEvent e) {
        Player p = e.getPlayer();
        if (isBot(p)) Bukkit.getScheduler().runTask(this, () -> { if (p.isOnline()) applyTo(p); });
    }

    // Si el bot cambia su distancia de visión (al reconectar con otro valor), seguirla
    @EventHandler
    public void onClientOptions(PlayerClientOptionsChangeEvent e) {
        Player p = e.getPlayer();
        if (!isBot(p) || !e.hasViewDistanceChanged()) return;
        int requested = e.getViewDistance();
        Bukkit.getScheduler().runTask(this, () -> applyViewDistance(p, requested));
    }

    @EventHandler(priority = EventPriority.HIGH, ignoreCancelled = true)
    public void onDamage(EntityDamageEvent e) {
        if (!(e.getEntity() instanceof Player p) || !isBot(p)) return;
        switch (e.getCause()) {
            case FALL -> { if (noFallDamage) e.setCancelled(true); return; }
            // Efectos que dejan los monstruos (araña de cueva, bruja, esqueleto wither)
            case POISON, WITHER -> { if (noMonsterDamage) e.setCancelled(true); return; }
            default -> { }
        }
        if (noMonsterDamage && e instanceof EntityDamageByEntityEvent byEntity && isMonster(byEntity.getDamager())) {
            e.setCancelled(true);
        }
    }

    @EventHandler(ignoreCancelled = true)
    public void onTarget(EntityTargetLivingEntityEvent e) {
        if (noMonsterTarget && e.getTarget() instanceof Player p && isBot(p) && e.getEntity() instanceof Enemy) {
            e.setCancelled(true);
        }
    }

    /** Lo pescado por un bot se lleva a sus pies (en el siguiente tick, cuando ya salió del agua). */
    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onFish(PlayerFishEvent e) {
        if (!deliverCatch || e.getState() != PlayerFishEvent.State.CAUGHT_FISH || !isBot(e.getPlayer())) return;
        if (!(e.getCaught() instanceof Item item)) return;
        Player p = e.getPlayer();
        Bukkit.getScheduler().runTask(this, () -> {
            if (!item.isValid() || !p.isOnline()) return;
            item.teleport(p.getLocation());
            item.setVelocity(new Vector());
            item.setPickupDelay(0);
        });
    }

    /** Un monstruo, o algo lanzado por un monstruo (flecha, bola de fuego, poción…). */
    private static boolean isMonster(Entity damager) {
        if (damager instanceof Enemy) return true;
        if (damager instanceof Projectile proj) {
            ProjectileSource shooter = proj.getShooter();
            return shooter instanceof Enemy;
        }
        return false;
    }

    // ── /bothelper ───────────────────────────────────────────

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (args.length > 1 && args[0].equalsIgnoreCase("debug")) {
            boolean on = args[1].equalsIgnoreCase("on");
            debug.setEnabled(on);
            sender.sendMessage("BotHelper: registro de diagnóstico " + (on ? "activado" : "desactivado") + ".");
            return true;
        }
        if (args.length > 0 && args[0].equalsIgnoreCase("reload")) {
            stopApi();
            loadSettings();
            if (assist != null) assist.reload();
            if (cleanup != null) cleanup.reload();
            startApi();
            sender.sendMessage("BotHelper recargado.");
            return true;
        }
        long online = Bukkit.getOnlinePlayers().stream().filter(this::isBot).count();
        sender.sendMessage("BotHelper: " + online + " bots conectados · sin spawns " + onOff(noMobSpawning)
            + " · ignoran el sueño " + onOff(ignoreSleep) + " · protección " + onOff(noMonsterDamage || noFallDamage)
            + " · distancia por bot " + onOff(botViewDistance) + " · limpieza " + onOff(getConfig().getBoolean("cleanup.enabled", true))
            + " · panel " + (api != null ? "conectado" : "apagado") + " · diagnóstico " + onOff(debug.isEnabled()));
        return true;
    }

    private static String onOff(boolean b) {
        return b ? "sí" : "no";
    }
}
