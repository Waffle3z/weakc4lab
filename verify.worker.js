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
function simplify(msg) {
  var board = boardOf(msg.rep);
  var cur = msg.diagram.slice();
  var t0 = now();

  if (!WeakC4.verify(board, cur, { budget: msg.budget }).win) {
    self.postMessage({
      type: 'simplify', token: msg.token, ok: false,
      error: 'Only a verified diagram can be simplified — this one does not win yet.'
    });
    return;
  }

  var cells = WeakC4.freeCells(board);
  var removed = 0;
  for (var pass = 0; pass < 4; pass++) {
    var changed = 0;
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (cur[c.yt][c.x] === '.') continue;
      var trial = WeakC4.setCell(cur, c.yt, c.x, '.');
      if (WeakC4.verify(board, trial, { budget: msg.budget }).win) {
        cur = trial; changed++; removed++;
      }
      self.postMessage({ type: 'progress', token: msg.token, done: i + 1, total: cells.length, pass: pass + 1, removed: removed });
    }
    if (!changed) break;
  }

  self.postMessage({
    type: 'simplify', token: msg.token, ok: true,
    diagram: cur, removed: removed, ms: now() - t0
  });
}
