package com.mieweb.pulse.capacitor;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The Android side of @mieweb/capacitor-pulse until Pulse runs on Android (AD20, native-bridge.md
 * §9): the same JS surface as iOS, {@code call({ json })} resolving {@code { json }}, answered by
 * {@link PulseUnsupported}. It sends no events, so an {@code addListener('event')} stays quiet.
 */
@CapacitorPlugin(name = "Pulse")
public class PulsePlugin extends Plugin {
    @PluginMethod
    public void call(PluginCall call) {
        String json = call.getString("json");
        if (json == null) {
            call.reject("Pulse.call needs { json: string }.");
            return;
        }
        JSObject reply = new JSObject();
        reply.put("json", PulseUnsupported.reply(json));
        call.resolve(reply);
    }
}
