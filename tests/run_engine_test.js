/*
 * Smoke test for the WebAssembly engine.
 *
 *   node tests/run_engine_test.js
 *
 * The engine is a committed binary artifact: it is built from C++ that lives in
 * a separate repository, so nothing here can rebuild it and a pull request
 * cannot be trusted to have left it intact. Two things are checked.
 *
 * 1. The artifacts still hash to what engine/PROVENANCE.json records. That
 *    catches a corrupted or hand-edited binary, and catches an artifact updated
 *    without its provenance.
 *
 * 2. It still returns the right verdicts. Both verdicts are covered on purpose:
 *    an engine that only ever agreed about impossibility could still be wrong
 *    about every diagram it produces. A FOUND diagram is re-verified with
 *    engine.js, which is the same two-implementation agreement the page
 *    requires before it will keep one.
 *
 * The roots are audited results from the native pipeline, not values this test
 * recorded from the engine it is testing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const W = require('../engine.js');

const ENGINE_DIR = path.join(__dirname, '..', 'engine');
const createDsat = require(path.join(ENGINE_DIR, 'dsat_7x6.js'));

let failed = 0;
function check(name, ok, extra) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
}

/* -------------------------------------------------------------- integrity */

const prov = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, 'PROVENANCE.json'), 'utf8'));
for (const [file, want] of Object.entries(prov.artifacts)) {
  const buf = fs.readFileSync(path.join(ENGINE_DIR, file));
  const got = crypto.createHash('sha256').update(buf).digest('hex');
  check(`${file} matches PROVENANCE`, got === want, got === want ? '' : `got ${got.slice(0, 16)}...`);
}

/* ---------------------------------------------------------------- verdicts */

const CASES = [
  { id: 5940, rep: '4621352243446466', expect: 'UNSAT' },
  { id: 4532, rep: '4521224144424221', expect: 'FOUND' }
];

/* The same arguments dsat.worker.js passes, so this tests what ships. */
const ARGS = (rep) => [
  'solve', '--rep', rep,
  '--direct-ply', String(Math.min(42, rep.length + 16)),
  '--budget', '30000000',
  '--expand-culprits', '300000',
  '--max-iters', '100000',
  '--max-seconds', '600',
  '--cex', '16'
];

function lastJson(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.startsWith('{')) { try { return JSON.parse(t); } catch (_) { /* keep looking */ } }
  }
  return null;
}

async function run(rep) {
  const lines = [];
  const mod = await createDsat({
    noInitialRun: true,
    print: (s) => lines.push(String(s)),
    printErr: (s) => lines.push(String(s))
  });
  // emscripten throws ExitStatus on a normal exit() as well as on abort.
  try { mod.callMain(ARGS(rep)); } catch (_) { /* expected */ }
  return lastJson(lines);
}

(async () => {
  for (const c of CASES) {
    const t0 = Date.now();
    const j = await run(c.rep);
    const ms = Date.now() - t0;
    const got = j && j.status;
    check(`node ${c.id}: ${c.expect}`, got === c.expect, `${got} in ${ms} ms`);

    if (c.expect === 'FOUND' && got === 'FOUND') {
      // Same gate the page applies: the engine's word is not enough.
      const moves = W.parseRep(c.rep).moves;
      const board = W.boardFromMoves(moves).board;
      const diagram = j.diagram.map((r) => String(r).replace(/ /g, '.'));
      check(`node ${c.id}: diagram re-verified by engine.js`,
            W.verify(board, diagram, { budget: 5000000 }).win === true);
    }
  }

  if (failed) { console.error(`\nFAILED: ${failed} check(s)`); process.exit(1); }
  console.log('\nOK - the WebAssembly engine is intact and returns the audited verdicts.');
})();
