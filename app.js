/* WeakC4 Steady-State Lab - UI layer. All game logic lives in engine.js. */
'use strict';

(function () {
  var W = window.WeakC4;
  var COLS = W.COLS, ROWS = W.ROWS;
  var $ = function (id) { return document.getElementById(id); };

  /* One budget for every check. Measured over all 858 strict solution
   * artifacts: median 8.8 ms, p99 70 ms, max 111 ms (46,704 nodes) - three
   * orders of magnitude below this cap, and random diagrams at shallow roots
   * fail within a handful of nodes. A separate "full check" would never have
   * decided anything the live check could not. */
  var BUDGET = 5000000;
  var AUTO_DELAY = 200;

  /* Columns are 1-7 (matching rep digits); rows count from the bottom. The
   * board is drawn without a row gutter - numbers on both axes read as
   * coordinates and invite the wrong one. */
  function colName(x) { return String(x + 1); }

  /* '.' is the on-disk spelling of claimeven; on screen it is blank. '?' is
   * an undecided cell and IS drawn, because it is a thing you must resolve. */
  function glyphFor(ch) { return (ch === '.' || ch === ' ') ? '' : ch; }

  function holeCount() { return W.countHoles(S.diagram); }

  /* ------------------------------------------------------------------ state */

  var S = {
    moves: [],
    /* The marker layer is kept for ALL 42 cells, independent of the stones, so
     * adding and removing a stone in Position mode does not destroy whatever
     * marker was underneath. `diagram` is this layer with the root position
     * stamped over it, and is what every engine call sees. */
    markers: W.blankDiagram(),
    diagram: W.blankDiagram(),
    /* Markers first: the page is for building diagrams, and Play is where you
     * go to probe one you have already built. */
    mode: 'edit',                 // play | edit | setup
    yellowLine: [],
    brush: '!',
    stepMode: false,
    advancedTail: false,
    showGhost: true,              // draw the counterexample over the root
    verify: null,                 // last completed result, tagged with its key
    busy: null,                   // in-flight {key, kind, auto}
    progress: null,               // simplify progress
    note: null,                   // transient message for the verify card
    synth: null,
    dsat: null                    // heavy engine run in progress
  };

  function invalidateLine() {
    S.yellowLine = [];
    S.advancedTail = false;
  }

  function rootBoard() {
    var b = W.boardFromMoves(S.moves);
    return b.board || W.emptyBoard();
  }

  function redToMoveAtRoot() { return S.moves.length % 2 === 0; }

  /** Identity of the thing being verified: position plus diagram. */
  function currentKey() { return W.repString(S.moves) + '|' + S.diagram.join(''); }

  /** Displayed diagram = the persistent marker layer + the root stones. */
  function syncDiagram() {
    /* Every mutation funnels through here (setters, Mirror, Clear all), so it
     * is the one reliable place to retire a settled search preview. Hooking the
     * setters alone missed Mirror, which rewrites S.markers directly and left a
     * stale candidate replaying against a mirrored root. */
    dismissSettledPreview();
    S.diagram = W.syncDiagramToBoard(S.markers, rootBoard(), W.HOLE).diagram;
  }

  /** Adopt a whole diagram (import, share link, search result, simplify). */
  function setDiagram(d) {
    S.markers = d.map(function (row) {
      return row.split('').map(function (ch) {
        // a stone's cell carries no marker; reuse the hole as the placeholder
        return (ch === '1' || ch === '2') ? W.HOLE : (ch === ' ' ? '.' : ch);
      }).join('');
    });
    syncDiagram();
    invalidateLine();
  }

  function setMarker(yt, x, ch) {
    S.markers = W.setCell(S.markers, yt, x, ch);
    syncDiagram();
    invalidateLine();
  }

  function setMoves(moves) {
    /* A dsat run is about one root. Change the position under it and its
     * verdict becomes a statement about a board that is no longer on screen:
     * a FOUND diagram fails the in-page check and reads as an engine fault,
     * and an UNSAT reads as a claim about the position you are now looking at.
     * Neither is recoverable once printed, so cancel instead. */
    var interrupted = !!S.dsat && W.repString(moves) !== W.repString(S.moves);
    if (interrupted) stopDsat();
    S.moves = moves.slice();
    if (interrupted) {
      dsatSetStatus('Stopped: the position changed while it was solving.', 'warn');
    }
    syncDiagram();
    invalidateLine();
  }

  /* ------------------------------------------------------------ url sharing */

  function buildHash() {
    return '#r=' + W.repString(S.moves) + '&d=' + W.encodeDiagram(S.diagram);
  }

  var lastHash = null;

  function writeHash() {
    var h = buildHash();
    if (h === lastHash) return;
    lastHash = h;
    history.replaceState(null, '', h);
    $('share-url').value = location.href;
  }

  /*
   * A shared link is untrusted input, and this runs at boot. decodeURIComponent
   * throws URIError on any stray "%", which would abort the rest of the script:
   * no wire(), no first render(), a blank page and nothing in the console to
   * explain it. One bad character in a pasted link should cost the link, not
   * the page.
   */
  var badHash = false;

  function readHash() {
    var raw = location.hash.replace(/^#/, '');
    if (!raw) return false;
    var q = {};
    try {
      raw.split('&').forEach(function (kv) {
        var i = kv.indexOf('=');
        if (i > 0) q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
      });
    } catch (_) {
      badHash = true;
      return false;
    }

    var moves = null;
    if (q.r != null) {
      var p = W.parseRep(q.r);
      if (p.error) return false;
      var b = W.boardFromMoves(p.moves);
      if (b.error) return false;
      moves = p.moves;
    }
    var diagram = q.d ? W.decodeDiagram(q.d) : null;
    if (!moves && diagram) {
      var derived = W.movesFromDiagram(diagram);
      if (!derived.error) moves = derived.moves;
    }
    if (!moves && !diagram) return false;

    S.moves = moves || [];
    if (diagram) setDiagram(diagram);
    else syncDiagram();
    invalidateLine();
    lastHash = location.hash;
    return true;
  }

  /* --------------------------------------------------------------- helpers */

  function levelClass(ch, yt) {
    if (ch === W.HOLE) return 'hole';
    var lv = W.effectiveLevel(ch, yt);
    return lv ? 'lv-' + lv : 'quiet';
  }

  function markerName(ch) {
    if (ch === W.HOLE) return 'undecided';
    for (var i = 0; i < W.MARKERS.length; i++) if (W.MARKERS[i].ch === ch) return W.MARKERS[i].name;
    return ch;
  }

  function cellTitle(x, y, ch) {
    var base = W.cellName(x, y);
    if (ch == null) return base;
    var lv = W.effectiveLevel(ch, ROWS - 1 - y);
    return base + ', ' + markerName(ch) + (lv ? ', fires at ' + lv : '');
  }

  function colList(xs) { return xs.map(colName).join(', '); }

  function fmtDuration(ms) {
    return ms < 950 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s';
  }

  function describeDecision(d) {
    if (!d) return '';
    if (d.kind === 'red-win') return 'wins here';
    if (d.kind === 'block') return 'blocks Yellow';
    if (d.kind === 'marker') return d.level + ' at ' + W.cellName(d.x, d.y);
    if (d.kind === 'ambiguous') return 'ambiguous at ' + d.level + ', columns ' + colList(d.candidates);
    return 'no marker fires';
  }

  function yellowsOf(line) {
    var out = [];
    for (var i = 1; i < line.length; i += 2) out.push(line[i]);
    return out;
  }

  /* A line always alternates starting with Red, so the R/Y prefixes carry no
   * information. Bare column numbers also match the rep notation. */
  function lineText(line) {
    return line.map(function (m) { return colName(m - 1); }).join(' ');
  }

  /** The failing line of the current diagram, if we have a fresh verdict. */
  function freshFail() {
    var v = S.verify;
    if (!v || v.error || v.overflow || v.win) return null;
    if (v.key !== currentKey()) return null;
    return v.fail || null;
  }

  /** ply index per cell, so ghosts can be numbered. */
  function plyMap(trace) {
    var m = {};
    for (var i = 0; i < trace.length; i++) m[trace[i].x + ',' + trace[i].y] = trace[i].ply;
    return m;
  }

  function view() {
    var root = rootBoard();

    // While the search runs, preview the live candidate.
    if (S.synth && S.synth.p && S.synth.p.candidate) {
      var cand = S.synth.p.candidate;
      var cline = S.synth.p.lastLine;
      var r0 = W.replay(root, cand, cline ? yellowsOf(cline) : [], true);
      r0.decision = r0.toMove === 1 ? W.decide(r0.board, cand) : null;
      r0.diagram = cand;
      r0.root = root;
      r0.ghosted = true;      // stones past the root are hypothetical
      r0.plies = plyMap(r0.trace);
      r0.preview = true;
      return r0;
    }

    if (S.mode !== 'play') {
      // In Markers mode the live counterexample is drawn over the root as
      // ghosts, so a broken diagram shows you HOW it breaks while you edit.
      var f = (S.mode === 'edit' && S.showGhost) ? freshFail() : null;
      if (f && f.line && f.line.length) {
        var rg = W.replay(root, S.diagram, yellowsOf(f.line), true);
        rg.diagram = S.diagram;
        rg.root = root;
        rg.ghosted = true;
        rg.plies = plyMap(rg.trace);
        rg.decision = rg.toMove === 1 ? W.decide(rg.board, S.diagram) : null;
        rg.failReason = f.reason;
        return rg;
      }
      return {
        board: root, root: root, diagram: S.diagram, ghosted: false, plies: {},
        decision: redToMoveAtRoot() ? W.decide(root, S.diagram) : null,
        trace: [], terminal: null, pending: null,
        toMove: redToMoveAtRoot() ? 1 : 2, lastCell: null
      };
    }

    var autoRed = !S.stepMode || S.advancedTail;
    var r = W.replay(root, S.diagram, S.yellowLine, autoRed);
    r.diagram = S.diagram;
    r.root = root;
    r.ghosted = false;        // these moves really were played
    r.plies = plyMap(r.trace);
    r.decision = r.pending || (r.toMove === 1 ? W.decide(r.board, S.diagram) : null);
    return r;
  }

  /* ----------------------------------------------------------- board render */

  function columnActionable(v, x) {
    if (S.mode === 'edit' || v.preview) return false;
    if (W.colHeight(v.board, x) >= ROWS) return false;
    if (S.mode === 'setup') return true;
    return !v.terminal && v.toMove === 2;
  }

  function renderFiles(v) {
    var host = $('files');
    host.innerHTML = '';
    for (var x = 0; x < COLS; x++) {
      var b = document.createElement('button');
      b.textContent = colName(x);
      b.dataset.x = x;
      b.disabled = !columnActionable(v, x);
      b.title = S.mode === 'setup'
        ? 'Drop a ' + (redToMoveAtRoot() ? 'Red' : 'Yellow') + ' stone in column ' + colName(x)
        : 'Play Yellow in column ' + colName(x);
      host.appendChild(b);
    }
  }

  /*
   * Three layers per cell:
   *   .disc   the stone - solid for the root and for moves actually played,
   *           translucent ("ghost") for a hypothetical counterexample line
   *   .mk     the diagram marker, which stays visible ON TOP of any stone
   *           played after the root, since the marker still describes the cell
   *   .plyno  move number, on ghosts only
   * Root stones carry no marker, so they show a faint R/Y instead.
   */
  function renderGrid(v) {
    var host = $('grid');
    host.innerHTML = '';
    var diagram = v.diagram || S.diagram;
    var root = v.root || rootBoard();
    var winSet = {};
    if (v.terminal && v.terminal.cells) {
      v.terminal.cells.forEach(function (c) { winSet[c[0] + ',' + c[1]] = 1; });
    }
    var chosen = v.decision && v.decision.move ? v.decision.x : -1;
    var editable = S.mode === 'edit' && !v.preview;

    for (var yt = 0; yt < ROWS; yt++) {
      for (var x = 0; x < COLS; x++) {
        var y = ROWS - 1 - yt;
        var rootOcc = root[y][x];
        var occ = v.board[y][x];
        var cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.x = x;
        cell.dataset.yt = yt;

        var titleBits = [W.cellName(x, y)];

        if (occ) {
          var disc = document.createElement('span');
          disc.className = 'disc ' + (occ === 1 ? 'red' : 'yellow');
          if (!rootOcc && v.ghosted) {
            disc.classList.add('ghost');
            // During a search the markers are the thing that changes, so the
            // counterexample recedes further into the background.
            if (v.preview) disc.classList.add('fainter');
          }
          cell.appendChild(disc);
          cell.classList.add('has-disc');
          titleBits.push(occ === 1 ? 'Red' : 'Yellow');
          if (!rootOcc) {
            var ply = v.plies[x + ',' + y];
            if (ply) {
              var pn = document.createElement('span');
              pn.className = 'plyno';
              pn.textContent = String(ply);
              cell.appendChild(pn);
              titleBits.push((v.ghosted ? 'counterexample move ' : 'move ') + ply);
            }
          }
        }

        if (rootOcc) {
          titleBits.push('root position');
        } else {
          var ch = diagram[yt][x];
          var mk = document.createElement('span');
          mk.className = 'mk ' + levelClass(ch, yt);
          mk.textContent = glyphFor(ch);
          cell.appendChild(mk);
          titleBits.push(markerName(ch));
          var lv = W.effectiveLevel(ch, yt);
          if (lv) titleBits.push('fires at ' + lv);
          if (editable) cell.classList.add('clickable');
        }

        if (winSet[x + ',' + y]) cell.classList.add('winline');
        if (v.lastCell && v.lastCell[0] === x && v.lastCell[1] === y) cell.classList.add('last');

        // The diagram's own move is worth a ring; "where this column would
        // drop" is not, so it is shown only on hover, as a drop preview.
        if (!occ && x === chosen && W.colHeight(v.board, x) === y) cell.classList.add('chosen');

        // Clicking anywhere in a playable column drops into it.
        if (columnActionable(v, x)) cell.classList.add('clickable');

        cell.title = titleBits.join(', ');
        host.appendChild(cell);
      }
    }
  }

  /*
   * Hovering a column previews where the stone would land. This replaces a
   * permanent "frontier" ring on all seven columns, which was just noise: the
   * information is only wanted at the moment you are about to click.
   *
   * Applied by toggling classes on the existing nodes rather than re-rendering,
   * so it stays cheap during pointer movement.
   */
  var hoverCol = -1, lastView = null;

  /*
   * Which column a pointer is over, derived from its x position rather than
   * from the element underneath it. Hit-testing the cell elements loses the
   * gaps and the board padding, so sweeping across the blue background between
   * cells cleared the highlight and made it flicker.
   */
  function columnAt(el, clientX) {
    var r = el.getBoundingClientRect();
    if (r.width <= 0) return -1;
    var cs = getComputedStyle(el);
    var padL = parseFloat(cs.paddingLeft) || 0;
    var padR = parseFloat(cs.paddingRight) || 0;
    var gap = parseFloat(cs.columnGap) || 0;
    var inner = r.width - padL - padR;
    if (inner <= 0) return -1;
    var step = (inner + gap) / COLS;      // one cell plus one gap
    var col = Math.floor((clientX - r.left - padL) / step);
    return col < 0 ? 0 : (col >= COLS ? COLS - 1 : col);
  }

  function setHoverColumn(x) {
    if (x === hoverCol) return;
    hoverCol = x;
    paintHover();
  }

  function paintHover() {
    var grid = $('grid');
    var cells = grid.children;
    for (var i = 0; i < cells.length; i++) {
      cells[i].classList.remove('col-hover', 'drop-target', 'drop-red', 'drop-yellow');
    }
    var live = hoverCol >= 0 && lastView && columnActionable(lastView, hoverCol);
    // The gaps are part of the target, so the board itself carries the cursor.
    grid.style.cursor = live ? 'pointer' : '';
    if (!live) return;

    var y = W.colHeight(lastView.board, hoverCol);
    if (y >= ROWS) return;
    var player = S.mode === 'setup' ? (S.moves.length % 2 === 0 ? 1 : 2) : 2;

    for (var yt = 0; yt < ROWS; yt++) {
      var el = cells[yt * COLS + hoverCol];
      if (!el) continue;
      el.classList.add('col-hover');
      if (ROWS - 1 - yt === y) {
        el.classList.add('drop-target', player === 1 ? 'drop-red' : 'drop-yellow');
      }
    }
  }

  /*
   * The board carries a handful of ring treatments. Rather than expect anyone
   * to remember them, the legend names exactly the ones currently on screen.
   */
  function renderLegend(v) {
    var host = $('legend');
    host.innerHTML = '';
    var items = [];

    if (v.decision && v.decision.move) items.push(['chosen', 'the diagram move']);
    if (v.ghosted) items.push(['ghost', 'counterexample line, numbered']);
    if (v.terminal && v.terminal.cells) items.push(['winline', 'the winning four']);

    items.forEach(function (it) {
      var sp = document.createElement('span');
      sp.className = 'lg';
      var sw = document.createElement('span');
      sw.className = 'lg-swatch ' + it[0];
      var tx = document.createElement('span');
      tx.textContent = it[1];
      sp.appendChild(sw); sp.appendChild(tx);
      host.appendChild(sp);
    });
  }

  /* ----------------------------------------------------------------- status */

  function renderStatus(v) {
    var el = $('status');
    el.className = 'status';
    el.innerHTML = '';

    function pill(t, cls) {
      var s = document.createElement('span');
      s.className = 'pill' + (cls ? ' ' + cls : '');
      s.textContent = t;
      el.appendChild(s);
    }
    function text(t) {
      var s = document.createElement('span');
      s.textContent = t;
      el.appendChild(s);
    }

    if (v.preview) {
      var p = S.synth.p;
      if (p.status === 'found') {
        pill('verified candidate', 'ok');
        text('Candidate ' + p.iterations + '. Keep it to move it into the editor.');
      } else {
        pill(S.synth.running ? 'searching' : 'search stopped', S.synth.running ? 'warn' : '');
        text('Candidate ' + p.iterations + (p.lastLine ? ', with its deepest counterexample behind it.' : '.'));
      }
      return;
    }

    pill('ply ' + (S.moves.length + (v.trace ? v.trace.length : 0)));

    if (S.mode === 'setup') {
      if (!redToMoveAtRoot()) pill('odd ply', 'warn');
      text('Click a column to drop a ' + (redToMoveAtRoot() ? 'Red' : 'Yellow') + ' stone.');
      return;
    }

    if (S.mode === 'edit') {
      if (v.ghosted) {
        pill('counterexample', 'bad');
        text('Faded stones are a line that beats this diagram. ' +
             (FAIL_TEXT[v.failReason] || v.failReason || ''));
      } else {
        text('Painting ' + markerName(S.brush) + (glyphFor(S.brush) ? ' (' + S.brush + ')' : '') + '.');
        if (v.decision) {
          text('At the root Red plays ' +
               (v.decision.move ? 'column ' + colName(v.decision.x) : 'nothing') + ': ' + describeDecision(v.decision));
        }
      }
      return;
    }

    if (v.terminal) {
      var t = v.terminal;
      if (t.type === 'red-win') { pill('Red wins', 'ok'); text('The diagram delivered four-in-a-row on this line.'); }
      else if (t.type === 'yellow-win') { pill('Yellow wins', 'bad'); text('The diagram loses on this line.'); }
      else if (t.type === 'draw') { pill('Draw', 'bad'); text('A full board counts as a failure.'); }
      else {
        pill('No move', 'bad');
        text(t.kind === 'ambiguous'
          ? 'Two cells fire at ' + t.level + ' (columns ' + colList(t.candidates) + ').'
          : 'No marker fires at any level.');
      }
      return;
    }

    if (v.pending) {
      pill('Red to move', 'red');
      text('Plays column ' + (v.pending.move ? colName(v.pending.x) : '?') + ': ' + describeDecision(v.pending));
      return;
    }

    pill('Yellow to move', 'yellow');
    var last = v.trace.length ? v.trace[v.trace.length - 1] : null;
    text(last && last.decision
      ? 'Red played ' + colName(last.x) + ': ' + describeDecision(last.decision) + '.'
      : 'Click a column to play Yellow.');
  }

  /* ------------------------------------------------------------------- log */

  function renderLog(v) {
    var host = $('log');
    host.innerHTML = '';
    if (!v.trace || !v.trace.length) {
      host.innerHTML = '<div class="empty">No moves played from the root yet.</div>';
      return;
    }
    v.trace.forEach(function (t) {
      var row = document.createElement('div');
      var ply = document.createElement('span');
      ply.className = 'ply';
      ply.textContent = t.ply + '.';
      var mv = document.createElement('span');
      mv.textContent = (t.player === 1 ? 'R' : 'Y') + ' col ' + colName(t.x);
      var why = document.createElement('span');
      why.className = 'why';
      why.textContent = t.decision ? describeDecision(t.decision) : 'your choice';
      row.appendChild(ply); row.appendChild(mv); row.appendChild(why);
      host.appendChild(row);
    });
    host.scrollTop = host.scrollHeight;
  }

  /* --------------------------------------------------------------- palette */

  var paletteBrush = null;
  function renderPalette() {
    var host = $('palette');
    // Rebuilt only when the selection changes; a search repaints ~60x a second.
    if (paletteBrush === S.brush && host.childElementCount) return;
    paletteBrush = S.brush;
    host.innerHTML = '';
    W.MARKERS.forEach(function (m, i) {
      var b = document.createElement('button');
      b.setAttribute('aria-pressed', String(m.ch === S.brush));
      b.dataset.ch = m.ch;
      b.title = m.desc;
      var k = document.createElement('span');
      k.className = 'k lv-' + m.level;
      k.textContent = glyphFor(m.ch) || '·';
      if (!glyphFor(m.ch)) k.classList.add('faint');
      var n = document.createElement('span');
      n.className = 'n';
      n.textContent = m.name;
      var idx = document.createElement('span');
      idx.className = 'idx';
      idx.textContent = String(i + 1);
      b.appendChild(k); b.appendChild(n); b.appendChild(idx);
      host.appendChild(b);
    });
  }

  /* ------------------------------------------------------- verify / simplify */

  var worker = null, workerBroken = false, token = 0, autoTimer = null, scheduledKey = null;
  var watchdog = null;

  /*
   * A job that never reports back must not leave the bar on "Verifying..."
   * forever. On the first stall, throw the worker away and retry from a fresh
   * one; if even that stalls, finish the job on the main thread so a verdict
   * always appears.
   */
  function armWatchdog(ms) {
    if (watchdog) clearTimeout(watchdog);
    var mine = token;
    watchdog = setTimeout(function () {
      watchdog = null;
      if (!S.busy || mine !== token) return;       // already resolved
      var retried = S.busy.retried;
      killWorker(true);                            // discard the wedged worker
      if (!retried) { startVerify(true); return; }
      workerBroken = true;
      S.busy = { key: currentKey(), kind: 'verify', token: token, retried: true };
      runVerifySync(S.busy);
    }, ms);
  }

  /*
   * Cancel whatever is in flight. Bumping the token is enough to discard a
   * superseded reply, and the worker is kept alive because respawning it
   * re-fetches and re-parses engine.js - measured at several hundred ms, which
   * is far longer than the 8.8 ms median check it is running and enough to
   * make live checking feel broken.
   *
   * A simplify must be killed for real, though: it is long, and a queued
   * verify would otherwise sit behind it. The watchdog covers the remaining
   * case of a job that never reports back at all.
   */
  function killWorker(hard) {
    if (worker && (hard || (S.busy && S.busy.kind === 'simplify'))) {
      try { worker.terminate(); } catch (_) {}
      worker = null;
    }
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    token++;
    S.busy = null;
    S.progress = null;
  }

  function ensureWorker() {
    if (worker || workerBroken) return worker;
    try {
      worker = new Worker('verify.worker.js');
      worker.onmessage = function (e) { onWorkerMessage(e.data); };
      worker.onerror = function () {
        /* Fall back to the main thread and STAY there. Clearing S.auto here
         * also switched off re-checking, so the documented file:// fallback
         * produced exactly one verdict per session and then went quiet. */
        workerBroken = true;
        try { worker.terminate(); } catch (_) {}
        worker = null;
        if (S.busy) {
          var b = S.busy;
          S.busy = null;
          /* Only verify has a main-thread fallback. Simplify does not, so say
           * so rather than letting the button quietly pop back to idle as
           * though nothing had been asked of it. */
          if (b.kind === 'verify') runVerifySync(b);
          else S.note = { text: 'The worker stopped during Simplify. The diagram is unchanged.', cls: 'bad' };
        }
        render();
      };
    } catch (e) { workerBroken = true; worker = null; }
    return worker;
  }

  function startVerify(isRetry) {
    // The guard belongs HERE, not only in maybeAuto: the watchdog retry path
    // re-reads the diagram at fire time, so an edit that adds a hole while a
    // check is in flight would otherwise get a verdict eight seconds later.
    if (!redToMoveAtRoot() || holeCount()) return;
    killWorker();
    // Note deliberately not cleared here: an auto re-check fires immediately
    // after Simplify, and would otherwise wipe its result message.
    S.busy = { key: currentKey(), kind: 'verify', token: token, retried: !!isRetry };
    var w = ensureWorker();
    if (w) {
      w.postMessage({
        cmd: 'verify', rep: W.repString(S.moves), diagram: S.diagram,
        budget: BUDGET, token: token
      });
      armWatchdog(8000);
    } else {
      setTimeout(function () { runVerifySync(S.busy); }, 10);
    }
    render();
  }

  function runVerifySync(b) {
    if (!b) return;
    var t0 = performance.now();
    var res = W.verify(rootBoard(), S.diagram, { budget: BUDGET });
    res.type = 'verify';
    res.ms = performance.now() - t0;
    res.token = b.token;
    onWorkerMessage(res);
  }

  /* Simplify is the only slow operation here - one verification per cell, over
   * up to four passes - so it is the only one that needs a stop. */
  function startSimplify() {
    if (!redToMoveAtRoot()) return;
    killWorker();
    if (!ensureWorker()) {
      S.note = { text: 'Simplify needs a Web Worker. Serve the page over http, not from the file system.', cls: 'bad' };
      render();
      return;
    }
    S.busy = { key: currentKey(), kind: 'simplify', token: token };
    S.note = null;
    worker.postMessage({ cmd: 'simplify', rep: W.repString(S.moves), diagram: S.diagram, budget: BUDGET, token: token });
    render();
  }

  function onWorkerMessage(m) {
    if (m.token !== token) return;

    if (m.type === 'progress') { S.progress = m; renderSoon(); return; }

    if (m.type === 'error') {
      var errKey = S.busy ? S.busy.key : currentKey();
      S.busy = null;
      /* Record the failure against its key. Leaving S.verify untouched meant
       * maybeAuto never saw a result for this diagram, so it re-posted the same
       * doomed job forever. */
      S.verify = { state: 'done', key: errKey, error: m.error, nodes: 0, ms: 0 };
      S.note = { text: m.error, cls: 'bad' };
      render();
      return;
    }

    if (m.type === 'simplify') {
      var wasKey = S.busy && S.busy.key;
      S.busy = null;
      S.progress = null;
      if (!m.ok) { S.note = { text: m.error, cls: 'bad' }; render(); return; }
      if (wasKey === currentKey()) setDiagram(m.diagram);
      var one = m.removed === 1;
      S.note = m.removed
        ? { text: 'Cleared ' + m.removed + (one ? ' marker that was' : ' markers that were') +
                  ' not load-bearing (' + fmtDuration(m.ms) + ').', cls: 'ok' }
        : { text: 'Every marker is load-bearing; nothing to clear.', cls: '' };
      render();
      return;
    }

    // verify
    var key = S.busy ? S.busy.key : currentKey();
    S.busy = null;
    m.key = key;
    S.verify = m;
    render();
  }

  /** With auto on, re-check whenever the position or diagram changes. */
  function maybeAuto() {
    if (!redToMoveAtRoot() || holeCount()) {
      // Cancel any armed timer too. Leaving it running let a diagram that was
      // complete when the timer was set get verified 200 ms after a hole
      // appeared.
      clearTimeout(autoTimer);
      scheduledKey = null;
      return;
    }
    if (S.synth && S.synth.running) return;
    var k = currentKey();
    if (S.verify && S.verify.key === k) return;
    if (S.busy && S.busy.key === k) return;
    if (scheduledKey === k) return;
    scheduledKey = k;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(function () { scheduledKey = null; startVerify(); }, AUTO_DELAY);
  }

  var FAIL_TEXT = {
    YELLOW_WINS: 'Yellow reaches four-in-a-row.',
    DRAW: 'The board fills up. A draw counts as a failure.',
    NO_MOVE: 'No marker fires, so the diagram names no move.',
    AMBIGUOUS: 'Two or more cells fire at the same priority level.',
    ILLEGAL: 'The diagram selected a full column.',
    BUDGET: 'Search budget exhausted before a verdict.',
    ROOT_TERMINAL: 'This position already contains a four-in-a-row, so the game is over.'
  };

  function failSummary(f) {
    var why = FAIL_TEXT[f.reason] || f.reason;
    if (f.reason === 'AMBIGUOUS' && f.candidates) {
      why += ' Level ' + f.level + ', columns ' + colList(f.candidates) + '.';
    }
    return why;
  }

  /** One-line live verdict, fixed height, directly under the board. */
  function renderVerdictBar(v) {
    var el = $('verdictbar');
    el.className = 'verdictbar';
    el.innerHTML = '';

    function set(cls, mark, text) {
      el.classList.add(cls);
      var m = document.createElement('span');
      m.className = 'vb-mark';
      m.textContent = mark;
      var t = document.createElement('span');
      t.className = 'vb-text';
      t.textContent = text;
      el.appendChild(m); el.appendChild(t);
    }

    /*
     * While a search candidate is on the board the bar must describe THAT
     * diagram. Otherwise it keeps reporting the editor's (now unrelated)
     * verdict, which contradicts what is being shown - most visibly when the
     * search succeeds and the bar still reads as a failure.
     */
    if (v && v.preview) {
      var p = S.synth.p;
      if (p.status === 'found') {
        set('ok', '✓', 'Candidate ' + p.iterations + ' verified. Red forces a win against every Yellow reply.');
      } else if (p.status === 'unsat') {
        set('bad', '!', p.detail || 'No diagram exists in this language.');
      } else if (p.status === 'error') {
        set('warn', '!', p.detail || 'Search stopped.');
      } else {
        set(S.synth.running ? 'busy' : 'idle', S.synth.running ? '*' : '.',
            'Candidate ' + p.iterations + ': ' +
            (FAIL_TEXT[p.lastReason] || 'not a steady state yet'));
      }
      return;
    }

    if (!redToMoveAtRoot()) { set('idle', '.', 'Needs a Red-to-move root (even ply).'); return; }
    var holes = holeCount();
    if (holes) {
      set('idle', '?', holes === 1
          ? 'One cell is undecided. Fill it, or run auto-complete.'
          : holes + ' cells are undecided. Fill them, or run auto-complete.');
      return;
    }
    if (S.busy) {
      var prog = S.progress;
      set('busy', '*', S.busy.kind === 'simplify'
        ? 'Simplifying' + (prog ? ': cell ' + prog.done + '/' + prog.total + ', pass ' + prog.pass + ', ' + prog.removed + ' cleared' : '...')
        : 'Verifying every Yellow reply...');
      return;
    }

    var v = S.verify;
    if (!v) { set('idle', '.', 'Checking...'); return; }
    if (v.key !== currentKey()) { set('idle', '.', 'Re-checking...'); return; }
    if (v.error) { set('bad', '!', v.error); return; }
    if (v.overflow) { set('warn', '!', 'Too large to decide within the 5 million node search limit.'); return; }

    if (v.win) {
      set('ok', '✓', 'Verified. Red forces a win against every Yellow reply.');
    } else {
      set('bad', '✗', failSummary(v.fail || {}));
    }
  }

  function renderVerify(preview) {
    var slot = $('verdict');
    var simplifying = !!(S.busy && S.busy.kind === 'simplify');
    var btn = $('btn-simplify');

    var v = S.verify;
    var fresh = v && v.key === currentKey() && !v.error;

    /* A search candidate owns the board; its counterexample is reported by the
     * Search panel, so do not also show the editor's stale one here. */
    if (preview) {
      btn.textContent = 'Simplify';
      btn.classList.remove('primary');
      btn.disabled = true;
      btn.title = 'Finish or discard the search candidate first';
      $('verify-timing').textContent = 'showing a search candidate';
      slot.innerHTML = '';
      return;
    }

    btn.textContent = simplifying ? 'Stop' : 'Simplify';
    btn.classList.toggle('primary', simplifying);
    btn.disabled = simplifying
      ? false
      : (!(fresh && v.win) || !!S.busy || !!(S.synth && S.synth.running));
    btn.title = simplifying ? 'Stop simplifying'
      : (fresh && v.win ? 'Blank every marker that is not load-bearing'
                        : 'Only a verified diagram can be simplified');

    $('verify-timing').textContent = fresh && v.ms != null
      ? v.nodes.toLocaleString() + ' nodes, ' + v.ms.toFixed(0) + ' ms' + (workerBroken ? ', main thread' : '')
      : (workerBroken ? 'workers unavailable' : '');

    slot.innerHTML = '';

    if (S.note) {
      var n = document.createElement('div');
      n.className = 'msg ' + (S.note.cls || '');
      n.textContent = S.note.text;
      slot.appendChild(n);
    }

    if (!fresh || v.win || !v.fail) return;

    var f = v.fail;
    var box = document.createElement('div');
    box.className = 'verdict lose';
    add(box, 'detail', failSummary(f));
    if (f.line && f.line.length) {
      add(box, 'line', 'Losing line: ' + lineText(f.line));
      var load = document.createElement('button');
      load.textContent = 'Replay this line';
      load.style.marginTop = '8px';
      load.onclick = function () {
        S.yellowLine = yellowsOf(f.line);
        S.advancedTail = false;
        setMode('play');
      };
      box.appendChild(load);
    }
    slot.appendChild(box);

    function add(host, cls, txt) {
      var d = document.createElement('div');
      d.className = cls;
      d.textContent = txt;
      host.appendChild(d);
      return d;
    }
  }

  /* ----------------------------------------------------------------- search */

  var synthWorker = null;

  function startSynth() {
    if (!redToMoveAtRoot()) return;
    stopSynth();
    killWorker(true);
    /* Everything already written stays. Only empty cells are open, so the user
     * chooses the scope by erasing rather than by managing a separate set of
     * locks. */
    var locks = {};
    W.freeCells(rootBoard()).forEach(function (c) {
      var ch = S.markers[c.yt][c.x];
      if (ch !== W.HOLE) locks[c.yt + ',' + c.x] = ch;
    });
    /* Always warm-start. Every marker already set is a hard constraint now, so
     * the seed only biases the empty cells, and starting from what is on screen
     * is never worse than starting from nothing. */
    var payload = { cmd: 'start', moves: S.moves, seed: S.diagram, locked: locks };
    S.synth = { running: true, p: null };
    try {
      synthWorker = new Worker('synth.worker.js');
      synthWorker.onmessage = function (e) {
        var p = e.data;
        S.synth.p = p;
        if (p.status !== 'running') { S.synth.running = false; render(); }
        else renderSoon();   // coalesce to at most one repaint per frame
      };
      synthWorker.onerror = function (err) {
        S.synth = { running: false, p: { status: 'error', detail: 'worker failed: ' + (err.message || 'unknown') } };
        render();
      };
      synthWorker.postMessage(payload);
    } catch (e) {
      S.synth = { running: false, p: { status: 'error', detail: String(e.message || e) } };
    }
    render();
  }

  function stopSynth() {
    /* terminate() is the stop. Posting {cmd:'stop'} first looked polite, but
     * the message could never be delivered before the worker died. */
    if (synthWorker) {
      try { synthWorker.terminate(); } catch (_) {}
      synthWorker = null;
    }
    if (S.synth) S.synth.running = false;
  }

  /* A finished search keeps its candidate on the board so it can be kept or
   * discarded. Any board edit means the user is done looking at it. Without
   * this, edits landed on the hidden diagram and the board never moved. */
  function dismissSettledPreview() {
    if (S.synth && !S.synth.running) { stopSynth(); S.synth = null; }
  }

  /* Not "none in this language": this search is bounded by the markers the user
   * pinned, so only the detail line can say what the UNSAT actually covers. */
  var SYNTH_HEAD = {
    running: 'Searching...', found: 'Diagram found',
    unsat: 'UNSAT', error: 'Stopped'
  };

  /*
   * Measured difficulty by number of undecided cells on this root, so nobody
   * starts a search that cannot finish and waits on it. 4 free cells land in
   * ~14 candidates, 10 in ~120, 12 in ~1000; a cold 32-cell root ran 92,000
   * candidates without converging. The limit is how little each counterexample
   * clause rules out (~120 literals of 224), not throughput, so leaving it
   * running does not help.
   */
  function emptyCellCount() {
    return { empty: holeCount(), total: W.freeCells(rootBoard()).length };
  }

  function renderSynthScope() {
    var el = $('synth-scope');
    el.className = 'msg reserve';
    if (!redToMoveAtRoot()) { el.textContent = ''; return; }

    var c = emptyCellCount();
    if (c.empty === 0) {
      el.textContent = 'Nothing undecided. Right-click a cell to mark it for the solver.';
    } else if (c.empty <= 8) {
      el.textContent = c.empty + ' of ' + c.total + ' cells undecided. Well inside range.';
    } else if (c.empty <= 14) {
      el.textContent = c.empty + ' undecided. Expect hundreds to thousands of candidates.';
      el.classList.add('warn');
    } else {
      el.textContent = c.empty + ' undecided. Past what this can complete: ' +
        'decide more of them yourself first.';
      el.classList.add('bad');
    }
  }

  function renderSynth() {
    renderSynthScope();
    var body = $('synth-body');
    // A routine auto-verify must NOT block starting a search: startSynth
    // cancels it anyway. Only an explicit Simplify owns the worker.
    var simplifying = !!(S.busy && S.busy.kind === 'simplify');
    $('btn-synth').disabled = !redToMoveAtRoot() || !!(S.synth && S.synth.running) ||
                             simplifying || emptyCellCount().empty === 0 || !!S.dsat;
    $('btn-dsat').disabled = !redToMoveAtRoot() || !!S.dsat ||
                             !!(S.synth && S.synth.running) || simplifying;
    $('btn-dsat-stop').disabled = !S.dsat;
    if (!S.dsat && dsatStatusRep !== null && dsatStatusRep !== W.repString(S.moves)) {
      dsatSetStatus('');
    }
    if (!S.dsat && !$('dsat-status').textContent.trim()) {
      var look = dsatOutlook();
      var note = $('dsat-note');
      note.className = 'msg' + (look.cls ? ' ' + look.cls : '');
      note.textContent = look.text || 'the native engine, ~1 MB on first use';
    }
    $('btn-synth-stop').disabled = !(S.synth && S.synth.running);

    var p = S.synth && S.synth.p;
    if (!p) {
      body.classList.add('hidden');
      $('btn-synth-accept').disabled = true;
      $('btn-synth-discard').disabled = true;
      return;
    }
    body.classList.remove('hidden');

    /* A stopped or UNSAT run still holds its last, failing candidate. It can
     * be discarded, but keeping it would adopt a diagram that does not win. */
    var settled = !!(p.candidate && !S.synth.running);
    $('btn-synth-accept').disabled = !(settled && p.status === 'found');
    $('btn-synth-discard').disabled = !settled;

    var stats = [
      ['status', SYNTH_HEAD[p.status] || p.status],
      ['candidates', (p.iterations || 0).toLocaleString()],
      ['clauses', (p.clauses || 0).toLocaleString()],
      ['conflicts', (p.conflicts || 0).toLocaleString()],
      ['variables', (p.vars || 0) + ' (' + (p.freeCells || 0) + ' cells)'],
      ['elapsed', ((p.ms || 0) / 1000).toFixed(1) + ' s']
    ];
    var host = $('synth-stats');
    host.innerHTML = '';
    stats.forEach(function (kv) {
      var k = document.createElement('span'); k.className = 'sk'; k.textContent = kv[0];
      var val = document.createElement('span'); val.className = 'sv'; val.textContent = kv[1];
      host.appendChild(k); host.appendChild(val);
    });

    renderSpark(p.history || []);
    $('synth-depth').textContent = p.bestDepth ? 'deepest ' + p.bestDepth + ' ply' : '';

    var ce = $('synth-ce');
    ce.innerHTML = '';
    if (p.status === 'found') {
      ce.className = 'ce ok';
      ce.textContent = p.detail || 'Exhaustively verified.';
    } else if (p.status === 'unsat' || p.status === 'error') {
      ce.className = 'ce bad';
      ce.textContent = p.detail || '';
    } else if (p.lastLine) {
      ce.className = 'ce';
      var h = document.createElement('div');
      h.className = 'ce-head';
      h.textContent = 'Deepest counterexample: ' + (FAIL_TEXT[p.lastReason] || p.lastReason);
      var l = document.createElement('div');
      l.className = 'ce-line';
      l.textContent = lineText(p.lastLine);
      ce.appendChild(h); ce.appendChild(l);
    } else {
      ce.className = 'ce';
      ce.textContent = 'Building the first candidate...';
    }
  }

  function renderSpark(history) {
    var svg = $('synth-spark');
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!history.length) return;
    var data = history.slice(-300);
    var max = Math.max(6, Math.max.apply(null, data));
    var w = 300, h = 46;
    var step = data.length > 1 ? w / (data.length - 1) : w;
    var pts = data.map(function (d, i) {
      return (i * step).toFixed(1) + ',' + (h - (d / max) * (h - 3)).toFixed(1);
    }).join(' ');
    var poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', pts);
    poly.setAttribute('class', 'sparkline');
    svg.appendChild(poly);
  }

  /* ---------------------------------------------------- heavy engine (wasm) */

  /*
   * dsat.cpp plus CaDiCaL, compiled to WebAssembly. The same source the native
   * research pipeline runs on, so it cannot drift from it, and it measures
   * within ~1.2x of it. See engine/PROVENANCE.json for what this was built from.
   *
   * It decides a whole ROOT rather than filling cells: either a complete
   * diagram or no diagram exists. It ignores whatever is on the board, because
   * dsat solves from the position, not from a partial diagram. Loaded on
   * demand, since it is a megabyte.
   */
  /* One worker per run, terminated when it finishes.
   *
   * The worker cannot be reused: each solve needs a fresh Module, and a Module
   * that grew to a gigabyte does not give that memory back when it is dropped.
   * Consecutive heavy solves in one worker accumulated about 1.1 GB each until
   * allocation failed. Terminating is the only release that does not depend on
   * the garbage collector noticing.
   *
   * The megabyte download is kept here instead, so a new worker still starts
   * without refetching. */
  var dsatWorker = null;
  var dsatBinary = null;

  /* The root the message on screen is about. A verdict outlives the run that
   * produced it, and the position can move on underneath it by half a dozen
   * routes, so the message carries its own root rather than every one of those
   * routes having to remember to clear it. */
  var dsatStatusRep = null;

  function dsatSetStatus(text, cls) {
    var el = $('dsat-status');
    el.className = 'msg reserve' + (cls ? ' ' + cls : '');
    el.textContent = text || '';
    dsatStatusRep = text ? W.repString(S.moves) : null;
  }

  /*
   * The engine is silent while it builds the search space, and that is the
   * longest phase by far: measured at 6.8 s for a ply-14 root and worse below
   * it, with nothing printed until it completes. A static line through that
   * window is indistinguishable from a hang, so every non-terminal phase
   * carries its own running clock. Terminal messages call dsatEndPhase first,
   * or the ticker would paint the verdict back over with stale phase text.
   */
  var dsatTick = null;

  function dsatPaintPhase() {
    if (!S.dsat || !S.dsat.phase) return;
    var s = Math.round((Date.now() - S.dsat.t0) / 1000);
    dsatSetStatus(S.dsat.phase + (s >= 1 ? '  ' + s + 's' : ''), S.dsat.phaseCls);
  }

  function dsatSetPhase(text, cls) {
    if (!S.dsat) return;
    S.dsat.phase = text;
    S.dsat.phaseCls = cls || '';
    dsatPaintPhase();
    if (!dsatTick) dsatTick = setInterval(dsatPaintPhase, 1000);
  }

  function dsatEndPhase() {
    if (dsatTick) { clearInterval(dsatTick); dsatTick = null; }
    if (S.dsat) S.dsat.phase = null;
  }

  /*
    * How hard this root is likely to be, by ply. Envelope size grows sharply as
    * the root gets shallower, and ply 12 and below is exactly the frontier that
    * is still open natively, so the browser will not close it either.
    */
  function dsatOutlook() {
    if (!redToMoveAtRoot()) return { text: '', cls: '' };
    var ply = S.moves.length;
    if (ply >= 16) return { text: 'ply ' + ply + ': usually seconds.', cls: '' };
    if (ply >= 14) return { text: 'ply ' + ply + ': can take minutes.', cls: 'warn' };
    return {
      text: 'ply ' + ply + ': this is the open research frontier and probably will not finish.',
      cls: 'bad'
    };
  }

  function startDsat() {
    if (!redToMoveAtRoot() || S.dsat) return;
    var ply = S.moves.length;
    S.dsat = { running: true, t0: Date.now(), rep: W.repString(S.moves),
               cutPly: Math.min(COLS * ROWS, ply + 16) };
    dsatSetStatus(dsatBinary ? 'Starting the engine...' : 'Fetching the engine...');
    render();

    try {
      dsatWorker = new Worker('dsat.worker.js');
    } catch (e) {
      S.dsat = null;
      dsatSetStatus('Could not start the engine: ' + (e.message || e), 'bad');
      render();
      return;
    }
    dsatWorker.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'status') onDsatStatus(m.json);
      else if (m.type === 'loading') onDsatLoading(m);
      else if (m.type === 'binary') dsatBinary = m.buffer;
      else if (m.type === 'done') finishDsat(m.ms);
    };
    dsatWorker.onerror = function (err) {
      dsatSetStatus('Engine failed to load: ' + (err.message || 'unknown'), 'bad');
      stopDsat();
      render();
    };

    dsatWorker.postMessage({
      cmd: 'solve',
      binary: dsatBinary,
      rep: W.repString(S.moves),
      // dsat_campaign.py's measured sweet spot: encode plies [root, root+16).
      cutPly: S.dsat.cutPly,
      budget: 30000000,
      expand: 300000,
      maxIters: 100000,
      maxSeconds: 180
    });
  }

  function onDsatLoading(m) {
    if (!S.dsat) return;
    if (m.phase === 'download') {
      var mb = (m.loaded / 1048576).toFixed(1);
      dsatSetPhase(m.total
        ? 'Fetching the engine: ' + Math.round(100 * m.loaded / m.total) + '% of ' +
          (m.total / 1048576).toFixed(1) + ' MB'
        : 'Fetching the engine: ' + mb + ' MB');
    } else if (m.phase === 'compile') {
      dsatSetPhase('Compiling the engine...');
    } else if (m.phase === 'run') {
      // Held only until the first ENCODING line arrives, a few hundred ms in.
      dsatSetPhase('Mapping every position through ply ' + S.dsat.cutPly + '...');
    }
  }

  /* 2,940,517 -> "2.9M". Exact counts in the millions are noise at a glance. */
  function compact(n) {
    n = n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'k';
    return String(n);
  }

  function dsatMeter(frac) {
    var box = $('dsat-meter');
    if (frac == null) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    $('dsat-meter-fill').style.width = Math.min(100, Math.max(0, frac * 100)).toFixed(1) + '%';
  }

  function onDsatStatus(j) {
    if (!S.dsat || !j) return;
    // A late message from a run whose root has moved on says nothing about
    // what is on screen now.
    if (S.dsat.rep != null && S.dsat.rep !== W.repString(S.moves)) return;
    var secs = ((Date.now() - S.dsat.t0) / 1000).toFixed(0);

    if (/^(FOUND|UNSAT|TIME_LIMIT|OVERFLOW|ERROR|FATAL)$/.test(j.status)) {
      dsatEndPhase();
      dsatMeter(null);
    }

    /* The envelope build, previously a silent stretch of unknown length. The
     * gauge is budget spent, not work done: the engine has no denominator for
     * how much is left, so calling it progress would be a lie. */
    if (j.status === 'ENCODING') {
      dsatMeter(j.budget ? j.states / j.budget : null);
      dsatSetPhase('Mapping positions: ' + compact(j.states) + ' of a ' +
                   compact(j.budget) + ' budget');
      return;
    }
    /* A SAT search has no fraction-complete, so there is no bar to draw. It is
     * not opaque though: a conflict is a branch proven impossible and a learnt
     * clause is a fact derived from one, so the counts say how much ground has
     * been ruled out. Named in plain terms because 'conflicts' reads as an
     * error to anyone who has not written a SAT solver. */
    if (j.status === 'SOLVING') {
      dsatMeter(null);
      /* Only monotone counters. 'redundant' is the learnt clauses currently
       * held, not the number ever derived, so it falls whenever CaDiCaL reduces
       * its database and reads as the search going backwards. 'fixed' counts
       * SAT variables settled for good, which is not the same thing as board
       * cells: the formula carries reachability and circuit variables too. */
      var parts = [];
      if (j.conflicts) parts.push(j.conflicts.toLocaleString() + ' dead ends ruled out');
      if (j.fixed > 1) parts.push(j.fixed.toLocaleString() + ' variables settled');
      dsatSetPhase(parts.length ? 'Searching: ' + parts.join(', ') : 'Searching');
      return;
    }

    if (j.status === 'FOUND' && Array.isArray(j.diagram)) {
      // Never take the engine's word for it: re-verify with the in-page
      // verifier, which is independently pinned to the Python reference.
      var d = j.diagram.map(function (r) { return String(r).replace(/ /g, '.'); });
      var check = W.verify(rootBoard(), d, { budget: 5000000 });
      S.dsat.found = d;
      S.dsat.verified = check.win;
      dsatSetStatus(check.win
        ? 'Found a diagram in ' + j.iterations + ' iterations, independently verified. Keeping it.'
        : 'The engine reported a diagram the in-page verifier rejects. Not keeping it.',
        check.win ? 'ok' : 'bad');
      if (check.win) setDiagram(d);
      return;
    }
    if (j.status === 'UNSAT') {
      dsatSetStatus('UNSAT: no diagram exists for this root in the strict language. ' +
                    'Sound, but not independently audited.', 'warn');
      return;
    }
    if (j.status === 'TIME_LIMIT') {
      dsatSetStatus('Stopped at the 3 minute limit' +
                    (j.phase === 'encoding'
                      ? ' while still mapping positions (' + compact(j.states) + ' so far).'
                      : ' with no verdict.') +
                    ' Roots this shallow are past what a browser can finish. ' +
                    'Deeper roots, with more moves played, are dramatically cheaper.', 'warn');
      return;
    }
    if (j.status === 'OVERFLOW') {
      dsatSetStatus('Ran past the state budget (' +
                    (j.states || 0).toLocaleString() + ' positions). Too large for the browser; ' +
                    'try a root with more moves played.', 'warn');
      return;
    }
    if (j.status === 'ERROR' || j.status === 'FATAL') {
      /* dsat dies on envelope overflow with advice about flags the page does
       * not expose. Reachable here only on a root too big for the budget, so
       * say the thing a browser user can act on. */
      var err = j.error || 'The engine stopped with an error.';
      if (/envelope overflow/i.test(err)) {
        err = 'This root maps out more positions than the browser can hold. ' +
              'Try one with more moves played.';
      }
      dsatSetStatus(err, 'bad');
      return;
    }
    if (j.status === 'RUNNING') {
      dsatSetPhase('Searching: round ' + (j.iteration || 0) + ', ' +
                   (j.clauses || 0).toLocaleString() + ' clauses');
      return;
    }
    if (j.status === 'HYBRID_ENCODED' || j.status === 'LOADED') {
      // Enumeration is done, so the budget gauge has nothing left to say. It
      // would otherwise sit frozen at its last value until the first SOLVING
      // line arrived, reading as a stalled bar.
      dsatMeter(null);
      dsatSetPhase('Mapped ' + (j.states || 0).toLocaleString() + ' positions into ' +
                   (j.clauses || 0).toLocaleString() + ' clauses. Searching...');
    }
  }

  function finishDsat(ms) {
    if (!S.dsat) return;
    var el = $('dsat-status');
    if (!el.textContent || /^Searching|^Encoded|^Fetching|^Compiling|^Starting/.test(el.textContent)) {
      dsatSetStatus('Stopped after ' + (ms / 1000).toFixed(1) + ' s with no verdict.', 'warn');
    }
    stopDsat();
    render();
  }

  /* Always terminates. dsat has no interruption point, so killing the worker
   * is the only way to stop a run, and it is also the only way to hand back the
   * gigabyte the Module may be holding. The binary is cached on the page, so
   * this costs nothing but a few milliseconds of instantiation next time. */
  function stopDsat() {
    dsatEndPhase();
    dsatMeter(null);
    if (dsatWorker) { try { dsatWorker.terminate(); } catch (_) {} dsatWorker = null; }
    S.dsat = null;
  }

  /* ------------------------------------------------------------------ i/o */

  function setIoNote(msg, cls) {
    var el = $('io-note');
    el.className = 'msg reserve' + (cls ? ' ' + cls : '');
    el.textContent = msg || '';
  }

  function doImport() {
    var text = $('io-text').value;
    if (!text.trim()) { setIoNote('Nothing to load.', 'bad'); return; }
    var r = W.parseImport(text);
    if (r.error) { setIoNote(r.error, 'bad'); return; }

    if (r.moves) S.moves = r.moves;
    var sync = W.syncDiagramToBoard(r.diagram || S.diagram, rootBoard());
    setDiagram(sync.diagram);
    S.note = null;

    var bits = [];
    if (r.moves) bits.push('position (' + r.moves.length + ' ply)');
    if (r.diagram) bits.push('diagram');
    if (sync.changed) bits.push(sync.changed + ' cell(s) reconciled with the position');
    (r.warnings || []).forEach(function (w) { bits.push(w); });
    setIoNote('Loaded ' + bits.join(', ') + '.', 'ok');
    render();
  }

  /* --------------------------------------------------------------- render */

  function render() {
    var v = view();
    lastView = v;
    var busy = !!(S.synth && S.synth.running);

    $('mode-play').setAttribute('aria-pressed', String(S.mode === 'play'));
    $('mode-edit').setAttribute('aria-pressed', String(S.mode === 'edit'));
    $('mode-setup').setAttribute('aria-pressed', String(S.mode === 'setup'));

    renderFiles(v);
    renderGrid(v);
    paintHover();               // the grid was rebuilt, so re-apply it
    renderVerdictBar(v);
    renderLegend(v);
    renderStatus(v);
    renderLog(v);
    renderPalette();
    renderVerify(!!v.preview);
    renderSynth();

    $('btn-undo').disabled = busy || (S.mode === 'setup' ? S.moves.length === 0 : S.yellowLine.length === 0);
    $('btn-root').disabled = busy || S.mode !== 'play' || (S.yellowLine.length === 0 && !S.advancedTail);
    $('btn-step-red').disabled = !v.pending;
    $('chk-step').checked = S.stepMode;
    $('chk-ghost').checked = S.showGhost;

    if (document.activeElement !== $('rep-input')) $('rep-input').value = W.repString(S.moves);
    var repNote = $('rep-note');
    repNote.className = 'msg reserve';
    var built = W.boardFromMoves(S.moves);
    if (built.winner) {
      repNote.textContent = (built.winner === 1 ? 'Red' : 'Yellow') +
        ' already has four in a row, so this position is finished.';
      repNote.classList.add('bad');
    } else if (S.moves.length && !redToMoveAtRoot()) {
      repNote.textContent = 'Odd ply. Yellow is to move, so this is not a steady-state root.';
      repNote.classList.add('warn');
    } else repNote.textContent = '';

    writeHash();
    maybeAuto();
  }

  function setMode(m) { dismissSettledPreview(); S.mode = m; render(); }

  /* The search can post faster than the display refreshes. Rendering more than
   * once per frame is pure waste, so coalesce onto requestAnimationFrame. */
  var rafPending = false;
  function renderSoon() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () { rafPending = false; render(); });
  }

  /* ------------------------------------------------------------- handlers */

  function playColumn(x) {
    if (S.synth && S.synth.running) return;
    dismissSettledPreview();
    var v = view();
    if (S.mode === 'setup') {
      if (W.colHeight(rootBoard(), x) >= ROWS) return;
      setMoves(S.moves.concat([x + 1]));
      render();
      return;
    }
    if (S.mode !== 'play' || v.terminal || v.toMove !== 2) return;
    if (W.colHeight(v.board, x) >= ROWS) return;
    S.yellowLine = S.yellowLine.concat([x + 1]);
    S.advancedTail = false;
    render();
  }

  /* Left click paints the selected marker, right click erases to empty. The
   * old right-click behaviour cycled through the palette, which looked like
   * the two buttons placed arbitrarily different markers. */
  function paintCell(yt, x, erase) {
    if (S.synth && S.synth.running) return;
    dismissSettledPreview();
    if (rootBoard()[ROWS - 1 - yt][x] !== 0) return;
    var ch = erase ? W.HOLE : S.brush;
    setMarker(yt, x, ch);
    S.note = null;
    render();
  }

  function fillAll(fn) {
    var m = [];
    for (var yt = 0; yt < ROWS; yt++) {
      var row = '';
      for (var x = 0; x < COLS; x++) row += fn(yt, x);
      m.push(row);
    }
    S.markers = m;
    syncDiagram();
    invalidateLine();
    S.note = null;
    render();
  }

  function wire() {
    $('grid').addEventListener('click', function (e) {
      if (S.synth && S.synth.running) return;
      var cell = e.target.closest('.cell');
      // Shift-click locks in every mode: it collides with nothing, and
      // requiring Markers mode made locking undiscoverable.
      // Painting needs a specific cell; playing only needs the column, so the
      // gaps between cells drop into the column they sit in.
      if (S.mode === 'edit') { if (cell) paintCell(+cell.dataset.yt, +cell.dataset.x, false); return; }
      playColumn(columnAt(this, e.clientX));
    });

    // Gaps and padding belong to the column they sit in, so the highlight
    // survives a sweep across the board rather than blinking between cells.
    $('grid').addEventListener('mousemove', function (e) {
      setHoverColumn(columnAt(this, e.clientX));
    });
    $('grid').addEventListener('mouseleave', function () { setHoverColumn(-1); });

    $('files').addEventListener('mousemove', function (e) {
      setHoverColumn(columnAt(this, e.clientX));
    });
    $('files').addEventListener('mouseleave', function () { setHoverColumn(-1); });

    $('grid').addEventListener('contextmenu', function (e) {
      var cell = e.target.closest('.cell');
      if (!cell || S.mode !== 'edit' || (S.synth && S.synth.running)) return;
      e.preventDefault();
      paintCell(+cell.dataset.yt, +cell.dataset.x, true);
    });

    $('files').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (b && !b.disabled) playColumn(+b.dataset.x);
    });

    $('palette').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      S.brush = b.dataset.ch;
      if (S.mode !== 'edit') S.mode = 'edit';   // the palette is also the way in
      render();
    });

    $('mode-play').onclick = function () { setMode('play'); };
    $('mode-edit').onclick = function () { setMode('edit'); };
    $('mode-setup').onclick = function () { setMode('setup'); };

    $('btn-undo').onclick = function () {
      dismissSettledPreview();
      if (S.mode === 'setup') { if (S.moves.length) setMoves(S.moves.slice(0, -1)); }
      else if (S.yellowLine.length) { S.yellowLine = S.yellowLine.slice(0, -1); S.advancedTail = false; }
      render();
    };

    $('btn-root').onclick = function () {
      dismissSettledPreview();
      S.yellowLine = []; S.advancedTail = false; render();
    };
    $('btn-step-red').onclick = function () { S.advancedTail = true; render(); };
    $('chk-step').onchange = function () { S.stepMode = this.checked; S.advancedTail = false; render(); };
    $('chk-ghost').onchange = function () { S.showGhost = this.checked; render(); };

    $('btn-simplify').onclick = function () {
      if (S.busy && S.busy.kind === 'simplify') {
        killWorker();
        S.note = { text: 'Simplify stopped; the diagram is unchanged.', cls: '' };
        render();
      } else startSimplify();
    };

    $('btn-synth').onclick = startSynth;
    $('btn-synth-stop').onclick = function () { stopSynth(); render(); };
    $('btn-synth-accept').onclick = function () {
      var p = S.synth && S.synth.p;
      if (!p || !p.candidate) return;
      stopSynth();                 // release the worker and its clause database
      setDiagram(p.candidate);
      S.synth = null;
      setMode('edit');
    };
    $('btn-synth-discard').onclick = function () { stopSynth(); S.synth = null; render(); };

    $('btn-dsat').onclick = startDsat;
    $('btn-dsat-stop').onclick = function () {
      stopDsat();
      dsatSetStatus('Stopped.');
      render();
    };

    /* Clear to claimeven, not to undecided. A cleared board should be a
     * complete diagram you can verify and edit from, and '.' renders blank on
     * every row. Filling with '?' meant clearing cost a second pass to put
     * claimeven back everywhere, and left the board in a state the verifier
     * refuses and auto-complete calls too wide to finish. Marking individual
     * cells undecided is what right-click is for. */
    $('btn-fill-blank').onclick = function () { fillAll(function () { return '.'; }); };

    /* The inverse of right-clicking a cell: resolve every undecided cell back
     * to blank without touching a marker you actually chose. Without it the
     * only way to get rid of leftover ? was Clear all, which throws away the
     * work too. */
    $('btn-clear-holes').onclick = function () {
      fillAll(function (yt, x) {
        var ch = S.markers[yt][x];
        return ch === W.HOLE ? '.' : ch;
      });
    };

    /* Worth having on a deep root, where it is a real workflow: at ply 30 only
     * about twelve cells are empty, which is inside what auto-complete can
     * finish. On a shallow root the panel will say it is too wide, which is
     * the honest answer rather than a reason to hide the button. */
    $('btn-undecide-all').onclick = function () { fillAll(function () { return W.HOLE; }); };


    $('btn-mirror').onclick = function () {
      S.markers = S.markers.map(function (row) { return row.split('').reverse().join(''); });
      S.moves = S.moves.map(function (m) { return COLS + 1 - m; });
      syncDiagram();
      invalidateLine();
      render();
    };

    $('btn-clear-pos').onclick = function () { setMoves([]); render(); };

    $('rep-input').addEventListener('change', function () {
      var p = W.parseRep(this.value);
      var note = $('rep-note');
      if (p.error) { note.className = 'msg reserve bad'; note.textContent = p.error; return; }
      var b = W.boardFromMoves(p.moves);
      if (b.error) { note.className = 'msg reserve bad'; note.textContent = b.error; return; }
      setMoves(p.moves);
      render();
    });

    $('btn-import').onclick = doImport;

    $('btn-export-json').onclick = function () {
      /*
       * "semantics" is a provenance gate, not decoration: the research repo's
       * audit tooling raises on anything that is not "strict-original" and
       * filters records on it. A diagram with holes is not a diagram, so
       * claiming that value would admit a non-artifact into the audit chain.
       */
      var holes = holeCount();
      $('io-text').value = '{\n  "rep": ' + JSON.stringify(W.repString(S.moves)) +
        ',\n  "diagram": [\n' +
        S.diagram.map(function (r) { return '    ' + JSON.stringify(r); }).join(',\n') +
        '\n  ],\n  "semantics": ' + JSON.stringify(holes ? 'incomplete' : 'strict-original') +
        (holes ? ',\n  "undecided": ' + holes : '') + '\n}';
      setIoNote(holes
        ? 'Exported as "incomplete": ' + holes + ' cell(s) undecided, so this is not a certifiable artifact.'
        : 'Artifact JSON written above.', holes ? 'warn' : 'ok');
    };

    $('btn-export-grid').onclick = function () {
      $('io-text').value = W.diagramText(S.diagram);
      setIoNote('Diagram grid written above. Empty cells are written as a dot on disk.', 'ok');
    };

    $('btn-copy-link').onclick = function () {
      var done = function () {
        var b = $('btn-copy-link'), old = b.textContent;
        b.textContent = 'Copied';
        setTimeout(function () { b.textContent = old; }, 1200);
      };
      var fallback = function () {
        var i = $('share-url');
        i.focus(); i.select();
        try { document.execCommand('copy'); done(); } catch (e) {}
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(location.href).then(done, fallback);
      } else fallback();
    };

    document.addEventListener('keydown', function (e) {
      if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key >= '1' && e.key <= '7') {
        var i = +e.key - 1;
        if (S.mode === 'edit') { S.brush = W.MARKER_CHARS[i]; render(); }
        else playColumn(i);
        e.preventDefault();
      } else if (e.key === 'Backspace' || e.key === 'u') {
        if (!$('btn-undo').disabled) $('btn-undo').click();
        e.preventDefault();
      }
    });

    window.addEventListener('hashchange', function () {
      if (location.hash === lastHash) return;
      if (readHash()) render();
    });
  }

  /* ------------------------------------------------------------------ boot */

  if (!readHash()) {
    /* Node 323 from 2swap's published graph, so the page ships no unpublished
     * data of our own. Every marker that is not load-bearing is blanked. */
    S.moves = W.parseRep('44444221').moves;
    setDiagram(['...@...', '...1...', '+@.2=..', '+!.1=..', '+1-2=..', '22-1=..']);
    // Falling back to the default board is the recovery, but say why, or a
    // truncated link just looks like the page ignored it.
    if (badHash) S.note = { text: 'That link is damaged; showing the default board instead.', cls: 'bad' };
  }

  wire();
  render();
})();
