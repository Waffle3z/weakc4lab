/*
 * Correctness tests for sat.js and an end-to-end check of synth.js.
 *
 *   node tests/run_sat_tests.js
 *
 * The SAT solver is checked against brute force on small random instances and
 * against a family with a known UNSAT answer (pigeonhole). A wrong SAT answer
 * would make the synthesizer propose junk (harmless - every candidate is still
 * exhaustively verified) but a wrong UNSAT answer would make it claim a root
 * is impossible when it is not, which is the dangerous direction.
 */
'use strict';

const SAT = require('../sat.js');
const W = require('../engine.js');
const { Synth } = require('../synth.js');

let failures = 0;
function check(name, cond, extra) {
  if (!cond) { failures++; console.error('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

/* ------------------------------------------------- brute force vs the solver */

function bruteSat(nVars, clauses) {
  for (let mask = 0; mask < (1 << nVars); mask++) {
    let ok = true;
    for (const c of clauses) {
      let sat = false;
      for (const l of c) {
        const v = l >> 1, neg = l & 1;
        const val = !!(mask & (1 << v));
        if (val !== !!neg) { sat = true; break; }
      }
      if (!sat) { ok = false; break; }
    }
    if (ok) return mask;
  }
  return -1;
}

function modelSatisfies(model, clauses) {
  return clauses.every((c) => c.some((l) => model[l >> 1] !== !!(l & 1)));
}

// A deterministic LCG keeps a failure reproducible.
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

let satAgree = 0, unsatAgree = 0;
for (let trial = 0; trial < 600; trial++) {
  const n = 4 + Math.floor(rnd() * 7);            // 4..10 vars
  const m = Math.floor(n * (3 + rnd() * 3));      // near the phase transition
  const clauses = [];
  for (let i = 0; i < m; i++) {
    const cl = new Set();
    while (cl.size < 3) cl.add(2 * Math.floor(rnd() * n) + (rnd() < 0.5 ? 1 : 0));
    clauses.push([...cl]);
  }

  const s = new SAT.Solver();
  s.ensureVars(n);
  for (const c of clauses) s.addClause(c);
  const verdict = s.solve({});
  const brute = bruteSat(n, clauses);

  if (brute >= 0) {
    check(`trial ${trial}: expected sat`, verdict === 'sat', `got ${verdict}`);
    if (verdict === 'sat') {
      check(`trial ${trial}: model valid`, modelSatisfies(s.model(), clauses));
      satAgree++;
    }
  } else {
    check(`trial ${trial}: expected unsat`, verdict === 'unsat', `got ${verdict}`);
    if (verdict === 'unsat') unsatAgree++;
  }
}
console.log(`random 3-SAT : 600 instances (${satAgree} sat, ${unsatAgree} unsat) agree with brute force`);

/* --------------------------------------------- clause deletion, under load */
/*
 * maxLearnts starts at 8000, so nothing above ever triggers reduceDB and the
 * whole delete-and-reattach path used to ship untested. It is the most
 * dangerous code in the file: a lost watch or a deleted clause still cited as
 * a reason would corrupt propagation, and a wrong UNSAT is reported to the
 * user as a conclusion rather than being re-verified downstream.
 *
 * Forcing maxLearnts down to single digits makes reduceDB and rebuildWatches
 * run hundreds of times per instance. Clauses are added between solve() calls
 * to mimic how CEGIS drives the solver.
 */
let reduceAgree = 0, reductionsSeen = 0;
for (let trial = 0; trial < 150; trial++) {
  const n = 10 + Math.floor(rnd() * 5);           // 10..14 vars
  const m = Math.floor(n * (4 + rnd() * 1.2));    // at the phase transition
  const clauses = [];
  for (let i = 0; i < m; i++) {
    const cl = new Set();
    while (cl.size < 3) cl.add(2 * Math.floor(rnd() * n) + (rnd() < 0.5 ? 1 : 0));
    clauses.push([...cl]);
  }

  const s = new SAT.Solver();
  s.ensureVars(n);
  // reduceDB multiplies maxLearnts by 1.5 each time, so it outgrows any fixed
  // start. Re-clamping before every solve keeps the pressure constant.
  let verdict = 'sat';
  for (let k = 0; k < clauses.length; k++) {
    if (!s.addClause(clauses[k])) { verdict = 'unsat'; break; }
    if (k % 5 === 4) { s.maxLearnts = 4; verdict = s.solve({}); if (verdict === 'unsat') break; }
  }
  if (verdict !== 'unsat') { s.maxLearnts = 4; verdict = s.solve({}); }
  reductionsSeen += s.reductions;

  const brute = bruteSat(n, clauses);
  const want = brute >= 0 ? 'sat' : 'unsat';
  check(`reduce trial ${trial}: expected ${want}`, verdict === want, `got ${verdict}`);
  if (verdict === want) {
    if (verdict === 'sat') check(`reduce trial ${trial}: model valid`, modelSatisfies(s.model(), clauses));
    reduceAgree++;
  }
}
check('clause deletion actually ran', reductionsSeen > 0, `${reductionsSeen} reductions`);
console.log(`clause delete: 150 incremental instances, ${reductionsSeen} reductions, ${reduceAgree} agree with brute force`);

/* ------------------------------------------------------------- pigeonhole */

function pigeonhole(holes, maxLearnts) {
  const pigeons = holes + 1;
  const s = new SAT.Solver();
  const v = (p, h) => p * holes + h;
  s.ensureVars(pigeons * holes);
  if (maxLearnts) s.maxLearnts = maxLearnts;
  for (let p = 0; p < pigeons; p++) {
    const cl = [];
    for (let h = 0; h < holes; h++) cl.push(SAT.lit(v(p, h), false));
    s.addClause(cl);
  }
  for (let h = 0; h < holes; h++) {
    for (let p1 = 0; p1 < pigeons; p1++) {
      for (let p2 = p1 + 1; p2 < pigeons; p2++) {
        s.addClause([SAT.lit(v(p1, h), true), SAT.lit(v(p2, h), true)]);
      }
    }
  }
  return { verdict: s.solve({}), reductions: s.reductions };
}
for (const h of [3, 4, 5, 6]) {
  check(`pigeonhole ${h + 1}->${h}`, pigeonhole(h).verdict === 'unsat');
}
console.log('pigeonhole   : 4->3 .. 7->6 all UNSAT');

// The same instances with deletion forced on. These generate thousands of
// conflicts, so they hammer reduceDB far harder than the random 3-SAT above,
// and the expected answer is known without needing brute force.
let phReductions = 0;
for (const h of [4, 5, 6]) {
  const r = pigeonhole(h, 4);
  phReductions += r.reductions;
  check(`pigeonhole ${h + 1}->${h} with deletion forced`, r.verdict === 'unsat');
}
check('forced deletion ran on pigeonhole', phReductions > 0, `${phReductions} reductions`);
console.log(`             + forced deletion: ${phReductions} reductions, still UNSAT`);

/* ---------------------------------------------------- incremental addClause */
{
  const s = new SAT.Solver();
  s.ensureVars(3);
  s.addClause([SAT.lit(0, false), SAT.lit(1, false), SAT.lit(2, false)]);
  check('incremental: initially sat', s.solve({}) === 'sat');
  s.addClause([SAT.lit(0, true)]);
  s.addClause([SAT.lit(1, true)]);
  check('incremental: still sat', s.solve({}) === 'sat');
  const m = s.model();
  check('incremental: forced var 2', m[2] === true && m[0] === false && m[1] === false);
  s.addClause([SAT.lit(2, true)]);
  check('incremental: now unsat', s.solve({}) === 'unsat');
  console.log('incremental  : add-clause-between-solves behaves');
}

/* ------------------------------------------------------- synthesizer, warm */
/* Node 323 from 2swap's published graph: a root with a known strict diagram. */

const REP = '44444221';
const KNOWN = ['...@...', '...1...', '+@.2=..', '+!.1=..', '+1-2=..', '22-1=..'];
const moves = W.parseRep(REP).moves;
const rootB = W.boardFromMoves(moves).board;

check('fixture: known diagram wins', W.verify(rootB, KNOWN, {}).win);

{
  // Seeded with the answer: the very first SAT model should already be it.
  const sy = new Synth({ moves, seed: KNOWN });
  const p = sy.step();
  check('synth warm: found on iteration 1', p.status === 'found', `status=${p.status}`);
  console.log(`synth warm   : iteration ${p.iterations}, ${p.freeCells} free cells, ${p.vars} vars`);
}

{
  // Perturb four cells and make it repair them, with the rest locked.
  const broken = KNOWN.slice();
  const spots = [[0, 0], [1, 2], [4, 6], [5, 2]];
  let d = broken;
  for (const [yt, x] of spots) d = W.setCell(d, yt, x, '=');
  const locked = {};
  for (const cell of W.freeCells(rootB)) {
    if (!spots.some(([yt, x]) => yt === cell.yt && x === cell.x)) {
      locked[cell.yt + ',' + cell.x] = KNOWN[cell.yt][cell.x];
    }
  }
  const sy = new Synth({ moves, seed: d, locked });
  const t0 = Date.now();
  let p;
  for (let i = 0; i < 4000 && (p = sy.step()).status === 'running'; i++);
  check('synth repair: found', p.status === 'found', `status=${p.status} detail=${p.detail}`);
  if (p.status === 'found') {
    check('synth repair: candidate verifies', W.verify(rootB, p.candidate, {}).win);
  }
  console.log(`synth repair : ${p.status} in ${p.iterations} iterations, ` +
              `${p.clauses} clauses, ${Date.now() - t0} ms (4 cells undecided)`);
}

{
  /*
   * The CEGIS invariant: every clause derived from a losing line must EXCLUDE
   * the candidate that produced that line. If it does not, the solver hands
   * back the same model forever and the search silently stalls while the
   * iteration and clause counters keep climbing.
   *
   * This regression exists because the miai rule broke exactly that: miai
   * fires only when exactly one is exposed, so a state with two or more miai
   * can be a no-move state that still contains miai markers.
   */
  const SAT = require('../sat.js');
  const sy = new Synth({ moves });
  const solver = sy.solver;
  const satisfiedBy = (model, lits) => lits.some((l) => model[l >> 1] !== !!(l & 1));

  let selfSatisfied = 0, repeats = 0, prev = null, steps = 0;
  for (let i = 0; i < 1500; i++) {
    if (solver.solve({ maxConflicts: sy.satBudget }) !== 'sat') break;
    const model = solver.model();
    const diagram = sy.diagramFromModel(model);
    if (diagram.join('') === prev) repeats++;
    prev = diagram.join('');
    const res = W.verify(sy.root, diagram, { budget: sy.verifyBudget, maxFails: sy.maxFails });
    if (res.win) break;
    steps++;
    for (const f of res.fails) {
      const lits = sy.clauseForLine(diagram, f.line);
      if (lits === null) break;
      if (satisfiedBy(model, lits)) selfSatisfied++;
      solver.addClause(lits);
    }
  }
  check('cegis: no clause is satisfied by its own candidate', selfSatisfied === 0,
        `${selfSatisfied} self-satisfied clause(s) over ${steps} steps`);
  check('cegis: candidate never repeats', repeats === 0, `${repeats} repeated candidates`);
  console.log(`cegis guard  : ${steps} steps, ${selfSatisfied} self-satisfied clauses, ${repeats} repeats`);
}

{
  // Cold start from nothing: measure how far unaided CEGIS gets.
  const sy = new Synth({ moves });
  const t0 = Date.now();
  let p, i = 0;
  for (; i < 400; i++) { p = sy.step(); if (p.status !== 'running') break; }
  console.log(`synth cold   : ${p.status} after ${p.iterations} iterations, ` +
              `${p.clauses} clauses, deepest counterexample ${p.bestDepth} ply, ` +
              `${Date.now() - t0} ms`);
  if (p.status === 'found') {
    check('synth cold: candidate verifies', W.verify(rootB, p.candidate, {}).win);
  }
}

if (failures) { console.error(`\nFAILED with ${failures} failure(s)`); process.exit(1); }
console.log('\nOK - SAT solver and synthesizer pass.');
