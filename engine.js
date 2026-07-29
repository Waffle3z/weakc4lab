/*
 * WeakC4 steady-state engine (browser / worker / node).
 *
 * Semantics are 2swap's original SteadyState.cpp, and only those. An
 * applicable priority level that exposes two or more moves is an INVALID
 * diagram state (SteadyState.cpp returns -6, "Red failed to select a move"):
 * uniqueness is a requirement of the language, not a tie-break. The published
 * browser viewer silently resolves such ties left-to-right, which accepts
 * diagrams the language does not.
 *
 * Valid claimeven and claimodd cells share ONE priority level. Miai is ignored
 * unless exactly one miai is exposed.
 *
 * Conventions (must match the Python/C++ tooling):
 *   board[y][x], y = 0 is the BOTTOM row, x = 0 is column 'a'. 0/1/2 =
 *     empty / red / yellow.
 *   diagram[yt][x], yt = 0 is the TOP row, i.e. yt = ROWS - 1 - y.
 *   rep = the move sequence as column digits '1'..'7', red plays the even
 *     indices. An even-length rep leaves Red to move, which is what a
 *     steady-state diagram assumes.
 */
;(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.WeakC4 = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var COLS = 7;
  var ROWS = 6;
  var COL_LETTERS = 'abcdefg';

  /* ---------------------------------------------------------------- markers */

  // Palette order is the priority order.
  var MARKERS = [
    { ch: '!', name: 'urgent',    level: 'urgent', desc: 'Play here first.' },
    { ch: '@', name: 'miai',      level: 'miai',   desc: 'Paired cell; fires only when exactly one miai is exposed.' },
    { ch: '.', name: 'claimeven', level: 'claim',  desc: 'Fires on even rows (2, 4, 6). Inert on odd rows.' },
    { ch: '|', name: 'claimodd',  level: 'claim',  desc: 'Fires on odd rows (1, 3, 5). Inert on even rows.' },
    { ch: '+', name: 'plus',      level: 'plus',   desc: 'Low priority.' },
    { ch: '=', name: 'equal',     level: 'equal',  desc: 'Lower priority.' },
    { ch: '-', name: 'minus',     level: 'minus',  desc: 'Lowest priority.' }
  ];

  var MARKER_CHARS = MARKERS.map(function (m) { return m.ch; });

  /*
   * '?' means "not decided yet". It is a tool-level symbol, NOT an eighth
   * marker category: the language has seven, and every one of them means
   * something, so there is no value that reads as "unset". Auto-complete fills
   * exactly these cells. A diagram containing one is incomplete and has no
   * verification verdict. It never fires, so playing through a diagram with
   * holes treats them as inert.
   */
  var HOLE = '?';

  function countHoles(diagram) {
    var n = 0;
    for (var yt = 0; yt < ROWS; yt++) {
      for (var x = 0; x < COLS; x++) if (diagram[yt][x] === HOLE) n++;
    }
    return n;
  }

  var LEVELS = ['urgent', 'miai', 'claim', 'plus', 'equal', 'minus'];

  function levelRank(level) {
    var i = LEVELS.indexOf(level);
    return i < 0 ? Infinity : i;
  }

  /*
   * The level at which a glyph actually fires, given its row, or null when the
   * cell is inert. A claimeven glyph on an odd row (and a claimodd glyph on an
   * even row) is the seventh marker category: opposite-parity inert. It can
   * never be selected, which is why omitting it would make an UNSAT claim
   * incomplete.
   */
  function effectiveLevel(ch, yt) {
    switch (ch) {
      case '!': return 'urgent';
      case '@': return 'miai';
      case ' ':
      case '.': return (yt % 2 === 0) ? 'claim' : null;
      case '|': return (yt % 2 === 1) ? 'claim' : null;
      case '+': return 'plus';
      case '=': return 'equal';
      case '-': return 'minus';
      default:  return null; // '1', '2', anything else
    }
  }

  /** Priority rank of a glyph at a row; Infinity means it never fires. */
  function markerRank(ch, yt) {
    return levelRank(effectiveLevel(ch, yt));
  }

  /** The single glyph that is inert at this row, used as a neutral filler. */
  function inertGlyph(yt) {
    return yt % 2 === 0 ? '|' : '.';
  }

  /* ------------------------------------------------------- board mechanics */
  /* Deliberately a plain independent reimplementation, mirroring verify.py.  */

  function emptyBoard() {
    var b = [];
    for (var y = 0; y < ROWS; y++) b.push([0, 0, 0, 0, 0, 0, 0]);
    return b;
  }

  function cloneBoard(b) {
    var n = [];
    for (var y = 0; y < ROWS; y++) n.push(b[y].slice());
    return n;
  }

  function colHeight(b, x) {
    var h = 0;
    for (var y = 0; y < ROWS; y++) {
      if (b[y][x] !== 0) h++;
      else break;
    }
    return h;
  }

  function makesFour(b, x, y, player) {
    var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (var i = 0; i < dirs.length; i++) {
      var dx = dirs[i][0], dy = dirs[i][1], cnt = 1;
      for (var s = 1; s >= -1; s -= 2) {
        var nx = x + dx * s, ny = y + dy * s;
        while (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS && b[ny][nx] === player) {
          cnt++; nx += dx * s; ny += dy * s;
        }
      }
      if (cnt >= 4) return true;
    }
    return false;
  }

  function boardFull(b) {
    for (var x = 0; x < COLS; x++) if (b[ROWS - 1][x] === 0) return false;
    return true;
  }

  function bkey(b) {
    var s = '';
    for (var y = 0; y < ROWS; y++) {
      var r = b[y];
      for (var x = 0; x < COLS; x++) s += r[x];
    }
    return s;
  }

  /** Any four-in-a-row on the board, as {player, cells}, or null. */
  function findFour(b) {
    for (var y = 0; y < ROWS; y++) {
      for (var x = 0; x < COLS; x++) {
        if (!b[y][x]) continue;
        var cells = winningCells(b, x, y);
        if (cells) return { player: b[y][x], cells: cells };
      }
    }
    return null;
  }

  /** Winning four-in-a-row cells through (x, y), or null. For highlighting. */
  function winningCells(b, x, y) {
    var player = b[y][x];
    if (!player) return null;
    var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (var i = 0; i < dirs.length; i++) {
      var dx = dirs[i][0], dy = dirs[i][1];
      var cells = [[x, y]];
      for (var s = 1; s >= -1; s -= 2) {
        var nx = x + dx * s, ny = y + dy * s;
        while (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS && b[ny][nx] === player) {
          cells.push([nx, ny]); nx += dx * s; ny += dy * s;
        }
      }
      if (cells.length >= 4) return cells;
    }
    return null;
  }

  /* ------------------------------------------------------------ rep parsing */

  function parseRep(rep) {
    var moves = [];
    var s = String(rep == null ? '' : rep);
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c >= '1' && c <= '7') moves.push(c.charCodeAt(0) - 48);
      else if (c === ' ' || c === ',' || c === '-' || c === '\n' || c === '\t' || c === '\r') continue;
      else return { moves: null, error: 'bad character "' + c + '" in rep (expected column digits 1-7)' };
    }
    return { moves: moves, error: null };
  }

  /*
   * "winner" is the player holding a four-in-a-row on the FINISHED board, or
   * 0. A steady-state root must have none: the game would already be over, and
   * asking the agent to win from there is meaningless. An earlier version only
   * looked for a win before the last ply, so a four delivered by the final move
   * went unnoticed and such a root verified as a win in a single node.
   */
  function boardFromMoves(moves) {
    var b = emptyBoard();
    for (var i = 0; i < moves.length; i++) {
      var x = moves[i] - 1;
      var player = (i % 2) + 1;
      var h = colHeight(b, x);
      if (h >= ROWS) {
        return { board: null, error: 'column ' + (x + 1) + ' overflows at ply ' + (i + 1) };
      }
      b[h][x] = player;
    }
    var four = findFour(b);
    return { board: b, error: null, winner: four ? four.player : 0 };
  }

  function repString(moves) {
    return moves.join('');
  }

  /* Columns are numbered 1-7 to match the move digits in a rep and the
   * "column 4" wording in the project notes. Rows count 1-6 from the bottom. */
  function cellName(x, y) {
    return 'column ' + (x + 1) + ', row ' + (y + 1);
  }

  /* ------------------------------------------------------------- the agent */

  /*
   * Returns a decision record:
   *   { move: 1..7 | 0, kind, level, x, y, yt, glyph, candidates, frontier }
   *   kind: 'red-win' | 'block' | 'marker' | 'ambiguous' | 'no-move'
   *
   * `frontier` lists the playable cells as {x, y, yt}, which the synthesizer
   * needs in order to turn a decision into a clause.
   */
  function decide(board, diagram) {
    var heights = new Array(COLS);
    var frontier = [];
    for (var x = 0; x < COLS; x++) {
      heights[x] = colHeight(board, x);
      if (heights[x] < ROWS) frontier.push({ x: x, y: heights[x], yt: ROWS - 1 - heights[x] });
    }

    function wins(cx, player) {
      var y = heights[cx];
      if (y >= ROWS) return false;
      board[y][cx] = player;
      var w = makesFour(board, cx, y, player);
      board[y][cx] = 0;
      return w;
    }

    // 1. take an immediate win, 2. block Yellow's immediate win.
    for (var player = 1; player <= 2; player++) {
      for (var cx = 0; cx < COLS; cx++) {
        if (heights[cx] < ROWS && wins(cx, player)) {
          return {
            move: cx + 1,
            kind: player === 1 ? 'red-win' : 'block',
            level: null, x: cx, y: heights[cx], yt: ROWS - 1 - heights[cx],
            glyph: null, candidates: [], frontier: frontier
          };
        }
      }
    }

    // 3. walk the priority ladder.
    for (var li = 0; li < LEVELS.length; li++) {
      var level = LEVELS[li];
      var valid = [];
      for (var c = 0; c < COLS; c++) {
        var y = heights[c];
        if (y >= ROWS) continue;
        if (effectiveLevel(diagram[ROWS - 1 - y][c], ROWS - 1 - y) === level) valid.push(c);
      }
      if (level === 'miai') {
        // Ignored entirely unless exactly one miai is exposed.
        if (valid.length === 1) return marker(valid[0], level, valid);
        continue;
      }
      if (valid.length === 1) return marker(valid[0], level, valid);
      if (valid.length > 1) {
        return {
          move: 0, kind: 'ambiguous', level: level,
          x: null, y: null, yt: null, glyph: null, candidates: valid, frontier: frontier
        };
      }
    }
    return {
      move: 0, kind: 'no-move', level: null, x: null, y: null, yt: null,
      glyph: null, candidates: [], frontier: frontier
    };

    function marker(cx, level, valid) {
      var yy = heights[cx], yyt = ROWS - 1 - yy;
      return {
        move: cx + 1, kind: 'marker', level: level,
        x: cx, y: yy, yt: yyt, glyph: diagram[yyt][cx],
        candidates: valid.slice(), frontier: frontier
      };
    }
  }

  /* -------------------------------------------------- exhaustive verifier */

  /*
   * Red follows the diagram; Yellow tries EVERY legal reply. Red must reach
   * four-in-a-row on every line: a draw, a Yellow win, or a diagram that fails
   * to name a unique move all count as failures.
   *
   * opts.maxFails > 1 keeps searching after the first failure, which the
   * synthesizer uses to harvest several independent counterexamples per
   * candidate. Only positions where Red survived EVERY reply are memoised.
   */
  function verify(rootBoard, diagram, opts) {
    opts = opts || {};
    var budget = opts.budget || 5000000;
    var maxFails = opts.maxFails || 1;
    var board = cloneBoard(rootBoard);
    var memo = new Set();
    var path = [];
    var nodes = 0;
    var overflow = false;
    var fails = [];

    // A finished position has no verdict to give. Without this, decide() finds
    // Red some immediate win and verify() reports success on a board where the
    // opponent already has four in a row.
    var four = findFour(board);
    if (four) {
      return {
        win: false, overflow: false, nodes: 0, positions: 0,
        fail: { reason: 'ROOT_TERMINAL', line: [], player: four.player },
        fails: [{ reason: 'ROOT_TERMINAL', line: [], player: four.player }]
      };
    }

    function record(reason, extra) {
      var out = { reason: reason, line: path.slice() };
      if (extra) for (var k in extra) out[k] = extra[k];
      fails.push(out);
    }

    function stop() { return overflow || fails.length >= maxFails; }

    /** true if Red survives every continuation from here. */
    function redNode() {
      var key = bkey(board);
      if (memo.has(key)) return true;
      if (++nodes > budget) { overflow = true; record('BUDGET'); return false; }

      var d = decide(board, diagram);
      if (!d.move) {
        record(d.kind === 'ambiguous' ? 'AMBIGUOUS' : 'NO_MOVE', { level: d.level, candidates: d.candidates });
        return false;
      }
      var x = d.move - 1;
      var ry = colHeight(board, x);
      if (ry >= ROWS) { record('ILLEGAL', { col: d.move }); return false; }

      board[ry][x] = 1;
      path.push(d.move);
      var survived = true;
      try {
        if (makesFour(board, x, ry, 1)) { memo.add(key); return true; }
        if (boardFull(board)) { record('DRAW'); return false; }

        for (var yx = 0; yx < COLS; yx++) {
          var yy = colHeight(board, yx);
          if (yy >= ROWS) continue;
          board[yy][yx] = 2;
          path.push(yx + 1);
          try {
            if (makesFour(board, yx, yy, 2)) { record('YELLOW_WINS'); survived = false; }
            else if (boardFull(board)) { record('DRAW'); survived = false; }
            else if (!redNode()) survived = false;
          } finally {
            path.pop();
            board[yy][yx] = 0;
          }
          if (!survived && stop()) return false;
        }
      } finally {
        path.pop();
        board[ry][x] = 0;
      }
      if (survived) memo.add(key);
      return survived;
    }

    redNode();
    return {
      win: fails.length === 0 && !overflow,
      overflow: overflow,
      fail: fails[0] || null,
      fails: fails,
      nodes: nodes,
      positions: memo.size
    };
  }

  /* -------------------------------------------------------------- replay */

  /*
   * Play the line out from the root. Red's moves are always DERIVED from the
   * diagram, so only Yellow's choices need to be stored; a diagram edit
   * automatically re-derives every Red reply.
   *
   * autoRed=false stops just before the tail Red move so the pending decision
   * can be inspected.
   */
  function replay(rootBoard, diagram, yellowLine, autoRed) {
    var board = cloneBoard(rootBoard);
    var trace = [];
    var yi = 0;
    var terminal = null;
    var pending = null;
    var toMove = 1;
    var lastCell = null;

    function place(x, player, info) {
      var y = colHeight(board, x);
      if (y >= ROWS) return false;
      board[y][x] = player;
      lastCell = [x, y];
      info.x = x; info.y = y; info.player = player; info.ply = trace.length + 1;
      trace.push(info);
      if (makesFour(board, x, y, player)) {
        terminal = { type: player === 1 ? 'red-win' : 'yellow-win', cells: winningCells(board, x, y) };
      } else if (boardFull(board)) {
        terminal = { type: 'draw' };
      }
      return true;
    }

    while (!terminal) {
      if (toMove === 1) {
        var d = decide(board, diagram);
        if (!d.move) {
          terminal = { type: 'no-move', kind: d.kind, level: d.level, candidates: d.candidates };
          break;
        }
        if (!autoRed && yi >= yellowLine.length) { pending = d; break; }
        place(d.move - 1, 1, { decision: d });
        toMove = 2;
      } else {
        if (yi >= yellowLine.length) break;
        var yc = yellowLine[yi++];
        if (!place(yc - 1, 2, { decision: null })) break;
        toMove = 1;
      }
    }

    return {
      board: board, trace: trace, terminal: terminal, pending: pending,
      toMove: terminal ? null : (pending ? 1 : toMove),
      lastCell: lastCell, consumed: yi
    };
  }

  /** Red decision states along a fixed line, for clause extraction. */
  function decisionsAlongLine(rootBoard, diagram, line) {
    var board = cloneBoard(rootBoard);
    var out = [];
    for (var i = 0; i < line.length; i++) {
      var x = line[i] - 1;
      var player = (i % 2) + 1;
      if (player === 1) out.push(decide(board, diagram));
      var y = colHeight(board, x);
      if (y >= ROWS) break;
      board[y][x] = player;
    }
    // A line can end at a Red decision that produced no move at all. It can
    // also end in a Yellow win or a full board, where no decision happens.
    if (line.length % 2 === 0 && !findFour(board) && !boardFull(board)) {
      out.push(decide(board, diagram));
    }
    return out;
  }

  /* --------------------------------------------------------- diagram utils */

  /** Every cell undecided. */
  function blankDiagram() {
    var d = [];
    for (var yt = 0; yt < ROWS; yt++) d.push('???????');
    return d;
  }

  function setCell(diagram, yt, x, ch) {
    var row = diagram[yt];
    var next = diagram.slice();
    next[yt] = row.substring(0, x) + ch + row.substring(x + 1);
    return next;
  }

  /** Rewrite occupied cells to '1'/'2' and give freed cells a default marker. */
  function syncDiagramToBoard(diagram, board, fillCh) {
    fillCh = fillCh || HOLE;
    var out = [];
    var changed = 0;
    for (var yt = 0; yt < ROWS; yt++) {
      var y = ROWS - 1 - yt;
      var row = '';
      for (var x = 0; x < COLS; x++) {
        var occ = board[y][x];
        var cur = (diagram[yt] || '')[x] || fillCh;
        var want;
        if (occ === 1) want = '1';
        else if (occ === 2) want = '2';
        else want = (cur === '1' || cur === '2') ? fillCh : (cur === ' ' ? '.' : cur);
        if (want !== cur) changed++;
        row += want;
      }
      out.push(row);
    }
    return { diagram: out, changed: changed };
  }

  function diagramText(diagram) {
    return diagram.join('\n');
  }

  /** Root-empty cells, in top-left-to-bottom-right order: the search variables. */
  function freeCells(board) {
    var out = [];
    for (var yt = 0; yt < ROWS; yt++) {
      for (var x = 0; x < COLS; x++) {
        if (board[ROWS - 1 - yt][x] === 0) out.push({ x: x, yt: yt, y: ROWS - 1 - yt });
      }
    }
    return out;
  }

  /* ------------------------------------------------------------- url codec */

  var URL_ENC = { '!': 'u', '@': 'm', '.': 'c', ' ': 'c', '|': 'o', '+': 'p', '=': 'q', '-': 'n',
                  '?': 'w', '1': 'R', '2': 'Y' };
  var URL_DEC = { u: '!', m: '@', c: '.', o: '|', p: '+', q: '=', n: '-', w: '?', R: '1', Y: '2' };

  function encodeDiagram(diagram) {
    var s = '';
    for (var yt = 0; yt < ROWS; yt++) {
      for (var x = 0; x < COLS; x++) s += URL_ENC[diagram[yt][x]] || 'c';
    }
    return s;
  }

  function decodeDiagram(code) {
    if (!code || code.length !== ROWS * COLS) return null;
    var d = [];
    for (var yt = 0; yt < ROWS; yt++) {
      var row = '';
      for (var x = 0; x < COLS; x++) {
        var ch = URL_DEC[code[yt * COLS + x]];
        if (!ch) return null;
        row += ch;
      }
      d.push(row);
    }
    return d;
  }

  /* -------------------------------------------------------------- importer */

  /*
   * Accepts, in any combination and order:
   *   - a JSON artifact such as exact_strict_solutions/node_1234.json
   *     ({"rep": "...", "diagram": [...6 rows...]})
   *   - a bare rep digit string
   *   - 6 lines of 7 diagram characters
   */
  function parseImport(text) {
    var warnings = [];
    var rep = null, diagram = null;

    var trimmed = text.trim();
    if (trimmed.startsWith('{')) {
      try {
        var obj = JSON.parse(trimmed);
        if (typeof obj.rep === 'string') rep = obj.rep;
        /* Present but malformed is an error, not an absence. Skipping it
         * quietly let a truncated artifact import as "loaded" while the
         * diagram half was dropped and the previous one silently kept. */
        if (obj.diagram != null) {
          if (!Array.isArray(obj.diagram) || obj.diagram.length !== ROWS) {
            return { error: '"diagram" must be ' + ROWS + ' rows, got ' +
                     (Array.isArray(obj.diagram) ? obj.diagram.length + ' rows' : typeof obj.diagram) };
          }
          diagram = obj.diagram.slice();
        }
        if (obj.semantics && obj.semantics !== 'strict-original') {
          warnings.push('artifact semantics: "' + obj.semantics + '"');
        }
        if (rep === null && diagram === null) return { error: 'JSON had no "rep" or "diagram" field' };
        return finish();
      } catch (e) {
        return { error: 'not valid JSON: ' + e.message };
      }
    }

    /*
     * Grid rows must NOT be trimmed. On disk claimeven is written as a space,
     * so "   1   " is a legitimate row; stripping it leaves "1", which then
     * looks like a move sequence and silently replaces the root position.
     * Only JSON-array decoration (quotes, trailing comma) is removed.
     */
    var lines = text.split(/\r?\n/);
    var gridLines = [];
    var GRID_ROW = /^[!@.|?+=\-12 ]*$/;
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i].replace(/\r$/, '');
      var quoted = raw.match(/^\s*"(.*)"\s*,?\s*$/);
      var line = quoted ? quoted[1] : raw;

      if (line.length === 0) continue;                 // blank line, or trailing newline
      var trimmed = line.trim();

      /* A 7-character run of digits is ambiguous: "1211212" is both a legal
       * seven-move rep and a legal row of stones. Defer it rather than guess
       * here; a real grid brings five more rows with it, and the count below
       * settles which it was. */
      if (/^[1-7]{2,}$/.test(trimmed) && trimmed.length !== COLS && trimmed === line) {
        rep = trimmed;
        continue;
      }
      if (line.length <= COLS && GRID_ROW.test(line)) {
        gridLines.push(line.length < COLS ? line + ' '.repeat(COLS - line.length) : line);
      } else if (/^[1-7]+$/.test(trimmed)) {
        rep = trimmed;
      } else {
        return { error: 'unrecognised line: "' + line + '"' };
      }
    }
    if (gridLines.length === ROWS) diagram = gridLines;
    else if (gridLines.length === 1 && rep === null && /^[1-7]{2,}$/.test(gridLines[0].trim())) {
      // The deferred ambiguous case: one line, all digits, no other rows. A
      // diagram never arrives one row at a time, so it was a rep.
      rep = gridLines[0].trim();
    }
    else if (gridLines.length > 0) return { error: 'found ' + gridLines.length + ' diagram rows, need ' + ROWS };
    if (rep === null && diagram === null) return { error: 'nothing recognisable found' };
    return finish();

    function finish() {
      var moves = null;
      if (rep !== null) {
        var p = parseRep(rep);
        if (p.error) return { error: p.error };
        var built = boardFromMoves(p.moves);
        if (built.error) return { error: built.error };
        if (built.winner) {
          return { error: 'that move sequence already ends in a four-in-a-row' };
        }
        moves = p.moves;
      }
      if (diagram) {
        for (var k = 0; k < ROWS; k++) {
          var r = String(diagram[k]);
          if (r.length !== COLS) return { error: 'diagram row ' + (k + 1) + ' is ' + r.length + ' chars, need ' + COLS };
          /*
           * Validate the alphabet. Without this, an unknown glyph behaves as an
           * unlabelled inert marker on screen while encodeDiagram rewrites it to
           * claimeven in the share link, so the page and the link it hands you
           * disagree about whether the diagram wins.
           */
          var badAt = r.search(/[^!@.|?+=\-12 ]/);
          if (badAt >= 0) {
            return { error: 'diagram row ' + (k + 1) + ' has an unknown character "' + r[badAt] + '"' };
          }
          diagram[k] = r.replace(/ /g, '.');
        }
      }
      // A diagram alone still determines the position, via its '1'/'2' cells.
      if (moves === null && diagram) {
        var derived = movesFromDiagram(diagram);
        if (derived.error) return { error: derived.error };
        moves = derived.moves;
        warnings.push('no rep given; reconstructed a legal move order from the diagram stones');
      }
      return { moves: moves, diagram: diagram, warnings: warnings, error: null };
    }
  }

  /*
   * Build some legal alternating move order producing exactly the stones drawn
   * in the diagram. The order is not the original game, but the resulting
   * position is identical, which is all the agent depends on.
   */
  function movesFromDiagram(diagram) {
    var target = emptyBoard();
    var counts = [0, 0, 0];
    for (var yt = 0; yt < ROWS; yt++) {
      for (var x = 0; x < COLS; x++) {
        var ch = diagram[yt][x];
        if (ch === '1' || ch === '2') {
          var v = ch === '1' ? 1 : 2;
          target[ROWS - 1 - yt][x] = v;
          counts[v]++;
        }
      }
    }
    for (var x2 = 0; x2 < COLS; x2++) {
      var seenEmpty = false;
      for (var y = 0; y < ROWS; y++) {
        if (target[y][x2] === 0) seenEmpty = true;
        else if (seenEmpty) return { error: 'floating stone in column ' + (x2 + 1) };
      }
    }
    if (counts[1] !== counts[2]) {
      return { error: 'diagram has ' + counts[1] + ' red and ' + counts[2] + ' yellow stones; a Red-to-move root needs them equal' };
    }
    var heights = [];
    for (var x3 = 0; x3 < COLS; x3++) heights.push(colHeight(target, x3));
    var total = counts[1] + counts[2];

    /*
     * Interleave the seven column stacks into one alternating sequence.
     * Greedy fails (a=[R,Y], b=[Y,R] forces taking b first), so this is a DFS
     * over the fill vector with dead states memoised. The state is just the
     * per-column fill count, since the player to move is its sum.
     */
    var placed = [0, 0, 0, 0, 0, 0, 0];
    var moves = [];
    var dead = new Set();

    function search(i) {
      if (i === total) return true;
      var key = placed.join(',');
      if (dead.has(key)) return false;
      var want = (i % 2) + 1;
      for (var c = 0; c < COLS; c++) {
        if (placed[c] < heights[c] && target[placed[c]][c] === want) {
          placed[c]++;
          moves.push(c + 1);
          if (search(i + 1)) return true;
          moves.pop();
          placed[c]--;
        }
      }
      dead.add(key);
      return false;
    }

    if (!search(0)) return { error: 'diagram stones are not reachable by alternating play' };
    return { moves: moves, error: null };
  }

  return {
    COLS: COLS, ROWS: ROWS,
    MARKERS: MARKERS, MARKER_CHARS: MARKER_CHARS,
    levelRank: levelRank, effectiveLevel: effectiveLevel, markerRank: markerRank,
    inertGlyph: inertGlyph,
    emptyBoard: emptyBoard, colHeight: colHeight, bkey: bkey, cellName: cellName,
    HOLE: HOLE, countHoles: countHoles,
    parseRep: parseRep, boardFromMoves: boardFromMoves, repString: repString,
    decide: decide, verify: verify, replay: replay, decisionsAlongLine: decisionsAlongLine,
    blankDiagram: blankDiagram, setCell: setCell,
    syncDiagramToBoard: syncDiagramToBoard, diagramText: diagramText, freeCells: freeCells,
    encodeDiagram: encodeDiagram, decodeDiagram: decodeDiagram,
    parseImport: parseImport, movesFromDiagram: movesFromDiagram
  };
});
