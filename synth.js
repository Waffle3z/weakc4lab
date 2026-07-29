/*
 * CEGIS steady-state synthesizer, entirely in the browser.
 *
 *   SAT candidate  ->  exhaustive verify  ->  counterexample lines  ->  clauses
 *
 * Encoding: one Boolean per (root-empty cell, marker), with exactly-one per
 * cell. 42 cells x 7 markers = at most 294 variables.
 *
 * ---------------------------------------------------------------------------
 * Why the counterexample clauses are sound
 * ---------------------------------------------------------------------------
 * A losing line is fixed by Yellow's replies plus Red's decisions. Red's
 * decision at a quiet position depends only on the markers of the (at most
 * seven) frontier cells. So for each Red decision along the line we can write
 * down a set of markers per frontier cell that is SUFFICIENT to reproduce that
 * same decision:
 *
 *   chosen cell X at level L : marker must fire at exactly L
 *   every other frontier cell: marker must fire strictly below L, or be inert
 *   (win / block decisions)  : marker-independent, so no constraint at all
 *   ambiguous at level L     : two candidates fire at exactly L, the rest do
 *                              not fire above L
 *   no-move                  : every frontier cell inert
 *
 * If a diagram keeps every frontier cell inside its allowed set at every
 * decision state, it reproduces the whole line and loses the same way.
 * Negating that conjunction gives a clause of PURE POSITIVE literals -
 * "some cell must take a marker outside its allowed set" - because with
 * one-hot variables, (marker[c] not in S) is exactly OR of the vars outside S.
 *
 * The clause can never be vacuous: the candidate that produced the line is
 * itself inside every allowed set, so at least one marker per cell survives
 * the intersection, and the clause always excludes at least the current
 * candidate. CEGIS therefore always makes progress.
 *
 * This is weaker than the native pipeline's clause, which additionally names
 * the exact winning moves at the culprit (that needs a full game solver as an
 * oracle - `solve_7x6.exe` - which is not present here). Expect this to shine
 * on partially-locked / seeded diagrams and to grind on a cold deep root.
 *
 * An UNSAT verdict here is sound with respect to these clauses, but it is NOT
 * an audited impossibility proof: treat it as provisional and re-derive it
 * with dsat / synth_exact.py before claiming it.
 */
;(function (root, factory) {
  var api = factory(
    typeof require === 'function' ? require('./engine.js') : root.WeakC4,
    typeof require === 'function' ? require('./sat.js') : root.SAT
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WeakC4Synth = api;
})(typeof self !== 'undefined' ? self : globalThis, function (W, SAT) {
  'use strict';

  var NM = W.MARKER_CHARS.length;

  /**
   * opts:
   *   moves        root move sequence (array of 1..7)
   *   seed         diagram to start from (phase hint), or null
   *   locked       { "yt,x": glyph } cells pinned by the user
   *   maxFails     counterexamples harvested per candidate (default 8)
   *   verifyBudget node cap per verification (default 400000)
   *   satBudget    conflicts per solver call before yielding (default 20000)
   */
  function Synth(opts) {
    opts = opts || {};
    this.opts = opts;
    this.maxFails = opts.maxFails || 8;
    /* Harvesting more counterexamples than we keep and keeping the SHALLOWEST
     * ones looked promising - a shorter losing line crosses fewer Red
     * decisions, so its clause carries fewer literals and is logically
     * stronger. Measured across harvest widths 8/24/48 it was within noise on
     * both throughput and repair difficulty, and costs extra search per
     * candidate, so it defaults off. The clause width is ~120 literals of 224
     * variables either way: the weakness is the encoding, not the selection. */
    this.harvestFails = opts.harvestFails || this.maxFails;
    this.verifyBudget = opts.verifyBudget || 400000;
    this.satBudget = opts.satBudget || 20000;

    var built = W.boardFromMoves(opts.moves || []);
    if (built.error) throw new Error(built.error);
    this.root = built.board;

    this.cells = W.freeCells(this.root);
    this.cellIndex = {};
    for (var i = 0; i < this.cells.length; i++) {
      this.cellIndex[this.cells[i].yt + ',' + this.cells[i].x] = i;
    }

    this.solver = new SAT.Solver();
    this.solver.ensureVars(this.cells.length * NM);

    this.iterations = 0;
    this.clausesAdded = 0;
    this.bestDepth = 0;
    this.history = [];          // counterexample depth per iteration
    this.candidate = null;
    this.lastFails = [];
    this.deepFail = null;
    this.status = 'running';
    this.detail = null;
    this.pinned = 0;

    this._encodeOneHot();
    this._encodeLocks(opts.locked || {});
    if (opts.seed) this._seedPhase(opts.seed);
  }

  Synth.prototype.varOf = function (cellIdx, markerIdx) {
    return cellIdx * NM + markerIdx;
  };

  Synth.prototype._encodeOneHot = function () {
    for (var c = 0; c < this.cells.length; c++) {
      var atLeast = [];
      for (var m = 0; m < NM; m++) atLeast.push(SAT.lit(this.varOf(c, m), false));
      this.solver.addClause(atLeast);
      for (var a = 0; a < NM; a++) {
        for (var b = a + 1; b < NM; b++) {
          this.solver.addClause([
            SAT.lit(this.varOf(c, a), true),
            SAT.lit(this.varOf(c, b), true)
          ]);
        }
      }
    }
  };

  Synth.prototype._encodeLocks = function (locked) {
    for (var key in locked) {
      var ci = this.cellIndex[key];
      if (ci == null) continue;
      var mi = W.MARKER_CHARS.indexOf(locked[key]);
      if (mi < 0) continue;
      this.solver.addClause([SAT.lit(this.varOf(ci, mi), false)]);
      this.pinned++;
    }
  };

  /* UNSAT here quantifies over completions of what the user pinned, not over
   * the language, so the two cases cannot share a message. Only the unpinned
   * case is a statement about the root itself. */
  Synth.prototype._unsatDetail = function () {
    if (this.pinned === 1) {
      return 'No completion of your 1 set marker wins this root. Erase it, or ' +
             'use Solve whole root to search the language without it.';
    }
    if (this.pinned) {
      return 'No completion of your ' + this.pinned + ' set markers wins this ' +
             'root. Erase some of them, or use Solve whole root to search the ' +
             'language without them.';
    }
    return 'No diagram in the strict language wins this root. Provisional: ' +
           'not an audited impossibility proof.';
  };

  /* Phase saving means the solver's first model is the seed diagram wherever
   * the seed is consistent - a free warm start. */
  Synth.prototype._seedPhase = function (seed) {
    for (var c = 0; c < this.cells.length; c++) {
      var cell = this.cells[c];
      var ch = seed[cell.yt] ? seed[cell.yt][cell.x] : null;
      var mi = W.MARKER_CHARS.indexOf(ch);
      for (var m = 0; m < NM; m++) this.solver.phase[this.varOf(c, m)] = (m === mi);
    }
  };

  Synth.prototype.diagramFromModel = function (model) {
    var d = W.syncDiagramToBoard(W.blankDiagram(), this.root).diagram;
    // every free cell is assigned below, so no hole survives into a candidate
    for (var c = 0; c < this.cells.length; c++) {
      var cell = this.cells[c];
      var ch = null;
      for (var m = 0; m < NM; m++) {
        if (model[this.varOf(c, m)]) { ch = W.MARKER_CHARS[m]; break; }
      }
      d = W.setCell(d, cell.yt, cell.x, ch || W.inertGlyph(cell.yt));
    }
    return d;
  };

  /* --------------------------------------------------------------- clauses */

  var MIAI_RANK = W.levelRank('miai');

  /*
   * Markers allowed at `cell` for this decision, as a 7-bit mask.
   *
   * role: 'chosen' | 'miai-pin' | 'other'
   * miaiOpen: two or more miai are exposed here, so the miai level is skipped
   *           regardless and any other cell may also be miai.
   *
   * The miai rule is the subtle part. Miai fires only when EXACTLY ONE miai is
   * exposed, so it is not monotone in the number of miai cells: a state with
   * two or more miai skips the level entirely and can even be a no-move state
   * while still containing miai markers. Treating "no move" as "every frontier
   * cell is inert" therefore bans the candidate's own miai markers, which makes
   * the clause satisfied by the very candidate it must exclude - the clause
   * becomes a no-op and the search stalls on one diagram forever.
   *
   * The fix keeps the per-cell form by pinning two of the exposed miai cells to
   * miai (which preserves "two or more", hence the skip) and letting every
   * other cell be miai as well.
   */
  function allowedMask(kind, rank, cell, role, miaiOpen) {
    var mask = 0;
    for (var m = 0; m < NM; m++) {
      var r = W.markerRank(W.MARKER_CHARS[m], cell.yt);
      var ok;
      if (role === 'miai-pin') ok = (r === MIAI_RANK);
      else if (kind === 'marker') ok = (role === 'chosen') ? (r === rank) : (r > rank);
      else if (kind === 'ambiguous') ok = (role === 'chosen') ? (r === rank) : (r >= rank);
      else ok = (r === Infinity); // no-move, with the miai escape below
      if (!ok && miaiOpen && role === 'other' && r === MIAI_RANK) ok = true;
      if (ok) mask |= (1 << m);
    }
    return mask;
  }

  /**
   * Turn one losing line into a clause. Returns an array of literals, or null
   * if the line carries no marker-dependent decision at all (which means the
   * root is lost no matter what the diagram says).
   */
  Synth.prototype.clauseForLine = function (diagram, line) {
    var decisions = W.decisionsAlongLine(this.root, diagram, line);
    var banned = {};   // cellIdx -> bitmask of markers ruled out
    var touched = false;

    for (var i = 0; i < decisions.length; i++) {
      var d = decisions[i];
      if (d.kind === 'red-win' || d.kind === 'block') continue;
      var rank = d.level ? W.levelRank(d.level) : Infinity;
      var chosen = d.kind === 'marker' ? [d.x] : (d.kind === 'ambiguous' ? d.candidates.slice(0, 2) : []);

      /*
       * Only levels below miai (and no-move) need the miai guard: urgent
       * preempts miai, and a decision AT the miai level already implies
       * exactly one is exposed.
       */
      var guard = (d.kind === 'no-move') || rank > MIAI_RANK;
      var pins = [];
      if (guard) {
        for (var g = 0; g < d.frontier.length; g++) {
          var gc = d.frontier[g];
          if (W.markerRank(diagram[gc.yt][gc.x], gc.yt) === MIAI_RANK) pins.push(gc.x);
        }
        pins = pins.length >= 2 ? pins.slice(0, 2) : [];
      }
      var miaiOpen = pins.length === 2;

      for (var f = 0; f < d.frontier.length; f++) {
        var cell = d.frontier[f];
        var ci = this.cellIndex[cell.yt + ',' + cell.x];
        if (ci == null) continue; // filled at the root: not a variable
        touched = true;
        var role = pins.indexOf(cell.x) >= 0 ? 'miai-pin'
                 : (chosen.indexOf(cell.x) >= 0 ? 'chosen' : 'other');
        var mask = allowedMask(d.kind, rank, cell, role, miaiOpen);
        banned[ci] = (banned[ci] || 0) | (~mask & 0x7f);
      }
    }
    if (!touched) return null;

    var lits = [];
    for (var key in banned) {
      var idx = +key;
      for (var m2 = 0; m2 < NM; m2++) {
        if (banned[idx] & (1 << m2)) lits.push(SAT.lit(this.varOf(idx, m2), false));
      }
    }
    return lits;
  };

  /* ------------------------------------------------------------ CEGIS step */

  /** One iteration. Returns a progress record; check `this.status`. */
  Synth.prototype.step = function () {
    if (this.status !== 'running') return this.progress();

    var verdict = this.solver.solve({ maxConflicts: this.satBudget });
    if (verdict === 'unsat') {
      this.status = 'unsat';
      this.detail = this._unsatDetail();
      return this.progress();
    }
    if (verdict === 'unknown') {
      // budget exhausted inside one solve; report and come back next tick
      return this.progress();
    }

    this.iterations++;
    var diagram = this.diagramFromModel(this.solver.model());
    this.candidate = diagram;

    var res = W.verify(this.root, diagram, {
      budget: this.verifyBudget,
      maxFails: this.harvestFails
    });

    if (res.fails.length > this.maxFails) {
      res.fails = res.fails
        .slice()
        .sort(function (a, b) { return a.line.length - b.line.length; })
        .slice(0, this.maxFails);
    }

    if (res.overflow) {
      this.status = 'error';
      this.detail = 'Verification exceeded its node budget on a candidate.';
      return this.progress();
    }

    if (res.win) {
      this.status = 'found';
      this.detail = 'Exhaustively verified against every Yellow reply.';
      this.lastFails = [];
      this.history.push(42);
      return this.progress();
    }

    this.lastFails = res.fails;
    /* The DFS-first counterexample is nearly always the same leftmost prefix,
     * so it looks frozen while the search runs. The DEEPEST one is the honest
     * progress signal: it grows as the candidate survives longer. */
    var deepest = 0;
    var deepFail = res.fails[0];
    for (var i = 0; i < res.fails.length; i++) {
      if (res.fails[i].line.length > deepest) { deepest = res.fails[i].line.length; deepFail = res.fails[i]; }
    }
    this.deepFail = deepFail;
    this.bestDepth = Math.max(this.bestDepth, deepest);
    this.history.push(deepest);

    var added = 0;
    for (var k = 0; k < res.fails.length; k++) {
      var lits = this.clauseForLine(diagram, res.fails[k].line);
      if (lits === null) {
        this.status = 'unsat';
        this.detail = 'A losing line contains no marker-dependent decision: ' +
                      'no diagram can rescue this root.';
        return this.progress();
      }
      /* addClause fails only by refuting the formula at level 0: either every
       * literal is already false there, or the unit it implies conflicts. That
       * is the same UNSAT as above, found one step earlier. */
      if (!this.solver.addClause(lits)) {
        this.status = 'unsat';
        this.detail = this._unsatDetail();
        return this.progress();
      }
      added++;
    }
    this.clausesAdded += added;
    return this.progress();
  };

  Synth.prototype.progress = function () {
    var deep = this.deepFail;
    return {
      status: this.status,
      detail: this.detail,
      iterations: this.iterations,
      clauses: this.clausesAdded,
      learnts: this.solver.learnts,
      conflicts: this.solver.conflicts,
      decisions: this.solver.decisions,
      vars: this.cells.length * NM,
      freeCells: this.cells.length,
      candidate: this.candidate,
      lastLine: this.lastFails.length && deep ? deep.line : null,
      lastReason: this.lastFails.length && deep ? deep.reason : null,
      bestDepth: this.bestDepth,
      // Only the tail is ever plotted. Sending the whole array would clone a
      // six-figure list on every progress post and throttle the search itself.
      history: this.history.length > 300 ? this.history.slice(-300) : this.history
    };
  };

  return { Synth: Synth };
});
