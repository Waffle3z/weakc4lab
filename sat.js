/*
 * A compact CDCL SAT solver (MiniSat-shaped): two-watched literals, 1UIP
 * conflict analysis with clause learning, VSIDS activity, phase saving and
 * Luby restarts.
 *
 * Written for the steady-state synthesizer, so it is incremental in the one
 * direction CEGIS needs: clauses are only ever ADDED between solve() calls,
 * which keeps every learnt clause valid.
 *
 * Literals are integers: lit = 2*v + (negated ? 1 : 0).
 */
;(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SAT = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var UNDEF = -1, FALSE = 0, TRUE = 1;

  function lit(v, neg) { return 2 * v + (neg ? 1 : 0); }
  function litVar(l) { return l >> 1; }
  function litNeg(l) { return l & 1; }
  function litNot(l) { return l ^ 1; }

  function Solver() {
    this.nVars = 0;
    this.clauses = [];      // learnt and problem clauses share this array
    this.watches = [];      // watches[p] = clauses to inspect when p becomes true
    this.value = [];        // per variable: UNDEF / TRUE / FALSE
    this.level = [];
    this.reason = [];       // clause object or null
    this.trail = [];
    this.trailLim = [];
    this.qhead = 0;
    this.activity = [];
    this.varInc = 1;
    this.phase = [];
    this.conflicts = 0;
    this.propagations = 0;
    this.decisions = 0;
    this.ok = true;
    this.learnts = 0;
    this.maxLearnts = 8000;   // grows after each reduction
    this.reductions = 0;
  }

  Solver.prototype.newVar = function () {
    var v = this.nVars++;
    this.watches.push([]);
    this.watches.push([]);
    this.value.push(UNDEF);
    this.level.push(0);
    this.reason.push(null);
    this.activity.push(0);
    this.phase.push(false);
    return v;
  };

  Solver.prototype.ensureVars = function (n) {
    while (this.nVars < n) this.newVar();
  };

  Solver.prototype.litValue = function (l) {
    var v = this.value[litVar(l)];
    if (v === UNDEF) return UNDEF;
    return litNeg(l) ? (v === TRUE ? FALSE : TRUE) : v;
  };

  /* ------------------------------------------------------------- clauses */

  Solver.prototype.attach = function (c) {
    this.watches[litNot(c.lits[0])].push(c);
    this.watches[litNot(c.lits[1])].push(c);
  };

  /** Add a problem clause. Must be called at decision level 0. */
  Solver.prototype.addClause = function (lits) {
    if (!this.ok) return false;
    this.cancelUntil(0);

    // dedupe, drop satisfied / already-false literals
    var seen = {};
    var out = [];
    for (var i = 0; i < lits.length; i++) {
      var l = lits[i];
      if (seen[litNot(l)]) return true;          // tautology
      if (seen[l]) continue;
      seen[l] = 1;
      var val = this.litValue(l);
      if (val === TRUE) return true;             // already satisfied at level 0
      if (val === FALSE) continue;               // permanently false at level 0
      out.push(l);
    }

    if (out.length === 0) { this.ok = false; return false; }
    if (out.length === 1) {
      this.uncheckedEnqueue(out[0], null);
      if (this.propagate()) { this.ok = false; return false; }
      return true;
    }
    var c = { lits: out, learnt: false, activity: 0 };
    this.clauses.push(c);
    this.attach(c);
    return true;
  };

  /* --------------------------------------------------------- propagation */

  Solver.prototype.uncheckedEnqueue = function (l, from) {
    var v = litVar(l);
    this.value[v] = litNeg(l) ? FALSE : TRUE;
    this.level[v] = this.decisionLevel();
    this.reason[v] = from || null;
    this.trail.push(l);
  };

  Solver.prototype.decisionLevel = function () { return this.trailLim.length; };

  /** Returns the conflicting clause, or null. */
  Solver.prototype.propagate = function () {
    var confl = null;
    while (this.qhead < this.trail.length) {
      var p = this.trail[this.qhead++];
      this.propagations++;
      var ws = this.watches[p];
      var i = 0, j = 0;

      while (i < ws.length) {
        var c = ws[i++];
        var lits = c.lits;
        var falseLit = litNot(p);

        // make lits[1] the false watch
        if (lits[0] === falseLit) { lits[0] = lits[1]; lits[1] = falseLit; }

        if (this.litValue(lits[0]) === TRUE) { ws[j++] = c; continue; }

        // look for a new watch
        var found = false;
        for (var k = 2; k < lits.length; k++) {
          if (this.litValue(lits[k]) !== FALSE) {
            lits[1] = lits[k]; lits[k] = falseLit;
            this.watches[litNot(lits[1])].push(c);
            found = true;
            break;
          }
        }
        if (found) continue;

        ws[j++] = c;
        if (this.litValue(lits[0]) === FALSE) {
          confl = c;
          this.qhead = this.trail.length;
          while (i < ws.length) ws[j++] = ws[i++];
        } else {
          this.uncheckedEnqueue(lits[0], c);
        }
      }
      ws.length = j;
      if (confl) break;
    }
    return confl;
  };

  /* ---------------------------------------------------------- backtracking */

  Solver.prototype.cancelUntil = function (lvl) {
    if (this.decisionLevel() <= lvl) return;
    var lim = this.trailLim[lvl];
    for (var i = this.trail.length - 1; i >= lim; i--) {
      var v = litVar(this.trail[i]);
      this.phase[v] = this.value[v] === TRUE;
      this.value[v] = UNDEF;
      this.reason[v] = null;
    }
    this.trail.length = lim;
    this.trailLim.length = lvl;
    this.qhead = this.trail.length;
  };

  /* ------------------------------------------------------ conflict analysis */

  Solver.prototype.bumpVar = function (v) {
    this.activity[v] += this.varInc;
    if (this.activity[v] > 1e100) {
      for (var i = 0; i < this.nVars; i++) this.activity[i] *= 1e-100;
      this.varInc *= 1e-100;
    }
  };

  /** First-UIP learning. Returns {lits, backtrackLevel}. */
  Solver.prototype.analyze = function (confl) {
    var seen = new Uint8Array(this.nVars);
    var learnt = [0]; // placeholder for the asserting literal
    var counter = 0;
    var p = -1;
    var idx = this.trail.length - 1;
    var lvl = this.decisionLevel();

    do {
      var lits = confl.lits;
      for (var i = (p === -1 ? 0 : 1); i < lits.length; i++) {
        var q = lits[i];
        var v = litVar(q);
        if (!seen[v] && this.level[v] > 0) {
          seen[v] = 1;
          this.bumpVar(v);
          if (this.level[v] >= lvl) counter++;
          else learnt.push(q);
        }
      }
      // pick the next literal of the current level from the trail
      while (!seen[litVar(this.trail[idx])]) idx--;
      p = this.trail[idx];
      idx--;
      seen[litVar(p)] = 0;
      counter--;
      confl = this.reason[litVar(p)];
    } while (counter > 0);

    learnt[0] = litNot(p);

    // Literal block distance: how many decision levels the clause spans. A low
    // LBD means the clause ties together few levels, which is the standard
    // predictor of a clause worth keeping.
    var lbd = 0, lvlSeen = {};
    for (var li = 0; li < learnt.length; li++) {
      var lv = this.level[litVar(learnt[li])];
      if (!lvlSeen[lv]) { lvlSeen[lv] = 1; lbd++; }
    }

    // backtrack level = highest level among the rest
    var bt = 0;
    if (learnt.length > 1) {
      var maxI = 1;
      for (var k = 2; k < learnt.length; k++) {
        if (this.level[litVar(learnt[k])] > this.level[litVar(learnt[maxI])]) maxI = k;
      }
      var tmp = learnt[1]; learnt[1] = learnt[maxI]; learnt[maxI] = tmp;
      bt = this.level[litVar(learnt[1])];
    }
    return { lits: learnt, bt: bt, lbd: lbd };
  };

  /* ------------------------------------------------------- clause database */

  /*
   * Learnt clauses are never useless, but keeping every one of them makes
   * propagation slower and slower: an unbounded database cost this solver a 5x
   * throughput drop over twelve seconds of CEGIS. Drop the worst half by LBD,
   * keeping binaries and glue clauses, and let the budget grow so the database
   * still expands over a long run.
   *
   * Only ever called at decision level 0, so no surviving clause can be the
   * reason for a current assignment.
   */
  Solver.prototype.reduceDB = function () {
    var problem = [], learnt = [];
    for (var i = 0; i < this.clauses.length; i++) {
      var c = this.clauses[i];
      (c.learnt ? learnt : problem).push(c);
    }
    learnt.sort(function (a, b) { return (a.lbd - b.lbd) || (b.activity - a.activity); });

    var keepCount = Math.floor(learnt.length / 2);
    var kept = problem;
    for (var j = 0; j < learnt.length; j++) {
      var lc = learnt[j];
      if (j < keepCount || lc.lbd <= 2 || lc.lits.length <= 2) kept.push(lc);
    }

    this.clauses = kept;
    this.learnts = 0;
    for (var k = 0; k < kept.length; k++) if (kept[k].learnt) this.learnts++;
    this.rebuildWatches();
    this.reductions++;
    this.maxLearnts = Math.floor(this.maxLearnts * 1.5);
  };

  /*
   * INVARIANT, and the reason reduceDB may only be called from the top of
   * solve()'s outer loop:
   *
   * If a clause has fewer than two non-false literals, this leaves a watch on a
   * literal that is already false at level 0, which normally means a unit
   * implication can be missed. It is safe here only because at that call site
   * at most ONE literal on the trail is still un-propagated (the asserting unit
   * learnt just before the restart break). That literal is provably one of the
   * two watched literals before the rebuild, so the propagate() immediately
   * after reduceDB still recovers the implication.
   *
   * Call this anywhere with two or more pending literals and a unit
   * implication, or in the limit a level-0 conflict, could be missed.
   */
  Solver.prototype.rebuildWatches = function () {
    for (var i = 0; i < this.watches.length; i++) this.watches[i].length = 0;
    for (var k = 0; k < this.clauses.length; k++) {
      var c = this.clauses[k], lits = c.lits;
      // Watches must not sit on literals already false at level 0, or a unit
      // implication could be missed. Float up to two non-false literals.
      for (var slot = 0; slot < 2 && slot < lits.length; slot++) {
        if (this.litValue(lits[slot]) !== FALSE) continue;
        for (var s = slot + 1; s < lits.length; s++) {
          if (this.litValue(lits[s]) !== FALSE) {
            var t = lits[slot]; lits[slot] = lits[s]; lits[s] = t;
            break;
          }
        }
      }
      this.attach(c);
    }
  };

  /* ------------------------------------------------------------- decisions */

  Solver.prototype.pickBranchVar = function () {
    var best = -1, bestAct = -1;
    for (var v = 0; v < this.nVars; v++) {
      if (this.value[v] === UNDEF && this.activity[v] > bestAct) { best = v; bestAct = this.activity[v]; }
    }
    return best;
  };

  function luby(y, x) {
    var size = 1, seq = 0;
    while (size < x + 1) { seq++; size = 2 * size + 1; }
    while (size - 1 !== x) { size = (size - 1) >> 1; seq--; x = x % size; }
    return Math.pow(y, seq);
  }

  /**
   * solve({maxConflicts}) -> 'sat' | 'unsat' | 'unknown'
   * 'unknown' only ever means the conflict budget ran out.
   */
  Solver.prototype.solve = function (opts) {
    opts = opts || {};
    var budget = opts.maxConflicts != null ? opts.maxConflicts : Infinity;
    if (!this.ok) return 'unsat';
    this.cancelUntil(0);
    if (this.propagate()) { this.ok = false; return 'unsat'; }

    var spent = 0;
    var restart = 0;

    for (;;) {
      // Between restarts we are back at level 0, the only safe point to prune.
      if (this.learnts > this.maxLearnts) {
        this.reduceDB();
        if (this.propagate()) { this.ok = false; return 'unsat'; }
      }
      var restartBudget = Math.ceil(luby(2, restart++) * 100);
      var sinceRestart = 0;

      for (;;) {
        var confl = this.propagate();
        if (confl) {
          this.conflicts++; spent++; sinceRestart++;
          if (this.decisionLevel() === 0) { this.ok = false; return 'unsat'; }
          var res = this.analyze(confl);
          this.cancelUntil(res.bt);
          if (res.lits.length === 1) {
            this.uncheckedEnqueue(res.lits[0], null);
          } else {
            var c = { lits: res.lits, learnt: true, activity: this.varInc, lbd: res.lbd };
            this.clauses.push(c);
            this.learnts++;
            this.attach(c);
            this.uncheckedEnqueue(res.lits[0], c);
          }
          this.varInc /= 0.95;
          if (spent >= budget) { this.cancelUntil(0); return 'unknown'; }
          if (sinceRestart >= restartBudget) { this.cancelUntil(0); break; }
        } else {
          var v = this.pickBranchVar();
          if (v < 0) return 'sat';
          this.decisions++;
          this.trailLim.push(this.trail.length);
          this.uncheckedEnqueue(lit(v, !this.phase[v]), null);
        }
      }
    }
  };

  /** Truth value of each variable in the current model. */
  Solver.prototype.model = function () {
    var m = new Array(this.nVars);
    for (var v = 0; v < this.nVars; v++) m[v] = this.value[v] === TRUE;
    return m;
  };

  return { Solver: Solver, lit: lit, litVar: litVar, litNeg: litNeg, litNot: litNot };
});
