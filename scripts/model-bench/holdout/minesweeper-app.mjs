import * as path from "node:path";

import { check, expectEqual, finish, firstFailure } from "./check.mjs";

import { fileURLToPath } from "node:url";
// Held-out behaviour checks for minesweeper-app. Each check is one SPEC.md
// behaviour, so the share of passing checks is a meaningful partial score.
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = async (file) => await import(path.join(root, "src", file));
const { createGame } = await load("game.js").catch(() => ({}));
const { render } = await load("render.js").catch(() => ({}));
const { placeMines } = await load("rng.js");

// Board A, 5 x 4, mines at (0,0) and (3,2):
//   *....      0 1 0 0 0
//   .....  ->  1 1 1 1 1   (adjacent counts)
//   ...*.      0 0 1 0 1
//   .....      0 0 1 1 1
const BOARD_A = {
  width: 5,
  height: 4,
  mines: [
    [0, 0],
    [3, 2],
  ],
};
const boardA = () => createGame(structuredClone(BOARD_A));
// Board B, 3 x 3, every cell but the centre is a mine.
const boardB = () =>
  createGame({
    width: 3,
    height: 3,
    mines: [
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 1],
      [2, 1],
      [0, 2],
      [1, 2],
      [2, 2],
    ],
  });

function expectThrows(fn, ErrorType, label) {
  try {
    fn();
  } catch (error) {
    return error instanceof ErrorType
      ? true
      : `${label}: threw ${error?.constructor?.name}, expected ${ErrorType.name}`;
  }
  return `${label}: did not throw ${ErrorType.name}`;
}

function minesOf(game) {
  const found = [];
  for (let y = 0; y < game.height; y++) {
    for (let x = 0; x < game.width; x++) {
      if (game.cell(x, y).mine) found.push([x, y]);
    }
  }
  return found;
}

function around(game, x, y) {
  const cells = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < game.width && ny < game.height) {
        cells.push([nx, ny]);
      }
    }
  }
  return cells;
}

function cli(args, input = "") {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "src", "cli.js"), ...args],
    { cwd: root, input, encoding: "utf8", timeout: 10_000 },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const A_ARGS = ["--width", "5", "--height", "4", "--mines-at", "0,0;3,2"];

// --- createGame validation --------------------------------------------------

await check("create-validates-size", () =>
  firstFailure(
    expectThrows(
      () => createGame({ width: 0, height: 3, mines: [] }),
      RangeError,
      "width 0",
    ),
    expectThrows(
      () => createGame({ width: 201, height: 3, mines: [] }),
      RangeError,
      "width 201",
    ),
    expectThrows(
      () => createGame({ width: 3, height: 1.5, mines: [] }),
      RangeError,
      "height 1.5",
    ),
    expectThrows(
      () => createGame({ width: "5", height: 3, mines: [] }),
      RangeError,
      'width "5"',
    ),
    expectEqual(
      createGame({ width: 200, height: 200, mines: [] }).width,
      200,
      "200 x 200 allowed",
    ),
  ),
);

await check("create-requires-one-mine-option", () =>
  firstFailure(
    expectThrows(
      () => createGame({ width: 5, height: 5 }),
      TypeError,
      "neither",
    ),
    expectThrows(
      () => createGame({ width: 5, height: 5, mines: [], mineCount: 1 }),
      TypeError,
      "both",
    ),
  ),
);

await check("create-validates-mine-positions", () =>
  firstFailure(
    expectThrows(
      () =>
        createGame({
          width: 5,
          height: 4,
          mines: [
            [1, 1],
            [1, 1],
          ],
        }),
      RangeError,
      "duplicate",
    ),
    expectThrows(
      () => createGame({ width: 5, height: 4, mines: [[5, 0]] }),
      RangeError,
      "x off board",
    ),
    expectThrows(
      () => createGame({ width: 5, height: 4, mines: [[0, -1]] }),
      RangeError,
      "y off board",
    ),
    expectThrows(
      () =>
        createGame({
          width: 2,
          height: 1,
          mines: [
            [0, 0],
            [1, 0],
          ],
        }),
      RangeError,
      "no safe cell left",
    ),
  ),
);

await check("create-validates-mine-count", () =>
  firstFailure(
    expectEqual(
      createGame({ width: 9, height: 9, mineCount: 72 }).mineCount,
      72,
      "9x9 max 72",
    ),
    expectThrows(
      () => createGame({ width: 9, height: 9, mineCount: 73 }),
      RangeError,
      "73",
    ),
    expectThrows(
      () => createGame({ width: 9, height: 9, mineCount: -1 }),
      RangeError,
      "-1",
    ),
    expectThrows(
      () => createGame({ width: 9, height: 9, mineCount: 1.5 }),
      RangeError,
      "1.5",
    ),
    expectEqual(
      createGame({ width: 2, height: 2, mineCount: 0 }).mineCount,
      0,
      "2x2 with 0",
    ),
    expectThrows(
      () => createGame({ width: 2, height: 2, mineCount: 1 }),
      RangeError,
      "2x2 with 1",
    ),
  ),
);

// --- state, cells and bounds -------------------------------------------------

await check("initial-state", () => {
  const game = boardA();
  const cell = game.cell(0, 0);
  return firstFailure(
    expectEqual(game.status, "ready", "status"),
    expectEqual(game.width, 5, "width"),
    expectEqual(game.height, 4, "height"),
    expectEqual(game.mineCount, 2, "mineCount"),
    expectEqual(game.flagsRemaining, 2, "flagsRemaining"),
    expectEqual(
      JSON.stringify([cell.revealed, cell.flagged, cell.mine]),
      "[false,false,true]",
      "cell(0,0) revealed/flagged/mine",
    ),
  );
});

await check("adjacent-counts", () => {
  const a = boardA();
  const b = boardB();
  const counts = [];
  for (let y = 0; y < 4; y++) {
    let row = "";
    for (let x = 0; x < 5; x++) row += a.cell(x, y).adjacent;
    counts.push(row);
  }
  return firstFailure(
    expectEqual(counts.join("/"), "01000/11111/00101/00111", "board A counts"),
    expectEqual(b.cell(1, 1).adjacent, 8, "centre of board B"),
    expectEqual(b.cell(0, 0).adjacent, 2, "mine cell (0,0) of board B"),
  );
});

await check("out-of-bounds-throws", () => {
  const game = boardA();
  return firstFailure(
    expectThrows(() => game.reveal(-1, 0), RangeError, "reveal(-1,0)"),
    expectThrows(() => game.reveal(5, 0), RangeError, "reveal(5,0)"),
    expectThrows(() => game.toggleFlag(0, 4), RangeError, "toggleFlag(0,4)"),
    expectThrows(() => game.chord(0, -1), RangeError, "chord(0,-1)"),
    expectThrows(() => game.cell(5, 5), RangeError, "cell(5,5)"),
    expectThrows(() => game.reveal(1.5, 0), RangeError, "reveal(1.5,0)"),
  );
});

// --- revealing ---------------------------------------------------------------

await check("reveal-number-cell", () => {
  const game = boardA();
  return firstFailure(
    expectEqual(game.reveal(2, 1), 1, "reveal(2,1) count"),
    expectEqual(game.status, "playing", "status"),
    expectEqual(game.cell(2, 1).revealed, true, "(2,1) revealed"),
    expectEqual(game.cell(1, 1).revealed, false, "(1,1) stays hidden"),
  );
});

await check("flood-fill", () => {
  const game = boardA();
  return firstFailure(
    expectEqual(game.reveal(0, 3), 9, "reveal(0,3) count"),
    expectEqual(render(game), "#####\n111##\n..1##\n..1##", "board"),
    expectEqual(game.reveal(3, 0), 6, "reveal(3,0) count"),
    expectEqual(
      render(game),
      "#1...\n11111\n..1##\n..1##",
      "board after second flood",
    ),
  );
});

await check("flood-skips-flags", () => {
  const game = boardA();
  game.toggleFlag(1, 2);
  return firstFailure(
    expectEqual(game.reveal(0, 3), 7, "reveal(0,3) count"),
    expectEqual(render(game), "#####\n11###\n.F1##\n..1##", "board"),
    expectEqual(game.cell(1, 2).flagged, true, "(1,2) still flagged"),
  );
});

await check("reveal-revealed-or-flagged-is-noop", () => {
  const game = boardA();
  game.toggleFlag(4, 3);
  return firstFailure(
    expectEqual(game.reveal(4, 3), 0, "reveal flagged"),
    expectEqual(game.status, "ready", "flag + no-op reveal keeps ready"),
    expectEqual(game.reveal(2, 1), 1, "first reveal"),
    expectEqual(game.reveal(2, 1), 0, "second reveal of the same cell"),
  );
});

await check("large-board-flood", () => {
  const game = createGame({ width: 200, height: 200, mines: [[199, 199]] });
  return firstFailure(
    expectEqual(game.reveal(0, 0), 39_999, "reveal(0,0) count"),
    expectEqual(game.status, "won", "status"),
  );
});

// --- win and loss -----------------------------------------------------------

await check("win-flags-mines", () => {
  const game = boardA();
  for (const [x, y] of [
    [0, 3],
    [3, 0],
    [4, 2],
    [3, 3],
  ])
    game.reveal(x, y);
  const before = game.status;
  game.reveal(4, 3);
  return firstFailure(
    expectEqual(before, "playing", "status before last cell"),
    expectEqual(game.status, "won", "status"),
    expectEqual(game.flagsRemaining, 0, "flagsRemaining"),
    expectEqual(render(game), "F1...\n11111\n..1F1\n..111", "board"),
  );
});

await check("zero-mine-board-wins-at-once", () => {
  const game = createGame({ width: 4, height: 3, mines: [] });
  return firstFailure(
    expectEqual(game.reveal(2, 1), 12, "count"),
    expectEqual(game.status, "won", "status"),
    expectEqual(render(game), "....\n....\n....", "board"),
  );
});

await check("only-safe-cell-wins", () => {
  const game = boardB();
  return firstFailure(
    expectEqual(game.reveal(1, 1), 1, "count"),
    expectEqual(game.status, "won", "status"),
    expectEqual(render(game), "FFF\nF8F\nFFF", "board"),
  );
});

await check("loss-reveals-unflagged-mines", () => {
  const game = boardA();
  game.toggleFlag(0, 0);
  game.toggleFlag(4, 3);
  return firstFailure(
    expectEqual(game.reveal(3, 2), 0, "reveal mine count"),
    expectEqual(game.status, "lost", "status"),
    expectEqual(game.cell(3, 2).revealed, true, "hit mine revealed"),
    expectEqual(game.cell(0, 0).revealed, false, "flagged mine stays hidden"),
    expectEqual(game.cell(0, 0).flagged, true, "flagged mine stays flagged"),
  );
});

await check("loss-reveals-other-mines", () => {
  const game = boardA();
  game.reveal(3, 2);
  return firstFailure(
    expectEqual(game.cell(0, 0).revealed, true, "other mine revealed"),
    expectEqual(render(game), "*####\n#####\n###*#\n#####", "board"),
  );
});

await check("game-over-is-frozen", () => {
  const lost = boardA();
  lost.reveal(0, 0);
  const lostBoard = render(lost);
  const won = boardB();
  won.reveal(1, 1);
  return firstFailure(
    expectEqual(lost.reveal(0, 3), 0, "reveal after loss"),
    expectEqual(lost.toggleFlag(4, 3), false, "flag after loss"),
    expectEqual(lost.chord(0, 0), 0, "chord after loss"),
    expectEqual(render(lost), lostBoard, "board unchanged after loss"),
    expectEqual(lost.status, "lost", "status stays lost"),
    expectEqual(won.toggleFlag(0, 0), false, "unflag after win"),
    expectEqual(won.flagsRemaining, 0, "flags unchanged after win"),
  );
});

// --- flags --------------------------------------------------------------------

await check("toggle-flag", () => {
  const game = boardA();
  const results = [
    game.toggleFlag(4, 0),
    game.toggleFlag(4, 1),
    game.toggleFlag(4, 2),
  ];
  const remaining = game.flagsRemaining;
  const unflag = game.toggleFlag(4, 2);
  return firstFailure(
    expectEqual(results.join(), "true,true,true", "flag returns"),
    expectEqual(remaining, -1, "flagsRemaining goes negative"),
    expectEqual(unflag, false, "unflag returns false"),
    expectEqual(game.flagsRemaining, 0, "flagsRemaining after unflag"),
    expectEqual(game.status, "ready", "flagging does not start the game"),
  );
});

await check("flag-on-revealed-is-noop", () => {
  const game = boardA();
  game.reveal(2, 1);
  return firstFailure(
    expectEqual(game.toggleFlag(2, 1), false, "returns false"),
    expectEqual(game.cell(2, 1).flagged, false, "not flagged"),
    expectEqual(game.flagsRemaining, 2, "flagsRemaining unchanged"),
  );
});

// --- chording -----------------------------------------------------------------

await check("chord-reveals-neighbours", () => {
  const game = boardA();
  game.reveal(0, 3);
  game.toggleFlag(3, 2);
  return firstFailure(
    expectEqual(game.chord(2, 2), 2, "chord count"),
    expectEqual(render(game), "#####\n1111#\n..1F#\n..11#", "board"),
  );
});

await check("chord-needs-matching-flags", () => {
  const game = boardA();
  game.reveal(0, 3);
  return firstFailure(
    expectEqual(game.chord(2, 2), 0, "no flags"),
    expectEqual(game.cell(3, 1).revealed, false, "(3,1) stays hidden"),
    expectEqual(game.chord(0, 2), 0, "chord on a 0 cell"),
    expectEqual(game.chord(4, 0), 0, "chord on a hidden cell"),
  );
});

await check("chord-with-wrong-flag-loses", () => {
  const game = boardA();
  // Reveal (3,1) first so the mine is the only cell the chord can open, which
  // keeps the expected board independent of neighbour iteration order.
  game.reveal(0, 3);
  game.reveal(3, 1);
  game.toggleFlag(3, 3);
  game.chord(2, 2);
  return firstFailure(
    expectEqual(game.status, "lost", "status"),
    expectEqual(render(game), "*####\n1111#\n..1*#\n..1X#", "board"),
  );
});

// --- seeded games -------------------------------------------------------------

await check("seeded-mines-wait-for-first-reveal", () => {
  const game = createGame({ width: 9, height: 9, mineCount: 10, seed: 42 });
  return firstFailure(
    expectEqual(game.status, "ready", "status"),
    expectEqual(game.mineCount, 10, "mineCount"),
    expectEqual(game.flagsRemaining, 10, "flagsRemaining"),
    expectEqual(minesOf(game).length, 0, "no mines before the first reveal"),
  );
});

await check("seeded-layout-uses-placeMines", () => {
  const outcomes = [];
  for (const [seed, x, y] of [
    [42, 4, 4],
    [7, 0, 0],
    [123, 8, 3],
  ]) {
    const game = createGame({ width: 9, height: 9, mineCount: 10, seed });
    game.reveal(x, y);
    outcomes.push(
      expectEqual(
        JSON.stringify(minesOf(game)),
        JSON.stringify(placeMines(9, 9, 10, seed, around(game, x, y))),
        `seed ${seed}, first reveal (${x},${y})`,
      ),
    );
  }
  return firstFailure(...outcomes);
});

await check("seed-defaults-to-1", () => {
  const game = createGame({ width: 9, height: 9, mineCount: 10 });
  game.reveal(4, 4);
  return expectEqual(
    JSON.stringify(minesOf(game)),
    JSON.stringify(placeMines(9, 9, 10, 1, around(game, 4, 4))),
    "layout",
  );
});

await check("first-reveal-is-safe", () => {
  const outcomes = [];
  for (let seed = 1; seed <= 20; seed++) {
    const game = createGame({ width: 30, height: 16, mineCount: 99, seed });
    game.reveal(15, 8);
    outcomes.push(
      expectEqual(game.status, "playing", `seed ${seed} status`),
      expectEqual(minesOf(game).length, 99, `seed ${seed} mine count`),
      expectEqual(game.cell(15, 8).adjacent, 0, `seed ${seed} first cell`),
    );
  }
  return firstFailure(...outcomes);
});

// --- CLI ----------------------------------------------------------------------

await check("cli-explicit-mines", () => {
  const run = cli(A_ARGS, "r 0 3\nf 3 2\n");
  return firstFailure(
    expectEqual(run.status, 0, "exit code"),
    expectEqual(
      run.stdout,
      "#####\n111##\n..1F#\n..1##\nStatus: playing\nFlags remaining: 1\n",
      "stdout",
    ),
  );
});

await check("cli-win", () => {
  const run = cli(A_ARGS, "r 0 3\nr 3 0\nr 4 2\nr 3 3\nr 4 3\n");
  return expectEqual(
    run.stdout,
    "F1...\n11111\n..1F1\n..111\nStatus: won\nFlags remaining: 0\n",
    "stdout",
  );
});

await check("cli-chord-and-loss", () => {
  const run = cli(A_ARGS, "r 0 3\nr 3 1\nf 3 3\nc 2 2\n");
  return expectEqual(
    run.stdout,
    "*####\n1111#\n..1*#\n..1X#\nStatus: lost\nFlags remaining: 1\n",
    "stdout",
  );
});

await check("cli-no-input", () => {
  const run = cli(A_ARGS, "");
  return firstFailure(
    expectEqual(run.status, 0, "exit code"),
    expectEqual(
      run.stdout,
      "#####\n#####\n#####\n#####\nStatus: ready\nFlags remaining: 2\n",
      "stdout",
    ),
  );
});

await check("cli-bad-commands-continue", () => {
  const run = cli(A_ARGS, "x 1 2\nr 9 9\nr a b\nr 1\n  r   2   1  \n\n");
  const errors = run.stderr
    .split("\n")
    .filter((line) => line.startsWith("Error:"));
  return firstFailure(
    expectEqual(run.status, 0, "exit code"),
    expectEqual(errors.length, 4, "Error: lines on stderr"),
    expectEqual(
      run.stdout,
      "#####\n##1##\n#####\n#####\nStatus: playing\nFlags remaining: 2\n",
      "stdout",
    ),
  );
});

await check("cli-quit", () => {
  const run = cli(A_ARGS, "r 2 1\nq\nr 0 3\n");
  return expectEqual(
    run.stdout,
    "#####\n##1##\n#####\n#####\nStatus: playing\nFlags remaining: 2\n",
    "stdout",
  );
});

await check("cli-seeded", () => {
  const run = cli(
    ["--width", "9", "--height", "9", "--mines", "10", "--seed", "42"],
    "r 4 4\n",
  );
  const game = createGame({ width: 9, height: 9, mineCount: 10, seed: 42 });
  game.reveal(4, 4);
  return expectEqual(
    run.stdout,
    `${render(game)}\nStatus: playing\nFlags remaining: 10\n`,
    "stdout",
  );
});

await check("cli-bad-options", () => {
  const outcomes = [];
  for (const [label, args] of [
    ["missing --width", ["--height", "4", "--mines", "1"]],
    [
      "both mine options",
      ["--width", "5", "--height", "4", "--mines", "1", "--mines-at", "0,0"],
    ],
    ["no mine option", ["--width", "5", "--height", "4"]],
    [
      "mine off the board",
      ["--width", "5", "--height", "4", "--mines-at", "9,9"],
    ],
  ]) {
    const run = cli(args, "");
    outcomes.push(
      expectEqual(run.status, 2, `${label}: exit code`),
      expectEqual(
        run.stderr.startsWith("Error:"),
        true,
        `${label}: stderr starts with Error:`,
      ),
    );
  }
  return firstFailure(...outcomes);
});

finish();
