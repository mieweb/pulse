/*
 * window.PulseKit: the Cordova transport for @mieweb/pulse-embed (native-bridge.md §7.2).
 * Envelopes pass through as JSON strings; nothing here reads them.
 *
 *   call(json)     → Promise<string>   the reply envelope. A Pulse error is a reply with
 *                                       ok:false; the promise rejects only when the transport
 *                                       fails (the client turns that into `unavailable`).
 *   subscribe(cb)  → unsubscribe()     cb(json) for each event envelope.
 *
 * Every subscriber shares one native subscription. When the last one leaves, the native side
 * is told, so flowResult and hostRequest wait there again instead of reaching a page that
 * stopped listening.
 */
var exec = require('cordova/exec');

var SERVICE = 'Pulse';
var listeners = [];
var subscribed = false;

function transportError(err) {
  if (err instanceof Error) return err;
  return new Error(typeof err === 'string' && err ? err : 'The Pulse plugin call failed.');
}

function call(json) {
  return new Promise(function (resolve, reject) {
    if (typeof json !== 'string') {
      reject(new TypeError('PulseKit.call takes the request envelope as a JSON string.'));
      return;
    }
    exec(
      function (reply) {
        resolve(reply);
      },
      function (err) {
        reject(transportError(err));
      },
      SERVICE,
      'call',
      [json],
    );
  });
}

function onEvent(json) {
  if (typeof json !== 'string') return;
  listeners.slice().forEach(function (listener) {
    try {
      listener.cb(json);
    } catch (e) {
      // One listener's throw must not starve the others; report it outside this loop.
      setTimeout(function () {
        throw e;
      }, 0);
    }
  });
}

function onSubscribeError(err) {
  subscribed = false;
  console.warn('[PulseKit] subscribe failed: ' + transportError(err).message);
}

function subscribe(cb) {
  if (typeof cb !== 'function') throw new TypeError('PulseKit.subscribe needs a callback.');
  var listener = { cb: cb };
  listeners.push(listener);
  if (!subscribed) {
    subscribed = true;
    exec(onEvent, onSubscribeError, SERVICE, 'subscribe', []);
  }
  return function unsubscribe() {
    var i = listeners.indexOf(listener);
    if (i < 0) return;
    listeners.splice(i, 1);
    if (listeners.length === 0 && subscribed) {
      subscribed = false;
      exec(
        function () {},
        function () {},
        SERVICE,
        'unsubscribe',
        [],
      );
    }
  };
}

module.exports = { call: call, subscribe: subscribe };
