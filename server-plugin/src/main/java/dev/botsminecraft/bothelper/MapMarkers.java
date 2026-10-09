package dev.botsminecraft.bothelper;

import com.google.gson.JsonObject;
import org.bukkit.Bukkit;

/**
 * Dibuja en BlueMap lo que manda el panel (POST /markers): el recorrido de cada bot en la última hora, su casa y su
 * zona de trabajo. BlueMap es opcional: todo lo que usa su API está en {@link BlueMapBridge}, que solo se carga si el
 * plugin BlueMap está instalado; si no, /markers responde que no hay mapa y el resto de BotHelper sigue igual.
 */
final class MapMarkers {
    private final BotHelper plugin;
    private Object bridge; // BlueMapBridge (Object para no cargar sus clases sin BlueMap)

    MapMarkers(BotHelper plugin) {
        this.plugin = plugin;
    }

    void start() {
        if (Bukkit.getPluginManager().getPlugin("BlueMap") == null) return;
        try {
            BlueMapBridge b = new BlueMapBridge(plugin);
            b.start();
            bridge = b;
        } catch (Throwable t) {
            plugin.getLogger().warning("No se pudo conectar con BlueMap (sin recorridos en el mapa): " + t);
        }
    }

    void stop() {
        if (bridge != null) {
            try { ((BlueMapBridge) bridge).stop(); } catch (Throwable ignored) { }
        }
    }

    boolean available() {
        return bridge != null && ((BlueMapBridge) bridge).ready();
    }

    /** Sustituye lo dibujado por lo de este mensaje. Devuelve false si no hay BlueMap. */
    boolean update(JsonObject body) {
        if (bridge == null) return false;
        ((BlueMapBridge) bridge).update(body);
        return true;
    }
}
