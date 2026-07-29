# WeakC4 Steady-State Lab

A static page for building, sharing, playing through and exhaustively verifying
WeakC4 steady-state diagrams on the 7x6 board.

Everything runs client side. No build step, no bundler, no network access:
`index.html` plus seven scripts, and an optional WebAssembly engine loaded on
demand.

## What it is for

Everything past ply 12 is already solved, so this is not a discovery tool, and
nobody is going to find a new steady state by leaving a browser tab open. What
it is actually good at:

**Understanding the language.** Play Yellow against a diagram and watch the
move log name the rule that fired for each Red reply. That teaches what a
steady state is faster than any prose, and needs no solving at all.

**Checking a claim without a toolchain.** Anyone can load a diagram and verify
it exhaustively in the browser. For a result you want taken seriously, "here is
a link, check it yourself" is worth more than a table of numbers.

**Arguing with evidence.** If someone believes a diagram works, send a link
that plays out the exact line beating it. Counterexamples travel as URLs.

**Human insight plus machine verification.** Ply 12 and below is exactly what
remains open and exactly what automated search cannot brute-force. The
realistic path to anything new is a person committing to most of a diagram,
marking a few cells `?`, and letting the tool fill and certify the rest. That
is what auto-complete is for.

## What it does

**Markers.** Paint the seven marker characters across the 42 cells. Click paints the selected marker;
right-click marks a cell undecided. The marker layer is stored
separately from the stones, so adding and removing a stone in Position mode
never destroys the marker underneath, and markers stay visible on top of any
stone played after the root.

`?` means undecided. It is a tool-level symbol, not an eighth marker category:
the language has seven markers and every one of them means something, so there
is no value that reads as "unset" (`.` is claimeven, not blank). Auto-complete
fills exactly the undecided cells and treats every other marker as fixed. A
diagram containing one is incomplete and gets no verification verdict.

**Play.** You are Yellow, the diagram is Red. Red's replies are re-derived from
the diagram on every render, so editing a marker instantly re-plays the line.
The move log names the rule that fired for each Red move.

**Position.** Click columns to build a root, or paste a move sequence.

Clicking alternates colours, which is awkward when you have a position in mind
rather than a game. For those, paste the stones instead: six rows of `1` and
`2` with spaces elsewhere, no markers needed. The order is derived for you, so
any position reachable by some legal game will load whether or not you can see
which one. Red and Yellow counts must be equal, since Red moves at the root.

**Verification.** Runs automatically after every edit, in a Web Worker. Red
follows the diagram and every legal Yellow reply is searched. A win is a real
certification. A failure is drawn onto the board as a numbered ghost line, so
you can see how the diagram breaks while editing it. *Simplify* blanks every
marker that is not load-bearing; it is computed alongside the
verification, so the button reports how many it would clear before you press
it, and says nothing to blank when the diagram is already minimal.

It is fast enough to run on every keystroke, typically single-digit
milliseconds and rarely past a tenth of a second, so there is no re-check
button. A winning diagram is the slow case; a losing one stops at its first
counterexample. The 5 million node budget exists only to bound a pathological
case and is never approached by a real diagram.

**Auto-complete.** CEGIS with a CDCL SAT solver, in a second worker. Each SAT
model is a candidate diagram; the verifier turns each losing line into a clause.
The board shows the live candidate with its deepest counterexample behind it.

It completes diagrams; it does not solve open roots. Four undecided cells finish
in about 14 candidates, ten in about 120, twelve in about a thousand. The panel
reports how many cells are undecided before you start and says plainly when the
scope is past what it can finish.

**Share.** The URL carries the position and the diagram and updates as you
edit.

## The heavy engine

**Solve whole root** runs the real research pipeline: `dsat.cpp` linked against
CaDiCaL, compiled to WebAssembly. It is the same source the native tooling runs,
not a reimplementation, so it cannot drift from it. It is loaded on demand,
because it is about a megabyte.

This is a different operation from auto-complete. It decides a whole **root**:
either a complete diagram, or no diagram exists in the strict language. It
ignores whatever markers are on the board, because dsat solves from the
position rather than from a partial diagram.

Whatever it returns is re-verified by the in-page verifier before being
accepted, so a diagram is only kept if two independent implementations agree.

Measured against the native binary (which is built with
`-O3 -march=native -funroll-loops`, so this is not a soft baseline):

| root | native | wasm | ratio |
|---|---:|---:|---:|
| 5940 (audited UNSAT) | 1,002 ms | 995 ms | 0.99x |
| 6046 (audited UNSAT) | 995 ms | 1,084 ms | 1.09x |
| 5795 (audited UNSAT) | 4,765 ms | 5,609 ms | 1.18x |

Essentially parity. A SAT solver is branchy pointer-chasing over a contiguous
heap, which is what wasm does well, and `-march=native` buys little there.

It runs in **hybrid** mode, not full `direct`. Full direct costs about 620 B
per envelope state, which puts ply-14 roots near 30 GB and far past wasm32's
4 GiB ceiling. Hybrid bounds memory by construction through the cut ply and
the culprit-expansion cap, so the browser can pick a budget it can honour.
The cut is `root_ply + 16`, matching `dsat_campaign.py`, where 16 is the
measured sweet spot.

An UNSAT from here is sound with respect to the language, but nothing in this
repository independently audits it. Treat it as strong evidence rather than a
settled result.

**What the progress line means.** The run has two phases.

*Mapping positions* walks everything reachable from the root down to the cut
ply. The gauge under the status is the share of the state budget spent, not
work completed: the engine cannot know how much is left, and a full bar means
it overflowed rather than finished. This is the long phase, measured at 0.7 s
at ply 16 and 8 s at ply 14, growing sharply below that.

*Searching* is a single SAT call, so there is no fraction-complete and no bar
to draw. It is not opaque though. A **dead end** is a branch the solver proved
impossible, and the count is the standard measure of how much ground has been
ruled out. **Variables settled** are those fixed for good; the formula carries
reachability and circuit variables as well as the 42 cells, so this is not a
count of decided markers. Both only ever rise. The learnt-clause count is
deliberately not shown: it falls whenever the database is reduced, which reads
as the search going backwards.

Roots this size settle in zero or one refinement rounds, so there is rarely an
iteration count to watch.

### Where the engine comes from

`engine/dsat_7x6.js` and `engine/dsat_7x6.wasm` are committed build artifacts.
The C++ behind them is not in this repository: `dsat.cpp`, `c4.hpp`,
`solver.hpp` and the CaDiCaL checkout live in the connect4 research repository,
where the pipeline is developed.

Keeping one copy of that source is deliberate. A second copy here would be a
second thing to keep in step, and the port would quietly fall behind the engine
it is meant to be. The cost is that this repository cannot rebuild the engine,
and a pull request cannot meaningfully change it.

What it can do is check it. `engine/PROVENANCE.json` records the source hashes,
the CaDiCaL commit, the emscripten version and the exact build flags;
`tests/run_engine_test.js` fails if the artifacts stop matching those hashes, or
stop returning the audited verdicts, or return a diagram that `engine.js`
rejects.

Rebuilding, from the research repository:

```bash
git clone --depth 1 https://github.com/emscripten-core/emsdk.git ~/emsdk
cd ~/emsdk && python emsdk.py install latest && python emsdk.py activate latest
cd /path/to/connect4 && bash tools/build_wasm.sh 7 6
```

That compiles CaDiCaL and `dsat.cpp`, installs the artifacts here, rewrites
`PROVENANCE.json`, and runs `tools/wasm_parity.js`, which requires the wasm and
the native binary to return identical verdicts on the audited roots. A mismatch
fails the build.

Two things that are not obvious:

- `kitten.c`, CaDiCaL's embedded sub-solver, is C rather than C++. Globbing
  `*.cpp` links cleanly right up to a wall of undefined `kitten_*` symbols.
- The script compiles at `-O3` but links at `-O2` on purpose. emscripten only
  runs `wasm-metadce` at `-O3` or with a shrink level, and that one binary is
  blocked by some Windows Application Control policies while every other
  binaryen tool runs. metadce only prunes unused JS/wasm boundary exports, so
  skipping it costs a little size and nothing else.

**No C++ source changes were needed.** dsat already reports every result as
JSON on stdout, and emscripten's in-memory filesystem covers its checkpoint
reads and writes, so the same file is compiled for both targets.

## Semantics

Strict only: 2swap's original `SteadyState.cpp`. A priority level that exposes
two or more moves is an **invalid** diagram state (the original returns `-6`,
"Red failed to select a move"). Uniqueness is part of the language. The
published browser viewer does not validate it and silently resolves ties left
to right.

- Priority order: urgent, miai, claim, plus, equal, minus.
- Valid claimeven and claimodd cells share one claim level.
- Miai is ignored unless exactly one miai is exposed.
- Immediate wins and forced blocks precede all markers.

| char | name | fires |
|---|---|---|
| `!` | urgent | always |
| `@` | miai | only when exactly one is exposed |
| `.` | claimeven | even rows (2, 4, 6). Drawn as an empty cell; the dot is only the on-disk spelling |
| `\|` | claimodd | odd rows (1, 3, 5) |
| `+` | plus | always |
| `=` | equal | always |
| `-` | minus | always |
| `1` `2` | Red / Yellow stone at the root | |
| `?` | undecided, tool only | never; auto-complete fills these |

A claimeven glyph on an odd row, and a claimodd glyph on an even row, never
fire. That opposite-parity inert cell is the seventh marker category. Omitting
it would make any UNSAT claim incomplete.

Columns are numbered 1 to 7, matching the digits in a move sequence and the
"column 4" wording in the project notes. Rows count 1 to 6 from the bottom.

The board uses two ring treatments, and the legend under it names whichever
are on screen: an accent ring is the move the diagram selects, a green ring is
the winning four. Faded stones
are a counterexample line rather than the root position, and carry their move
number. Where a column would drop is shown on hover; clicking anywhere in a
column plays it.

## Correctness

The page's agent is a port, so it is pinned to the Python reference rather than
trusted:

```bash
npm test          # all three suites, no dependencies to install
```

or individually:

```bash
node tests/run_crosscheck.js
```

against the committed fixture. That replays 4,000 random positions and diagrams
through `engine.js`, comparing
every selected move against `verify_strict.query_ss_strict`, plus 250 full
exhaustive verdicts against `verify_strict.verify_ss_strict`, plus URL codec
and importer round-trips. Any mismatch is a hard failure.

The fixture is generated by `weakc4/gen_js_crosscheck.py` in the research
repository and committed here, so the test needs node and nothing else.

```bash
node tests/run_sat_tests.js
```

checks the SAT solver against brute force and pigeonhole instances, exercises
clause deletion, and runs the synthesizer end to end.
It also guards the CEGIS invariant directly: no clause may be satisfied by its
own candidate, and the candidate must never repeat.

```bash
node tests/run_engine_test.js
```

checks that the committed WebAssembly artifacts still hash to what
`engine/PROVENANCE.json` records, and that they still return the audited
verdicts on one UNSAT root and one root with a known diagram. The diagram it
returns is re-verified with `engine.js`, so the test only passes when two
independent implementations agree.

One deliberate divergence from the Python reference: `verify()` refuses a root
that already contains a four-in-a-row, returning `ROOT_TERMINAL`.
`verify_ss_strict` will happily search from such a position and report a win,
because the agent finds Red some immediate win in a single node. The game is
already over there, so there is no verdict to give.

## The SAT solver

`sat.js` is **written by hand for this page, not a vendored library.** It is a
standard CDCL solver in the MiniSat mould, just under 400 lines:

- two-watched-literal unit propagation
- 1UIP conflict analysis with clause learning
- VSIDS-style variable activity with rescaling, and phase saving
- Luby restarts
- LBD-based learnt clause deletion
- incremental in the one direction CEGIS needs: clauses are only ever added
  between `solve()` calls, so every learnt clause stays valid

It does not have the inprocessing that makes a modern solver fast: no
vivification, no subsumption, no bounded variable elimination, no chronological
backtracking. Variable selection is a linear scan rather than a heap, which is
fine at 238 variables and would not be at 238,000.

It is tested rather than trusted. What ships, and what you can run yourself:
600 random 3-SAT instances checked against brute force, 150 more driven
incrementally with clause deletion forced on, pigeonhole up to 7 into 6 both
normally and under forced deletion, and the synthesizer end to end.

Deletion gets its own tests because it is the most dangerous code in the file.
A lost watch or a clause deleted while still cited as a reason would corrupt
propagation, and the default `maxLearnts` of 8000 means ordinary use never
reaches `reduceDB` at all, so it would otherwise ship unexercised. A wrong
UNSAT matters more than a wrong SAT here: a SAT answer is a candidate diagram
that the verifier checks independently, while an UNSAT is reported to you as a
conclusion.

That is reassuring, not a proof. If you need a solver you can lean on, use a
real one.

### Why it is not compiled to WASM

The obvious upgrade is to replace `sat.js` with CaDiCaL compiled for the
browser. It would not help, and the measurements say why. Time spent in a CEGIS
run, by workload:

| workload | SAT solve | exhaustive verify | clause build |
|---|---:|---:|---:|
| every cell undecided (6,988 candidates in 20 s) | **87.6%** | 2.9% | 9.5% |
| 10 cells undecided on a ply-8 root (123 candidates) | 4.3% | **84.2%** | 11.5% |
| 14 undecided on a ply-12 root (20,178 candidates in 120 s) | **91.1%** | 5.5% | 3.4% |

The two have opposite bottlenecks. A faster SAT solver attacks 87.6% of the
first and almost none of the second, where the verifier dominates and the whole
run finishes in about 180 ms anyway.

So it would make a hopeless search fail faster rather than succeed. A cold
ply-10 root ran 92,000 candidates without converging, and the deepest
counterexample plateaued instead of trending toward a solution. The space is
7^32 and each clause removes a vanishing slice of it, so a 10x throughput gain
buys one digit against a gap of many orders of magnitude. The binding
constraint is how little each counterexample rules out, which is a property of
the encoding rather than of the language it runs in.

That is why the panel reports how many cells are undecided before a search
starts, and says plainly when the scope is too wide to expect a result. Leaving
it running overnight finds nothing that a few minutes would not.

## Where the search stands

The bottleneck is measured, not guessed. Each clause carries roughly 120
literals out of 224 variables, so one counterexample removes a vanishing slice
of the space. Tried and rejected on evidence:

| change | result |
|---|---|
| harvest 8/24/48 counterexamples, keep the shallowest | within noise on throughput and repair difficulty, and costs extra search per candidate. Left off. |
| learnt-clause reduction (LBD) | kept. Bounds the database, 10,550 down to 4,093 learnt clauses over the same run, and stops the decay of an unbounded DB. |

Neither touches the real limit. The one change that would is an **exact
winning-move oracle**: instead of "one of these ~86 cell/marker pairs must
change", a clause saying "at the culprit state the diagram must pick one of
these winning moves", which is a handful of literals rather than 41% of the
variables.

That needs a Connect 4 solver in the page, and one now ships:
`engine/c4solver_7x6.wasm`, 13 KB, the same `solver.hpp` the research
tooling uses. It exposes `c4_solve` and `c4_winning_moves` and keeps its
transposition table warm between calls. Measured against the native binary
under the same warm-table conditions, 300 weak solves at ply 8 to 29: 12,388 ms
native against 12,746 ms in the browser, **1.03x**, with identical verdicts on
every position.

Cost is a function of depth, which is what makes this usable: about **5 ms**
per weak solve at ply 12 and beyond, against 2.5 minutes from the empty board.
An oracle only ever asks about positions along a counterexample line, so it
never pays the opening price. For scale, dsat spends about a tenth of a second
in its oracle across an 838-second run.

Wiring it into the clause is not done. That is a change to the CEGIS encoding
in `synth.js`, not to the solver.

*Solve whole root* does not make this redundant. dsat solves from the position
and ignores the markers on screen, so it cannot answer whether a particular
partial diagram extends to a winning one, which is the question someone
building a diagram by hand is actually asking.

Until that happens, treat the in-page search as a diagram completer, not a
solver: four free cells solve in about 14 candidates, twelve in about 1,000, and
a cold ply-10 root does not converge at all.

An UNSAT verdict here is sound with respect to the clauses it accumulated, but
it is not an audited impossibility proof, and it is bounded by whichever
markers you pinned. Say what it covers if you report it.

## Layout

The page is built to fit one screen. The board scales to the viewport rather
than being a fixed size: its `max-width` derives from `100dvh`, and because
cells are square, bounding the width bounds the height. Marker glyphs scale
with it through container query units. Below a usable cell size the board stops
shrinking and the page scrolls instead.

On a narrow screen the columns stack, the palette drops its labels to keep all
seven buttons on one row, and the page scrolls vertically. Explanatory prose
sits in collapsed `details` blocks so it costs no height until asked for.

## Browser support

Uses `:has()`, container query units, `color-mix()` and `100dvh`. That means
Chrome/Edge 111+, Safari 16.4+, Firefox 121+. Older browsers will render the
board but lose some of the cell styling.

Keyboard support is partial. Every control is a real button, digits 1 to 7 play
a column in Play mode and pick a marker in Markers mode, and Backspace undoes.
Painting a marker onto a particular cell is mouse only: the cells are not
focusable and there is no arrow-key selection. That is a known gap rather than
a decision.

## Running it

Any static host works. Locally:

```bash
python -m http.server 8765
```

then open <http://localhost:8765>. Opening `index.html` from the file system
mostly works, but browsers block Workers on `file://`, so verification falls
back to the main thread and the search is unavailable.

### GitHub Pages

The page sits at the repository root, so Settings > Pages > deploy from branch,
`main`, `/ (root)` serves it as is. All asset paths are relative, so it works
from a project subpath such as `user.github.io/repo/`.

Nothing here is generated from research data: no diagram library, no solution
artifacts, no graph. `tests/crosscheck.json` is a random-position test fixture,
not research output, and is only needed by the node tests.

## License

MIT, see `LICENSE`.

`engine/` contains compiled code from CaDiCaL and from emscripten, both
permissively licensed. Their license texts are reproduced verbatim in
`THIRD_PARTY_LICENSES.md`.

The steady-state language itself is 2swap's, from
[WeakC4](https://2swap.github.io/WeakC4/explanation/). This page reimplements
the semantics of his `SteadyState.cpp` from reading it; no code was copied.

## Files

| file | role |
|---|---|
| `index.html` | markup |
| `style.css` | styling, light and dark |
| `engine.js` | board mechanics, the strict agent, exhaustive verifier, URL codec, importer |
| `sat.js` | CDCL SAT solver |
| `synth.js` | CEGIS encoding and loop |
| `app.js` | UI |
| `verify.worker.js` | verification and simplification off the main thread |
| `synth.worker.js` | synthesis off the main thread |
| `dsat.worker.js` | the WebAssembly engine, off the main thread |
| `engine/` | compiled engines and their provenance: `dsat` for whole roots, `c4solver` for game-tree queries |
| `tests/` | node test runners and the Python-generated fixture |
| `.github/workflows/ci.yml` | runs every test suite on each pull request |
| `LICENSE` | MIT |
| `THIRD_PARTY_LICENSES.md` | CaDiCaL and emscripten, verbatim |
