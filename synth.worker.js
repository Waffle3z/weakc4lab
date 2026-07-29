/* CEGIS synthesis off the main thread.
 *
 * Steps are chained through setTimeout rather than run in a tight loop, so the
 * worker stays responsive and a long search cannot monopolise one task. The
 * page stops a search by terminating the worker outright. */
'use strict';

importScripts('engine.js', 'sat.js', 'synth.js');

var synth = null;
var running = false;
var lastPost = 0;

self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.cmd !== 'start') return;

  try {
    synth = new WeakC4Synth.Synth(msg);
  } catch (err) {
    self.postMessage({ status: 'error', detail: String(err && err.message || err) });
    return;
  }
  running = true;
  lastPost = 0;
  self.postMessage(withTiming(synth.progress()));
  tick();
};

var t0 = 0;
function withTiming(p) {
  p.ms = t0 ? Date.now() - t0 : 0;
  return p;
}

function tick() {
  if (!running || !synth) return;
  if (!t0) t0 = Date.now();

  // A slice of work per macrotask keeps stop responsive without paying a
  // scheduling round-trip per CEGIS iteration. The slice is sized to roughly
  // one display frame, and posts are throttled to the same cadence: the page
  // cannot show more than one candidate per frame anyway, so posting faster
  // would only burn time cloning messages.
  var sliceEnd = Date.now() + 16;
  var p;
  do {
    p = synth.step();
    if (p.status !== 'running') break;
  } while (Date.now() < sliceEnd);

  var now = Date.now();
  if (p.status !== 'running' || now - lastPost >= 16) {
    lastPost = now;
    self.postMessage(withTiming(p));
  }

  if (p.status !== 'running') { running = false; return; }
  setTimeout(tick, 0);
}
