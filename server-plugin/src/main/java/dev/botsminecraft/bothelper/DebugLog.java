package dev.botsminecraft.bothelper;

import org.bukkit.Location;
import org.bukkit.block.Block;
import org.bukkit.entity.Entity;
import org.bukkit.entity.HumanEntity;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.entity.EntityDamageEvent;
import org.bukkit.event.entity.EntityPickupItemEvent;
import org.bukkit.event.entity.PlayerDeathEvent;
import org.bukkit.event.inventory.CraftItemEvent;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryCloseEvent;
import org.bukkit.event.inventory.InventoryOpenEvent;
import org.bukkit.event.player.PlayerDropItemEvent;
import org.bukkit.event.player.PlayerFishEvent;
import org.bukkit.event.player.PlayerInteractEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.player.PlayerTeleportEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.ItemStack;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Registro de diagnóstico: lo que el servidor ve de verdad que hacen los bots (clics en bloques, ventanas,
 * clics de inventario, crafteos, recogidas, pesca, teletransportes, daño…). Solo en memoria (los últimos
 * MAX_ENTRIES sucesos) y solo cuando está activado (/bothelper debug on). Se consulta desde el panel.
 * Si el bot dice que hizo algo y aquí no aparece, el servidor ni siquiera recibió (o descartó) la acción.
 */
final class DebugLog implements Listener {
    private static final int MAX_ENTRIES = 3000;

    private final BotHelper plugin;
    private final Deque<Map<String, Object>> entries = new ArrayDeque<>();
    private volatile boolean enabled;

    DebugLog(BotHelper plugin, boolean enabled) {
        this.plugin = plugin;
        this.enabled = enabled;
    }

    boolean isEnabled() { return enabled; }

    void setEnabled(boolean on) {
        enabled = on;
        if (!on) synchronized (entries) { entries.clear(); }
    }

    /** Sucesos posteriores a `since` (ms), opcionalmente de un jugador, como mucho `limit` (los más recientes). */
    List<Map<String, Object>> query(long since, String player, int limit) {
        List<Map<String, Object>> out = new ArrayList<>();
        synchronized (entries) {
            for (Map<String, Object> e : entries) {
                if ((long) e.get("t") <= since) continue;
                if (player != null && !player.equalsIgnoreCase((String) e.get("player"))) continue;
                out.add(e);
            }
        }
        return out.size() > limit ? out.subList(out.size() - limit, out.size()) : out;
    }

    private void log(HumanEntity who, String type, Object... kv) {
        if (!enabled || !(who instanceof Player p) || !plugin.isBot(p)) return;
        Map<String, Object> e = new LinkedHashMap<>();
        e.put("t", System.currentTimeMillis());
        e.put("player", p.getName());
        e.put("type", type);
        for (int i = 0; i + 1 < kv.length; i += 2) e.put(String.valueOf(kv[i]), kv[i + 1]);
        synchronized (entries) {
            entries.addLast(e);
            while (entries.size() > MAX_ENTRIES) entries.removeFirst();
        }
    }

    private static String item(ItemStack it) {
        if (it == null || it.getType().isAir()) return null;
        return it.getType().getKey().getKey() + "x" + it.getAmount();
    }

    private static String pos(Location l) {
        return l == null ? null : l.getBlockX() + "," + l.getBlockY() + "," + l.getBlockZ();
    }

    private static String block(Block b) {
        return b == null ? null : b.getType().getKey().getKey() + "@" + pos(b.getLocation());
    }

    private static String inv(Inventory inv) {
        if (inv == null) return null;
        Location l = inv.getLocation();
        return inv.getType().name().toLowerCase() + (l != null ? "@" + pos(l) : "");
    }

    // ── Sucesos (MONITOR: se ve el resultado final, también si otro plugin lo canceló) ──

    @EventHandler(priority = EventPriority.MONITOR)
    public void onInteract(PlayerInteractEvent e) {
        log(e.getPlayer(), "interact", "action", e.getAction().name(), "block", block(e.getClickedBlock()),
            "face", e.getBlockFace() == null ? null : e.getBlockFace().name(), "hand", e.getHand() == null ? null : e.getHand().name(),
            "item", item(e.getItem()), "useBlock", e.useInteractedBlock().name(), "useItem", e.useItemInHand().name());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onOpen(InventoryOpenEvent e) {
        log(e.getPlayer(), "open", "inventory", inv(e.getInventory()), "cancelled", e.isCancelled());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onClose(InventoryCloseEvent e) {
        log(e.getPlayer(), "close", "inventory", inv(e.getInventory()), "reason", e.getReason().name());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onClick(InventoryClickEvent e) {
        log(e.getWhoClicked(), "click", "inventory", inv(e.getInventory()), "slot", e.getRawSlot(), "click", e.getClick().name(),
            "action", e.getAction().name(), "current", item(e.getCurrentItem()), "cursor", item(e.getCursor()),
            "cancelled", e.isCancelled(), "result", e.getResult().name());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onCraft(CraftItemEvent e) {
        log(e.getWhoClicked(), "craft", "result", item(e.getRecipe().getResult()), "click", e.getClick().name(), "cancelled", e.isCancelled());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onPickup(EntityPickupItemEvent e) {
        if (e.getEntity() instanceof Player p) {
            log(p, "pickup", "item", item(e.getItem().getItemStack()), "remaining", e.getRemaining(), "cancelled", e.isCancelled());
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onDrop(PlayerDropItemEvent e) {
        log(e.getPlayer(), "drop", "item", item(e.getItemDrop().getItemStack()), "cancelled", e.isCancelled());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onFish(PlayerFishEvent e) {
        Entity caught = e.getCaught();
        log(e.getPlayer(), "fish", "state", e.getState().name(), "caught", caught == null ? null : caught.getType().getKey().getKey(),
            "hook", pos(e.getHook().getLocation()), "cancelled", e.isCancelled());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onTeleport(PlayerTeleportEvent e) {
        log(e.getPlayer(), "teleport", "cause", e.getCause().name(), "from", pos(e.getFrom()), "to", pos(e.getTo()), "cancelled", e.isCancelled());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onDamage(EntityDamageEvent e) {
        if (e.getEntity() instanceof Player p) {
            log(p, "damage", "cause", e.getCause().name(), "amount", Math.round(e.getDamage() * 10) / 10.0, "cancelled", e.isCancelled());
        }
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onDeath(PlayerDeathEvent e) {
        log(e.getEntity(), "death", "at", pos(e.getEntity().getLocation()));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onJoin(PlayerJoinEvent e) {
        log(e.getPlayer(), "join", "at", pos(e.getPlayer().getLocation()));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onQuit(PlayerQuitEvent e) {
        log(e.getPlayer(), "quit", "reason", e.getReason().name());
    }
}
