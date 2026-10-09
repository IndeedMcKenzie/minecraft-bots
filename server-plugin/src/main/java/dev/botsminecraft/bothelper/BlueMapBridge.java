package dev.botsminecraft.bothelper;

import com.flowpowered.math.vector.Vector3d;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import de.bluecolored.bluemap.api.BlueMapAPI;
import de.bluecolored.bluemap.api.BlueMapMap;
import de.bluecolored.bluemap.api.markers.LineMarker;
import de.bluecolored.bluemap.api.markers.MarkerSet;
import de.bluecolored.bluemap.api.markers.POIMarker;
import de.bluecolored.bluemap.api.markers.ShapeMarker;
import de.bluecolored.bluemap.api.math.Color;
import de.bluecolored.bluemap.api.math.Line;
import de.bluecolored.bluemap.api.math.Shape;
import org.bukkit.Bukkit;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/**
 * La parte de {@link MapMarkers} que usa la API de BlueMap (solo se carga si BlueMap está instalado).
 * Dos capas que se pueden ocultar desde el menú de BlueMap: "Recorridos de los bots" y "Casas y zonas de los bots".
 * BlueMap guarda las capas en memoria: al recargar BlueMap (onEnable de nuevo) se vuelven a dibujar.
 */
final class BlueMapBridge {
    private static final String TRAILS = "bothelper-recorridos";
    private static final String PLACES = "bothelper-zonas";

    private final BotHelper plugin;
    private final Consumer<BlueMapAPI> onEnable = api -> { this.api = api; apply(); };
    private final Consumer<BlueMapAPI> onDisable = api -> this.api = null;
    private volatile BlueMapAPI api;
    private volatile JsonObject last;

    BlueMapBridge(BotHelper plugin) {
        this.plugin = plugin;
    }

    void start() {
        BlueMapAPI.onEnable(onEnable);
        BlueMapAPI.onDisable(onDisable);
    }

    void stop() {
        BlueMapAPI.unregisterListener(onEnable);
        BlueMapAPI.unregisterListener(onDisable);
        BlueMapAPI a = api;
        if (a != null) for (BlueMapMap map : a.getMaps()) {
            map.getMarkerSets().remove(TRAILS);
            map.getMarkerSets().remove(PLACES);
        }
    }

    boolean ready() {
        return api != null;
    }

    void update(JsonObject body) {
        last = body;
        apply();
    }

    private synchronized void apply() {
        BlueMapAPI a = api;
        JsonObject body = last;
        if (a == null || body == null || !body.has("bots")) return;
        try {
            MarkerSet trails = MarkerSet.builder().label("Recorridos de los bots (última hora)").toggleable(true).defaultHidden(false).build();
            MarkerSet places = MarkerSet.builder().label("Casas y zonas de los bots").toggleable(true).defaultHidden(false).build();
            for (JsonElement e : body.getAsJsonArray("bots")) {
                JsonObject b = e.getAsJsonObject();
                String key = b.get("key").getAsString();
                String label = b.get("label").getAsString();
                int[] rgb = rgb(b.has("color") ? b.get("color").getAsString() : "#3987e5");

                if (b.has("trail") && b.get("trail").isJsonArray()) {
                    List<Vector3d> points = new ArrayList<>();
                    for (JsonElement p : b.getAsJsonArray("trail")) {
                        JsonArray xyz = p.getAsJsonArray();
                        points.add(new Vector3d(xyz.get(0).getAsDouble() + 0.5, xyz.get(1).getAsDouble() + 0.5, xyz.get(2).getAsDouble() + 0.5));
                    }
                    if (points.size() >= 2) {
                        trails.put("trail-" + key, LineMarker.builder()
                            .label("Recorrido de " + label)
                            .line(new Line(points.toArray(new Vector3d[0])))
                            .centerPosition()
                            .lineWidth(3)
                            .depthTestEnabled(false)
                            .lineColor(new Color(rgb[0], rgb[1], rgb[2], 0.9f))
                            .build());
                    }
                }
                if (b.has("home") && b.get("home").isJsonArray()) {
                    JsonArray h = b.getAsJsonArray("home");
                    places.put("home-" + key, POIMarker.builder()
                        .label("Casa de " + label)
                        .position(h.get(0).getAsDouble() + 0.5, h.get(1).getAsDouble() + 1, h.get(2).getAsDouble() + 0.5)
                        .build());
                }
                if (b.has("zone") && b.get("zone").isJsonObject()) {
                    JsonObject z = b.getAsJsonObject("zone");
                    double x = z.get("x").getAsDouble() + 0.5, y = z.get("y").getAsDouble(), zz = z.get("z").getAsDouble() + 0.5;
                    double r = z.get("radius").getAsDouble();
                    places.put("zone-" + key, ShapeMarker.builder()
                        .label("Zona de trabajo de " + label + " (radio " + (int) r + ")")
                        .shape(Shape.createCircle(x, zz, r, 48), (float) y)
                        .centerPosition()
                        .lineWidth(2)
                        .depthTestEnabled(false)
                        .lineColor(new Color(rgb[0], rgb[1], rgb[2], 1f))
                        .fillColor(new Color(rgb[0], rgb[1], rgb[2], 0.15f))
                        .build());
                }
            }
            // Los bots trabajan en el mundo principal
            a.getWorld(Bukkit.getWorlds().get(0)).ifPresent(world -> {
                for (BlueMapMap map : world.getMaps()) {
                    map.getMarkerSets().put(TRAILS, trails);
                    map.getMarkerSets().put(PLACES, places);
                }
            });
        } catch (Throwable t) {
            plugin.getLogger().warning("No se pudo dibujar en BlueMap: " + t);
        }
    }

    private static int[] rgb(String hex) {
        try {
            int v = Integer.parseInt(hex.replace("#", ""), 16);
            return new int[] { (v >> 16) & 255, (v >> 8) & 255, v & 255 };
        } catch (NumberFormatException e) {
            return new int[] { 57, 135, 229 };
        }
    }
}
