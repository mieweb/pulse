package com.mieweb.pulse.cordova;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;

/**
 * The Android side of cordova-plugin-pulse until Pulse runs on Android (AD20, native-bridge.md
 * §9): the same actions as iOS, answered by {@link PulseUnsupported}. {@code subscribe} keeps its
 * callback but never sends an event.
 */
public class PulseCordova extends CordovaPlugin {
    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callbackContext) {
        switch (action) {
            case "call": {
                Object json = args.opt(0);
                if (!(json instanceof String)) {
                    callbackContext.error("Pulse.call takes one JSON string.");
                    return true;
                }
                callbackContext.success(PulseUnsupported.reply((String) json));
                return true;
            }
            case "subscribe": {
                PluginResult registered = new PluginResult(PluginResult.Status.NO_RESULT);
                registered.setKeepCallback(true);
                callbackContext.sendPluginResult(registered);
                return true;
            }
            case "unsubscribe":
                callbackContext.success();
                return true;
            default:
                return false;
        }
    }
}
