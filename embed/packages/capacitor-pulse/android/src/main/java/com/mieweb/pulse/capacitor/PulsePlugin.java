package com.mieweb.pulse.capacitor;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.mieweb.pulse.kit.PulseKit;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Collections;
import java.util.Set;
import java.util.WeakHashMap;

/**
 * Capacitor transport for PulseKit on Android (native-bridge.md §7.1). It mirrors the iOS plugin
 * (ios/Sources/PulsePlugin/PulsePlugin.swift) and holds no Pulse logic:
 *
 * <ul>
 *   <li>{@code call({ json })} passes one request envelope to PulseKit and resolves {@code { json
 *       }} with the reply envelope. The JSON stays a string, so Capacitor's value bridging can't
 *       change numbers or nulls, and a request's {@code timeoutMs} (contract 1.1) reaches PulseKit
 *       as the client wrote it. A Pulse error is a resolved reply with {@code ok: false}; the
 *       promise rejects only when the call has no {@code json} string.
 *   <li>{@code addListener('event', cb)} delivers {@code { json }} event envelopes. {@code
 *       flowResult} and {@code hostRequest} wait for a listener ({@code retainUntilConsumed}), so a
 *       page that reloads still gets them; the others don't, because the client re-reads the
 *       catalog after it subscribes.
 *   <li>{@code open} replies when the flow ends, minutes later, so its call stays saved until
 *       then.
 * </ul>
 *
 * <p>Where Android differs (PR4-SPEC "Android differences"): {@code open} starts {@code
 * PulseActivity} through Capacitor's {@link #startActivityForResult}, so the flow's result reaches
 * the page by one of two paths, whichever comes first: PulseKit's reply, or the Activity result's
 * {@code json} extra ({@link #pulseResult}). When the system destroyed the host Activity during
 * the flow, Capacitor recreates this plugin and hands the result to a restored call, which it sends
 * to the page as {@code appRestoredResult} ({@code @capacitor/app}). The result is also in
 * PulseKit's inbox ({@code pendingResults}), which stays the contract. When this plugin's Activity
 * is destroyed it lets go of PulseKit's event listener, so PulseKit keeps {@code flowResult} and
 * {@code hostRequest} for the next instance.
 *
 * <p>If PulseKit's classes are missing at run time (a build that left the AAR out), every call is
 * answered by {@link PulseUnsupported} instead of crashing, as the stub answers.
 */
@CapacitorPlugin(name = "Pulse")
public class PulsePlugin extends Plugin {
    private static final String TAG = "Pulse";

    /** {@code PulseActivity.RESULT_EXTRA_JSON} (PR4-SPEC "Frozen names"): the reply envelope. */
    private static final String RESULT_EXTRA_JSON = "json";

    /** The {@code @ActivityCallback} method {@code open}'s Activity result goes to. */
    private static final String RESULT_CALLBACK = "pulseResult";

    /** The plugin instance PulseKit's event listener points at, if any. */
    private static PulsePlugin listening;

    /**
     * The {@code open} calls already resolved, so PulseKit's reply and the Activity result resolve
     * each call exactly once. Weak and by identity: Capacitor hands both paths the same {@link
     * PluginCall}, and a resolved call is released and collected.
     */
    private final Set<PluginCall> settled = Collections.newSetFromMap(new WeakHashMap<>());

    private boolean linked;

    @Override
    public void load() {
        linked = PulseKitLink.listen(getContext(), this::forward);
        if (linked) {
            synchronized (PulsePlugin.class) {
                listening = this;
            }
        } else {
            Logger.error(TAG, PulseKitLink.MISSING + " Every call is answered as unsupported.", null);
        }
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (PulsePlugin.class) {
            if (listening != this) return;
            listening = null;
        }
        PulseKitLink.stopListening(getContext());
    }

    @PluginMethod
    public void call(PluginCall call) {
        String json = call.getString("json");
        if (json == null) {
            call.reject("Pulse.call needs { json: string }.");
            return;
        }
        if (!linked) {
            resolve(call, PulseUnsupported.reply(json));
            return;
        }
        boolean opens = "open".equals(topLevelString(json, "method"));
        if (opens) {
            call.setKeepAlive(false);
            bridge.saveCall(call);
        }
        bridge.executeOnMainThread(() -> send(call, json, opens));
    }

    /** Runs on the main thread: hands {@code json} to PulseKit. */
    private void send(PluginCall call, String json, boolean opens) {
        Activity activity = getActivity();
        Context context = getContext();
        try {
            if (opens) {
                PulseKitLink.open(
                        activity,
                        context,
                        json,
                        intent -> startActivityForResult(call, intent, RESULT_CALLBACK),
                        reply -> resolveOnce(call, reply));
            } else {
                PulseKitLink.call(activity, context, json, reply -> resolve(call, reply));
            }
        } catch (LinkageError e) {
            Logger.error(TAG, PulseKitLink.MISSING, e);
            if (opens) bridge.releaseCall(call);
            resolveOnce(call, PulseUnsupported.reply(json));
        }
    }

    /**
     * {@code open}'s Activity result. PulseActivity puts the flow's reply envelope in {@link
     * #RESULT_EXTRA_JSON}. When PulseKit's reply already resolved the call, or the result has no
     * envelope (PulseKit then replies), this does nothing. After the host Activity was destroyed,
     * {@code call} is the one Capacitor restored, and resolving it sends {@code appRestoredResult}.
     */
    @ActivityCallback
    private void pulseResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        String json = data == null ? null : data.getStringExtra(RESULT_EXTRA_JSON);
        if (json == null) {
            Logger.debug(TAG, "open's Activity result has no envelope; PulseKit's reply answers.");
            return;
        }
        resolveOnce(call, json);
    }

    /** Resolves an {@code open} call unless it was resolved already. */
    private void resolveOnce(PluginCall call, String reply) {
        synchronized (settled) {
            if (!settled.add(call)) return;
        }
        resolve(call, reply);
    }

    private static void resolve(PluginCall call, String reply) {
        JSObject out = new JSObject();
        out.put("json", reply);
        call.resolve(out);
    }

    private void forward(String json) {
        String name = topLevelString(json, "name");
        boolean retain = "flowResult".equals(name) || "hostRequest".equals(name);
        JSObject data = new JSObject();
        data.put("json", json);
        notifyListeners("event", data, retain);
    }

    /** A top-level string field of a JSON object, or null; the only parsing this plugin does. */
    private static String topLevelString(String json, String key) {
        try {
            Object value = new JSONObject(json).opt(key);
            return value instanceof String ? (String) value : null;
        } catch (JSONException e) {
            return null;
        }
    }

    /** Takes one JSON string: a reply or an event envelope. */
    interface Sink {
        void accept(String json);
    }

    /** Starts PulseActivity for {@code open}. */
    interface Launch {
        void start(Intent intent);
    }

    /**
     * Every reference to PulseKit's classes lives here, so a missing AAR shows up as a {@link
     * LinkageError} from these methods (caught by the plugin), never while loading {@link
     * PulsePlugin} itself. Mirrors the iOS plugin's PulseKitLink.swift.
     */
    static final class PulseKitLink {
        static final String MISSING = "PulseKit isn't in this app's build.";

        private PulseKitLink() {}

        /** Sets PulseKit's event listener; false when PulseKit's classes are missing. */
        static boolean listen(Context context, Sink sink) {
            try {
                PulseKit.shared(context).setEventListener(sink::accept);
                return true;
            } catch (LinkageError e) {
                return false;
            }
        }

        /** Clears PulseKit's event listener, so PulseKit keeps the retained events. */
        static void stopListening(Context context) {
            try {
                PulseKit.shared(context).setEventListener(null);
            } catch (LinkageError e) {
                // PulseKit is missing: it has no listener to clear.
            }
        }

        static void call(Activity activity, Context context, String json, Sink reply) {
            PulseKit.shared(context).call(activity, json, reply::accept);
        }

        static void open(Activity activity, Context context, String json, Launch launch, Sink reply) {
            PulseKit.shared(context)
                    .call(activity, json, (host, intent) -> launch.start(intent), reply::accept);
        }
    }
}
