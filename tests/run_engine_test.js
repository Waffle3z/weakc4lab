/*
 * Smoke test for the WebAssembly engine.
 *
 *   node tests/run_engine_test.js
 *
 * The engine is a committed binary artifact: it is built from C++ that lives in
 * a separate repository, so nothing here can rebuild it and a pull request
 * cannot be trusted to have left it intact. Two things are checked.
 *
 * 1. The artifacts still hash to what their engine/PROVENANCE*.json records,
 *    and git stores them byte for byte. That catches a corrupted or hand-edited
 *    binary, an artifact updated without its provenance, and one whose bytes
 *    would change under a line-ending filter on the way to another machine.
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
const { execFileSync } = require('child_process');
const W = require('../engine.js');

const ENGINE_DIR = path.join(__dirname, '..', 'engine');
const createDsat = require(path.join(ENGINE_DIR, 'dsat_7x6.js'));

let failed = 0;
function check(name, ok, extra) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
}

/* -------------------------------------------------------------- integrity */

/* Every PROVENANCE*.json in engine/. Each build writes its own, so neither
 * build script has to know what else ships alongside it. */
const provFiles = fs.readdirSync(ENGINE_DIR).filter((f) => /^PROVENANCE.*\.json$/.test(f));
check('at least one provenance file', provFiles.length > 0, provFiles.join(', '));
const artifacts = [];
for (const pf of provFiles) {
  const prov = JSON.parse(fs.readFileSync(path.join(ENGINE_DIR, pf), 'utf8'));
  for (const [file, want] of Object.entries(prov.artifacts)) {
    artifacts.push(file);
    const buf = fs.readFileSync(path.join(ENGINE_DIR, file));
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    check(`${file} matches ${pf}`, got === want, got === want ? '' : `got ${got.slice(0, 16)}...`);
  }
}

/* Those hashes come from the working copy, so a git filter that rewrites line
 * endings on checkout leaves them passing here and failing on a machine with
 * the other convention. .gitattributes exempts the engine for that reason, and
 * this is what notices when an artifact lands outside the exemption. */
try {
  const hash = (args) =>
    execFileSync('git', ['hash-object'].concat(args), { cwd: ENGINE_DIR, encoding: 'utf8' }).trim();
  for (const file of artifacts) {
    const stored = hash([file]);
    const onDisk = hash(['--no-filters', file]);
    check(`${file} is committed byte for byte`, stored === onDisk,
          stored === onDisk ? '' : 'a git filter rewrites it: exempt it in .gitattributes');
  }
} catch (e) {
  console.log('ok   git filter check skipped (no git checkout here)');
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
  '--budget', '3000000',
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

  /* ------------------------------------------------ the game solver ----- */
  /*
   * Scores recorded from the native solver (`solve scorefile --weak`), not from
   * this build, so the check is against the engine the port is meant to match
   * rather than against itself.
   *
   * All are deep positions on purpose. A weak solve costs about 5 ms at ply 12
   * and beyond but 2.5 minutes from the empty board, so testing the opening
   * would make this suite unrunnable for no extra confidence.
   */
  const createC4Solver = require(path.join(ENGINE_DIR, 'c4solver_7x6.js'));
  const c4 = await createC4Solver();
  const solve = c4.cwrap('c4_solve', 'number', ['string', 'number']);

  const SCORES = [
    ['4451323672175', 0],        // draw
    ['445132367217', 0],
    ['44513236721', 1],
    ['4451323672', 1],
    ['445132367', 1],
    ['462135224344', 1],
    ['4521224144424221', 1],
    ['4621352243446466', 3]      // won by a wider margin
  ];
  for (const [pos, want] of SCORES) {
    const got = solve(pos, 1);
    check(`weak solve ${pos} = ${want}`, got === want, `got ${got}`);
  }
  check('illegal input is rejected', solve('8', 1) === -1000, `got ${solve('8', 1)}`);

  /*
   * Winning-move enumeration, the reason the port exists. The mask below was
   * derived natively by solving each child and negating, which is exactly what
   * a synthesizer would need and what the in-page one currently cannot do.
   */
  const buf = c4._malloc(7);
  const n = c4.ccall('c4_winning_moves', 'number', ['string', 'number'], ['462135224344', buf]);
  const mask = Array.from(c4.HEAPU8.subarray(buf, buf + 7));
  c4._free(buf);
  const WANT = [1, 1, 0, 1, 0, 1, 1];
  check('winning moves at 462135224344', mask.join('') === WANT.join(''), `got ${mask.join('')}`);
  check('and the count agrees', n === 5, `got ${n}`);

  if (failed) { console.error(`\nFAILED: ${failed} check(s)`); process.exit(1); }
  console.log('\nOK - both WebAssembly engines are intact and return the audited verdicts.');
})();
