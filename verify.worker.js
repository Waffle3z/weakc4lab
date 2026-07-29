/* Exhaustive verification off the main thread, so live checking on every edit
 * cannot freeze the page. The page falls back to running engine.js
 * synchronously if workers are unavailable (e.g. opening index.html straight
 * off the disk).
 *
 * Commands: 'verify' and 'simplify'. */
'use strict';

importScripts('engine.js');

var now = function () { return (self.performance || Date).now(); };

function boardOf(rep) {
  var parsed = WeakC4.parseRep(rep || '');
  if (parsed.error) throw new Error(parsed.error);
  var built = WeakC4.boardFromMoves(parsed.moves);
  if (built.error) throw new Error(built.error);
  return built.board;
}

self.onmessage = function (e) {
  var msg = e.data || {};
  try {
    if (msg.cmd === 'simplify') return simplify(msg);
    return verify(msg);
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err && err.message || err), token: msg.token });
  }
};

function verify(msg) {
  var board = boardOf(msg.rep);
  var t0 = now();
  var res = WeakC4.verify(board, msg.diagram, { budget: msg.budget });
  /*
   * A winning diagram gets reduced here too, so the page can say whether
   * Simplify would achieve anything before it is clicked, and apply the result
   * with no second round trip. Measured on the shipped default: 47 ms to
   * verify, 61 ms more to reduce. Only winning diagrams pay it, and those are
   * the only ones Simplify would accept anyway.
   */
  if (res.win) {
    var r = reduce(board, msg.diagram, msg.budget);
    res.simplify = { removed: r.removed, diagram: r.diagram };
  }
  res.type = 'verify';
  res.ms = now() - t0;
  res.token = msg.token;
  self.postMessage(res);
}

/*
 * Blank every marker that turns out not to be load-bearing: set a cell to '.'
 * and keep the change only if the diagram still verifies. Repeated until a
 * pass changes nothing, since blanking one cell can free another.
 */
/*
 * Blank every marker the win does not depend on. Repeated until a pass removes
 * nothing, because clearing one cell can make another redundant.
 */
function reduce(board, diagram, budget, onProgress) {
  var cur = diagram.slice();
  var cells = WeakC4.freeCells(board);
  var removed = 0;
  for (var pass = 0; pass < 4; pass++) {
    var changed = 0;
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (cur[c.yt][c.x] === '.') continue;
      var trial = WeakC4.setCell(cur, c.yt, c.x, '.');
      if (WeakC4.verify(board, trial, { budget: budget }).win) {
        cur = trial; changed++; removed++;
      }
      if (onProgress) onProgress(i + 1, cells.length, pass + 1, removed);
    }
    if (!changed) break;
  }
  return { diagram: cur, removed: removed };
}

function simplify(msg) {
  var board = boardOf(msg.rep);
  var t0 = now();

  if (!WeakC4.verify(board, msg.diagram, { budget: msg.budget }).win) {
    self.postMessage({
      type: 'simplify', token: msg.token, ok: false,
      error: 'Only a verified diagram can be simplified — this one does not win yet.'
    });
    return;
  }

  var r = reduce(board, msg.diagram, msg.budget, function (done, total, pass, removed) {
    self.postMessage({ type: 'progress', token: msg.token, done: done, total: total, pass: pass, removed: removed });
  });

  self.postMessage({
    type: 'simplify', token: msg.token, ok: true, target: msg.target,
    diagram: r.diagram, removed: r.removed, ms: now() - t0
  });
}
