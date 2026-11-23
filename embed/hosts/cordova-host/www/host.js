// Transport test page for the Pulse plugin: raw request envelopes in, reply and event envelopes
// shown as they come back (native-bridge.md §2). It runs in the Capacitor host and the Cordova
// host alike; cap-host/www/host.js and cordova-host/www/host.js are identical copies.
(function () {
  'use strict';

  var out = document.getElementById('log');
  var transport = null;

  function log(line) {
    console.log('[host] ' + line);
    out.textContent = line + '\n' + out.textContent;
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
    if (!transport) return log('no Pulse plugin');
    var request = JSON.stringify({
      v: 1,
      callId: callId(),
      method: method,
      args: args || {},
      client: { contract: { major: 1, minor: 0 }, version: 'host-test' },
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
      send('open', { entry: 'record', requestId: 'r-' + Date.now(), context: context });
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
      send('listDrafts');
    },
    reload: function () {
      location.reload();
    },
  };

  Array.prototype.forEach.call(document.querySelectorAll('button[data-action]'), function (b) {
    b.addEventListener('click', actions[b.getAttribute('data-action')]);
  });

  function ready() {
    transport = capacitorTransport() || cordovaTransport();
    document.getElementById('title').textContent = transport
      ? transport.name + ' host'
      : 'No Pulse plugin';
    if (!transport) return log('no Pulse plugin in this WebView');
    transport.subscribe(function (json) {
      log('⚡ ' + json);
    });
    log('ready (' + transport.name + ')');
    send('info');
  }

  // Capacitor may define window.cordova too (its Cordova compatibility layer), so ask it first.
  var cap = window.Capacitor;
  if (cap && cap.isNativePlatform && cap.isNativePlatform()) ready();
  else if (window.cordova) document.addEventListener('deviceready', ready);
  else ready();
})();
