// Transport test page for the Pulse plugin: raw request envelopes in, reply and event envelopes
// shown as they come back (native-bridge.md §2). One file for iOS and Android. It also runs in the
// Cordova host: cordova-host/www/host.js is an earlier copy of this file, without the test-server
// host services, the open/close ×10 run and the deep-link queue.
(function () {
  'use strict';

  var out = document.getElementById('log');
  var transport = null;

  /** Capability tokens cross the page in replies and host requests: log 6 characters of each. */
  function shortToken(token) {
    return typeof token === 'string' ? token.slice(0, 6) + '…' : token;
  }
  function redact(text) {
    // Also inside JSON carried as a string (a reply's `json`), where the quotes are escaped.
    return String(text).replace(/(\\?"token\\?"\s*:\s*\\?")([^"\\]*)/g, function (_, a, t) {
      return a + shortToken(t);
    });
  }

  function log(line) {
    line = redact(line);
    console.log('[host] ' + line);
    out.textContent = line + '\n' + out.textContent;
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /** localStorage can throw (private mode, blocked storage): the page works without it. */
  function stored(key, fallback) {
    try {
      var value = window.localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (e) {
      return fallback;
    }
  }
  function store(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      /* not kept */
    }
  }

  window.onerror = function (message, source, line) {
    log('JS ERROR ' + message + ' @' + line);
  };

  function callId() {
    var hex = '';
    for (var i = 0; i < 12; i++) hex += Math.floor(Math.random() * 16).toString(16);
    return 'c-' + hex;
  }

  // Capacitor: the plugin's own JS surface, through the global (no @capacitor/core import).
  function capacitorTransport() {
    var cap = window.Capacitor;
    if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
    if (cap.isPluginAvailable && !cap.isPluginAvailable('Pulse')) return null;
    var plugin = cap.registerPlugin ? cap.registerPlugin('Pulse') : cap.Plugins.Pulse;
    return {
      name: 'Capacitor',
      call: function (json) {
        return plugin.call({ json: json }).then(function (r) {
          return r.json;
        });
      },
      subscribe: function (cb) {
        plugin.addListener('event', function (e) {
          cb(e.json);
        });
      },
    };
  }

  // Cordova: window.PulseKit, from cordova-plugin-pulse's www/pulse.js.
  function cordovaTransport() {
    if (!window.cordova || !window.PulseKit) return null;
    return { name: 'Cordova', call: window.PulseKit.call, subscribe: window.PulseKit.subscribe };
  }

  function send(method, args) {
    if (!transport) {
      log('no Pulse plugin');
      return null;
    }
    var request = JSON.stringify({
      v: 1,
      callId: callId(),
      method: method,
      args: args || {},
      client: { contract: { major: 1, minor: 1 }, version: 'host-test' },
    });
    var t0 = Date.now();
    log('→ ' + request);
    return transport.call(request).then(
      function (reply) {
        log('← ' + (Date.now() - t0) + ' ms ' + reply);
        return JSON.parse(reply);
      },
      function (err) {
        log('✗ transport ' + (err && err.message ? err.message : String(err)));
      },
    );
  }

  var context = { key: 'host:test', kind: 'host', id: 'test', label: 'Host test' };

  // ─── Flows and the navigation queue ─────────────────────────────────────────────────────────
  // A host navigates only when Pulse is closed: a deep link (or a push tap) that arrives while a
  // flow is open is queued, and runs after the flow's result. Here "navigating" is a log line.

  var openFlows = 0;
  var navQueue = [];

  function navigate(url, how) {
    log('🧭 navigated ' + how + ': ' + url);
  }

  function drainNavigation(why) {
    if (openFlows > 0 || !navQueue.length) return;
    var queued = navQueue;
    navQueue = [];
    queued.forEach(function (url) {
      navigate(url, 'after ' + why);
    });
  }

  /** Opens a record flow; resolves to the open reply (the FlowResult) when the flow ends. */
  function openRecord() {
    var pending = send('open', { entry: 'record', requestId: 'r-' + Date.now(), context: context });
    if (!pending) return null;
    openFlows++;
    return pending.then(
      function (reply) {
        openFlows--;
        drainNavigation('the flow result');
        return reply;
      },
      function () {
        openFlows--;
        drainNavigation('a failed open');
        return null;
      },
    );
  }

  /** A deep link: queued while a flow is open (this page's own, or one isOpen reports). */
  function onDeepLink(url) {
    log('🔗 deep link ' + url + (openFlows > 0 ? ' (a flow is open)' : ''));
    if (openFlows > 0) {
      navQueue.push(url);
      log('🔗 queued (' + navQueue.length + ' waiting)');
      return;
    }
    var asked = send('isOpen');
    if (!asked) return navigate(url, 'at once');
    asked.then(function (reply) {
      if (reply && reply.ok && reply.result === true) {
        navQueue.push(url);
        log('🔗 queued: isOpen is true (' + navQueue.length + ' waiting)');
      } else {
        navigate(url, 'at once');
      }
    });
  }

  // ─── Host services backed by the PulseVault test server ─────────────────────────────────────
  // scripts/pv-test-server.mjs: GET /pair mints an artifact and a pairing link, GET /token mints a
  // 2 h token for one. Pulse uploads natively to `endpoint`; only /pair and /token are fetched here.

  var serverInput = document.getElementById('server');
  var hostServicesButton = document.querySelector('button[data-action="hostServices"]');
  var hostServicesOn = stored('pulse.host.hostServices', 'off') === 'on';
  serverInput.value = stored('pulse.host.server', 'http://127.0.0.1:8787');
  serverInput.addEventListener('change', function () {
    store('pulse.host.server', serverInput.value.trim());
    log('test server ' + serverBase());
  });

  function showHostServices() {
    hostServicesButton.textContent =
      'Host services: test server ' + (hostServicesOn ? 'on' : 'off');
  }

  function serverBase() {
    return serverInput.value.trim().replace(/\/+$/, '');
  }

  function getJson(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + url);
      return r.json();
    });
  }

  /** The pairing link's query: `pulsecam://?v=…&artifactId=…&server=…&token=…`. */
  function linkParams(link) {
    var q = String(link).indexOf('?');
    if (q < 0) throw new Error('pairing link without a query: ' + link);
    return new URLSearchParams(String(link).slice(q + 1));
  }

  function mintToken(artifactId) {
    return getJson(serverBase() + '/token?artifactId=' + encodeURIComponent(artifactId)).then(
      function (t) {
        if (!t || typeof t.token !== 'string' || typeof t.expiresAt !== 'number') {
          throw new Error('/token answered without token/expiresAt');
        }
        return { token: t.token, expiresAt: t.expiresAt };
      },
    );
  }

  var hostHandlers = {
    getUploadTarget: function (args) {
      return getJson(serverBase() + '/pair').then(function (pair) {
        var params = linkParams(pair && pair.link);
        var artifactId = params.get('artifactId');
        var server = params.get('server');
        if (!artifactId || !server) throw new Error('pairing link without artifactId/server');
        // The link names the server as the test server sees itself (127.0.0.1): keep its path,
        // and reach it through the address this page uses (adb reverse, a LAN IP or a proxy).
        var endpoint = serverBase() + new URL(server).pathname.replace(/\/+$/, '');
        // /pair's own token lasts 10 min; /token's lasts 2 h, so ask for one of those.
        return mintToken(artifactId).then(function (t) {
          return {
            uploadId: artifactId,
            endpoint: endpoint,
            artifactId: artifactId,
            token: t.token,
            expiresAt: t.expiresAt,
            clientKey: args.clientKey,
          };
        });
      });
    },
    refreshUploadToken: function (args) {
      // uploadId is the artifactId (getUploadTarget above).
      return mintToken(args.uploadId);
    },
    releaseUploadTarget: function () {
      return Promise.resolve(null);
    },
    // Only a type with confirmSend asks this; the host test types have none, but answer it so a
    // clock-style type can be tried here too.
    confirmSend: function () {
      return Promise.resolve({ confirmedAt: Date.now() });
    },
  };

  function answerHostRequest(payload) {
    var handler = hostHandlers[payload.method];
    log('🛎 ' + payload.method + ' ' + payload.hostCallId + ' ' + JSON.stringify(payload.args));
    var work = handler
      ? Promise.resolve().then(function () {
          return handler(payload.args || {});
        })
      : Promise.reject(new Error('no handler for ' + payload.method));
    work
      .then(
        function (result) {
          log('🛎 ' + payload.method + ' → ' + JSON.stringify(result));
          return { hostCallId: payload.hostCallId, result: result === undefined ? null : result };
        },
        function (err) {
          var message = err && err.message ? err.message : String(err);
          log('🛎 ' + payload.method + ' ✗ host.unavailable: ' + message);
          return {
            hostCallId: payload.hostCallId,
            error: { code: 'host.unavailable', message: message },
          };
        },
      )
      .then(function (args) {
        send('respondHostRequest', args);
      });
  }

  function onEvent(json) {
    log('⚡ ' + json);
    var event;
    try {
      event = JSON.parse(json);
    } catch (e) {
      return;
    }
    if (!event || typeof event !== 'object') return;
    if (event.name === 'hostRequest' && event.payload && hostServicesOn) {
      answerHostRequest(event.payload);
    }
    // A result for a flow this page didn't open (e.g. one opened before a reload).
    if (event.name === 'flowResult') drainNavigation('a flowResult event');
  }

  // ─── Open/close ×10 ────────────────────────────────────────────────────────────────────────

  var multiRunning = false;

  function openCloseTimes(rounds) {
    if (multiRunning) return log('×10 already running');
    if (!transport) return log('no Pulse plugin');
    multiRunning = true;
    var statuses = {};
    function round(n) {
      if (n > rounds) {
        multiRunning = false;
        log('×' + rounds + ' done: ' + JSON.stringify(statuses));
        return;
      }
      var t0 = Date.now();
      var ended = false;
      log('×' + rounds + ' round ' + n + ': open');
      var flow = openRecord();
      flow.then(function () {
        ended = true;
      });
      delay(3000)
        .then(function () {
          if (ended) return null;
          log('×' + rounds + ' round ' + n + ': close');
          return send('close', { reason: 'host' });
        })
        .then(function () {
          return flow;
        })
        .then(function (reply) {
          var status =
            reply && reply.ok && reply.result
              ? reply.result.status
              : 'error ' + (reply && reply.error ? reply.error.code : 'transport');
          statuses[status] = (statuses[status] || 0) + 1;
          log('×' + rounds + ' round ' + n + ': ' + status + ' in ' + (Date.now() - t0) + ' ms');
          // Let the dismissal finish, so the next open isn't refused as busy.
          return delay(1000);
        })
        .then(function () {
          round(n + 1);
        });
    }
    round(1);
  }

  // ─── The App plugin (@capacitor/app): deep links and restored results ──────────────────────

  function appPlugin() {
    var cap = window.Capacitor;
    if (!cap || !cap.isPluginAvailable || !cap.isPluginAvailable('App')) return null;
    return cap.registerPlugin ? cap.registerPlugin('App') : cap.Plugins.App;
  }

  function listenToApp() {
    var app = appPlugin();
    if (!app) return log('no App plugin: deep links and appRestoredResult are not logged');
    app.addListener('appUrlOpen', function (e) {
      onDeepLink(e && e.url);
    });
    // Android: the Activity was recreated and a plugin call's result arrived for the old one.
    app.addListener('appRestoredResult', function (e) {
      log('♻️ appRestoredResult ' + JSON.stringify(e));
      drainNavigation('appRestoredResult');
    });
    app.getLaunchUrl().then(
      function (r) {
        if (r && r.url) log('🔗 launch url ' + r.url);
      },
      function () {},
    );
    log('App plugin: listening for deep links and appRestoredResult');
  }

  /** Opens a record flow, then sends the app a caphost:// link while it is open. */
  function deepLinkDuringTake() {
    if (!openRecord()) return;
    var url = 'caphost://nav?to=during-take-' + Date.now();
    delay(3000).then(function () {
      log(
        '🔗 sending ' + url + (openFlows > 0 ? ' (a flow is open)' : ' (the flow already ended)'),
      );
      // The WebView hands a non-web URL to the OS, which delivers it back to this app's
      // caphost:// intent filter (Android) or URL scheme (iOS) as appUrlOpen.
      window.location.href = url;
    });
  }

  /** Calls `then` with the newest draft listDrafts returns, if there is one. */
  function withFirstDraft(then) {
    var listed = send('listDrafts');
    if (!listed) return;
    listed.then(function (reply) {
      var first = reply && reply.ok && reply.result && reply.result[0];
      if (first) then(first);
      else log('no draft to use: record one first');
    });
  }
  var actions = {
    info: function () {
      send('info');
    },
    configure: function () {
      send('configure', { hostName: 'Host test', uploadMode: 'file' });
    },
    prewarm: function () {
      send('prewarm');
    },
    record: function () {
      openRecord();
    },
    isOpen: function () {
      send('isOpen');
    },
    close: function () {
      send('close', { reason: 'host' });
    },
    pending: function () {
      send('pendingResults');
    },
    ackAll: function () {
      var pending = send('pendingResults');
      if (!pending) return;
      pending.then(function (reply) {
        (reply && reply.ok ? reply.result : []).forEach(function (r) {
          send('acknowledge', { requestId: r.requestId });
        });
      });
    },
    logFile: function () {
      send('logFile');
    },
    unknown: function () {
      send('noSuchMethod');
    },
    configurePulse: function () {
      send('configure', { hostName: 'Host test', uploadMode: 'pulse' });
    },
    // The data API (contract minor 1). The writes run in Pulse JS: with nothing presented in a
    // build whose `headless` flag is on, else under PulseKit's brief "Preparing…".
    setAccount: function () {
      send('setAccount', { serverOrigin: 'https://host.test', userId: 'host-test' });
    },
    listDrafts: function () {
      send('listDrafts');
    },
    renameFirst: function () {
      withFirstDraft(function (d) {
        send('renameDraft', { id: d.id, name: 'Renamed ' + new Date().toLocaleTimeString() });
      });
    },
    sendFirst: function () {
      withFirstDraft(function (d) {
        send('upload', { id: d.id });
      });
    },
    deleteFirst: function () {
      withFirstDraft(function (d) {
        send('deleteDraft', { id: d.id });
      });
    },
    resumeOutbox: function () {
      send('resumeOutbox');
    },
    reload: function () {
      location.reload();
    },
    hostServices: function () {
      hostServicesOn = !hostServicesOn;
      store('pulse.host.hostServices', hostServicesOn ? 'on' : 'off');
      showHostServices();
      log('host services: test server ' + (hostServicesOn ? 'on (' + serverBase() + ')' : 'off'));
    },
    checkServer: function () {
      var base = serverBase();
      getJson(base + '/pair').then(
        function (pair) {
          var params = linkParams(pair && pair.link);
          log('test server ' + base + ' answers: artifactId ' + params.get('artifactId'));
        },
        function (err) {
          log('✗ test server ' + base + ': ' + (err && err.message ? err.message : String(err)));
        },
      );
    },
    openClose10: function () {
      openCloseTimes(10);
    },
    deepLinkDuringTake: function () {
      deepLinkDuringTake();
    },
  };
  showHostServices();

  Array.prototype.forEach.call(document.querySelectorAll('button[data-action]'), function (b) {
    b.addEventListener('click', actions[b.getAttribute('data-action')]);
  });

  function ready() {
    transport = capacitorTransport() || cordovaTransport();
    document.getElementById('title').textContent = transport
      ? transport.name + ' host'
      : 'No Pulse plugin';
    listenToApp();
    if (!transport) return log('no Pulse plugin in this WebView');
    transport.subscribe(onEvent);
    log('ready (' + transport.name + ')');
    if (hostServicesOn) log('host services: test server on (' + serverBase() + ')');
    send('info');
  }

  // Capacitor may define window.cordova too (its Cordova compatibility layer), so ask it first.
  var cap = window.Capacitor;
  if (cap && cap.isNativePlatform && cap.isNativePlatform()) ready();
  else if (window.cordova) document.addEventListener('deviceready', ready);
  else ready();
})();
