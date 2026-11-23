package com.mieweb.pulse.cordova;

import android.os.Build;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Pulse doesn't run on Android yet (AD20), so this answers every request envelope here, the way
 * PulseKit's router answers one it can't serve (native-bridge.md §2, §9): {@code info} says
 * {@code supported: false}, and every other method is a resolved {@code ok: false} reply with
 * code {@code unsupported}. A host then shows its link or QR fallback.
 *
 * <p>The Capacitor plugin and the Cordova plugin each carry a copy of this class.
 */
final class PulseUnsupported {
    private static final int ENVELOPE_VERSION = 1;
    private static final int CONTRACT_MAJOR = 1;

    private PulseUnsupported() {}

    /** One request envelope in, one reply envelope out. Never throws. */
    static String reply(String requestJson) {
        JSONObject request;
        try {
            request = new JSONObject(requestJson);
        } catch (JSONException | NullPointerException e) {
            return failure("", "invalid_options", "The request isn't a JSON object.");
        }
        String callId = string(request, "callId");
        if (callId == null || callId.isEmpty()) {
            return failure("", "invalid_options", "The request has no callId.");
        }
        if (request.optInt("v", -1) != ENVELOPE_VERSION) {
            return failure(callId, "contract.unsupported", "Only envelope version 1 is spoken here.");
        }
        JSONObject client = request.optJSONObject("client");
        JSONObject contract = client == null ? null : client.optJSONObject("contract");
        if (contract != null && contract.optInt("major", -1) != CONTRACT_MAJOR) {
            return failure(callId, "contract.unsupported", "Only contract major 1 is spoken here.");
        }
        if ("info".equals(string(request, "method"))) {
            return success(callId, info());
        }
        return failure(callId, "unsupported", "Pulse doesn't run on Android yet.");
    }

    /** {@code PulseInfo} for a platform Pulse can't run on: nothing to open, only info. */
    static JSONObject info() {
        try {
            JSONObject contract = new JSONObject().put("major", CONTRACT_MAJOR).put("minor", 0);
            return new JSONObject()
                    .put("sdkVersion", "0.0.0")
                    .put("build", "0")
                    .put("gitSha", "unknown")
                    .put("contract", contract)
                    .put("formatVersion", 0)
                    .put("dbSchema", 0)
                    .put("entries", new JSONArray())
                    .put("methods", new JSONArray().put("info"))
                    .put("capabilities", new JSONArray())
                    .put("platform", "android")
                    .put("osVersion", Build.VERSION.RELEASE == null ? "" : Build.VERSION.RELEASE)
                    .put("supported", false)
                    .put("unsupportedReason", "device")
                    .put("namespace", JSONObject.NULL);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String success(String callId, Object result) {
        try {
            return new JSONObject()
                    .put("v", ENVELOPE_VERSION)
                    .put("callId", callId)
                    .put("ok", true)
                    .put("result", result)
                    .toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String failure(String callId, String code, String message) {
        try {
            JSONObject error = new JSONObject()
                    .put("code", code)
                    .put("message", message)
                    .put("recoverable", false)
                    .put("callId", callId);
            return new JSONObject()
                    .put("v", ENVELOPE_VERSION)
                    .put("callId", callId)
                    .put("ok", false)
                    .put("error", error)
                    .toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /** The field when it is a JSON string; {@code optString} would turn null into "null". */
    private static String string(JSONObject o, String key) {
        Object value = o.opt(key);
        return value instanceof String ? (String) value : null;
    }
}
