/*
 * The native pipeline, compiled to WebAssembly.
 *
 * This is dsat.cpp linked against CaDiCaL, built from the connect4 research
 * repository by its tools/build_wasm.sh. It is the same source the native
 * pipeline runs on, not a reimplementation, so it cannot drift from it.
 * engine/PROVENANCE.json records exactly which source produced the artifact.
 *
 * Unlike the in-page CEGIS, this decides a whole ROOT: it either produces a
 * complete diagram or reports that none exists in the language. It takes no
 * account of markers already on the board, because dsat solves from the
 * position, not from a partial diagram.
 *
 * dsat reports everything as JSON on stdout already, so the worker just
 * forwards each line. Emscripten's in-memory filesystem covers its checkpoint
 * writes without any change to the C++.
 */
'use strict';

importScripts('engine/dsat_7x6.js');

var WASM_URL = 'engine/dsat_7x6.wasm';
var running = false;

/*
 * One run per worker, then the page terminates it.
 *
 * Each run needs its own Module: dsat's modes keep global state and EXIT_RUNTIME
 * tears the runtime down when main returns, so an instance is spent afterwards.
 * A Module owns a WebAssembly.Memory, and a heavy root grows that to about a
 * gigabyte. Dropping the reference does not give the memory back on any
 * schedule you can rely on: measured over four consecutive ply-14 solves in one
 * realm, resident memory went 1.1, 2.2, 3.3, 4.4 GB and only fell when a
 * collection was forced. In a tab there is nothing to force it, so the second
 * or third solve fails to allocate.
 *
 * Terminating the worker releases everything it owned, immediately and without
 * depending on the collector. That is why the binary is cached on the page
 * instead of here: the download survives, the heap does not.
 */
var wasmBinary = null;

function forward(line) {
  var t = String(line);
  if (t.charAt(0) !== '{') { self.postMessage({ type: 'log', line: t }); return; }
  try {
    self.postMessage({ type: 'status', json: JSON.parse(t) });
  } catch (e) {
    self.postMessage({ type: 'log', line: t });
  }
}

/*
 * Emscripten reports a failed allocation as a bare "Aborted()." with no
 * indication of what went wrong. That is what a root below about ply 14
 * actually produces: the envelope outgrows wasm32 while it is still being
 * built, so the module dies before the state budget is ever consulted.
 * Showing the raw string tells the user nothing, so classify it here.
 */
function describeFailure(err) {
  var m = String((err && err.message) || err || 'unknown error');
  if (/abort|out of memory|allocat|OOM|Cannot enlarge memory/i.test(m)) {
    return 'This root outgrew the memory a browser tab can give it. ' +
           'Every move already played makes a root dramatically cheaper, so try a deeper one.';
  }
  return m;
}

function progress(phase, loaded, total) {
  self.postMessage({ type: 'loading', phase: phase, loaded: loaded, total: total });
}

/*
 * Fetch the wasm ourselves rather than letting emscripten do it, purely so the
 * download can be reported. A megabyte over a slow link is many seconds of an
 * apparently frozen button otherwise. The page passes the bytes back on later
 * runs, so this only fetches once per session despite the worker being new.
 */
function loadBinary() {
  if (wasmBinary) return Promise.resolve(wasmBinary);
  return fetch(WASM_URL).then(function (res) {
    if (!res.ok) throw new Error('could not fetch the engine (' + res.status + ')');
    var total = parseInt(res.headers.get('content-length') || '0', 10);
    if (!res.body || !res.body.getReader) return res.arrayBuffer();

    var reader = res.body.getReader();
    var chunks = [];
    var loaded = 0;
    return (function pump() {
      return reader.read().then(function (r) {
        if (r.done) {
          var buf = new Uint8Array(loaded);
          var off = 0;
          for (var i = 0; i < chunks.length; i++) { buf.set(chunks[i], off); off += chunks[i].length; }
          return buf.buffer;
        }
        chunks.push(r.value);
        loaded += r.value.length;
        progress('download', loaded, total);
        return pump();
      });
    })();
  }).then(function (buf) {
    wasmBinary = buf;
    // Hand it up so the next worker starts warm.
    self.postMessage({ type: 'binary', buffer: buf });
    return buf;
  });
}

self.onmessage = function (e) {
  var msg = e.data || {};
  if (msg.cmd !== 'solve' || running) return;
  running = true;
  if (msg.binary) wasmBinary = msg.binary;

  var t0 = Date.now();
  var fresh = !wasmBinary;

  loadBinary().then(function (binary) {
    progress('compile', 0, 0);
    /*
     * A fresh Module per run. dsat's modes keep global state, and callMain is
     * not re-entrant, so reusing one instance across roots would leak state
     * between them. Instantiating from a cached binary is cheap.
     */
    return createDsat({
      noInitialRun: true,
      wasmBinary: binary,
      /*
       * Still needed as a fallback path. Loaded through importScripts,
       * emscripten cannot infer its own directory and would look for the .wasm
       * beside the WORKER rather than beside the glue.
       */
      locateFile: function (file) { return 'engine/' + file; },
      print: forward,
      printErr: forward
    });
  }).then(function (mod) {
    progress('run', 0, 0);
    /*
     * Hybrid, not full `direct`. Full direct's memory is proportional to the
     * envelope (~620 B per state), which puts ply-14 roots around 30 GB and far
     * past wasm32's 4 GiB ceiling. The cut ply plus the culprit-expansion cap
     * bound memory by construction, so the browser can pick a budget it can
     * actually honour. The cut is root_ply + offset, matching dsat_campaign.py,
     * where offset 16 is the measured sweet spot.
     */
    var args = [
      'solve',
      '--rep', msg.rep,
      '--direct-ply', String(msg.cutPly),
      '--budget', String(msg.budget),
      '--expand-culprits', String(msg.expand),
      '--max-iters', String(msg.maxIters),
      // dsat defaults to no time limit. Unbounded is the wrong default in a
      // browser tab: a shallow root is open research and will not finish, and
      // without this it would burn a core until the tab is closed.
      '--max-seconds', String(msg.maxSeconds),
      '--cex', '16',
      '--status-every', '25',
      // Without this the engine is silent for the whole envelope build, which
      // is the longest phase: measured at 6.8 s at ply 14 and far worse below.
      '--progress-every', '0.4',
      '--checkpoint', '/ck.jsonl'
    ];
    /* Hard units on every decided cell, so the run can only fill in what the
     * page left undecided. A board with nothing decided sends all '?' and the
     * engine pins nothing, which is the behaviour this always had. */
    if (msg.pin) args.push('--pin', msg.pin);
    try {
      mod.callMain(args);
    } catch (err) {
      // emscripten throws ExitStatus on a normal exit() as well as on abort.
      var m = String(err && err.message || err);
      if (!/ExitStatus|exit\(/.test(m)) {
        self.postMessage({ type: 'status', json: { status: 'ERROR', error: describeFailure(err) } });
      }
    }
    self.postMessage({ type: 'done', ms: Date.now() - t0, firstLoad: fresh });
    running = false;
  }).catch(function (err) {
    self.postMessage({
      type: 'status',
      json: { status: 'ERROR', error: describeFailure(err) }
    });
    self.postMessage({ type: 'done', ms: Date.now() - t0, firstLoad: fresh });
    running = false;
  });
};
