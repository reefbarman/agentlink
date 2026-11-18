// Partial control for minesweeper-app: a plausible first draft. Flood fill is
// recursive (overflows the stack on large boards) and chording is missing.
import { placeMines } from "./rng.js";

export function createGame({ width, height, mines, mineCount, seed = 1 } = {}) {
  for (const value of [width, height]) {
    if (!Number.isInteger(value) || value < 1 || value > 200) {
      throw new RangeError("bad board size");
    }
  }
  if ((mines === undefined) === (mineCount === undefined)) {
    throw new TypeError("pass exactly one of mines and mineCount");
  }
  const onBoard = (x, y) =>
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < width &&
    y < height;
  const cells = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({
      revealed: false,
      flagged: false,
      mine: false,
      adjacent: 0,
    })),
  );
  const neighbours = (x, y) =>
    [-1, 0, 1]
      .flatMap((dy) => [-1, 0, 1].map((dx) => [x + dx, y + dy]))
      .filter(([nx, ny]) => (nx !== x || ny !== y) && onBoard(nx, ny));
  const lay = (positions) => {
    for (const [x, y] of positions) cells[y][x].mine = true;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        cells[y][x].adjacent = neighbours(x, y).filter(
          ([nx, ny]) => cells[ny][nx].mine,
        ).length;
      }
    }
  };

  let total;
  let placed = false;
  if (mines !== undefined) {
    if (mines.length >= width * height) throw new RangeError("too many mines");
    const seen = new Set();
    for (const [x, y] of mines) {
      if (!onBoard(x, y) || seen.has(`${x},${y}`)) {
        throw new RangeError("bad mine position");
      }
      seen.add(`${x},${y}`);
    }
    lay(mines);
    placed = true;
    total = mines.length;
  } else {
    if (
      !Number.isInteger(mineCount) ||
      mineCount < 0 ||
      mineCount > Math.max(0, width * height - 9)
    ) {
      throw new RangeError("bad mineCount");
    }
    total = mineCount;
  }

  let status = "ready";
  const check = (x, y) => {
    if (!onBoard(x, y)) throw new RangeError("off the board");
  };
  const over = () => status === "won" || status === "lost";
  const flood = (x, y) => {
    const cell = cells[y][x];
    if (cell.revealed || cell.flagged || cell.mine) return 0;
    cell.revealed = true;
    let count = 1;
    if (cell.adjacent === 0) {
      for (const [nx, ny] of neighbours(x, y)) count += flood(nx, ny);
    }
    return count;
  };
  const all = () => cells.flat();

  return {
    width,
    height,
    mineCount: total,
    get status() {
      return status;
    },
    get flagsRemaining() {
      return total - all().filter((cell) => cell.flagged).length;
    },
    cell(x, y) {
      check(x, y);
      return { ...cells[y][x] };
    },
    reveal(x, y) {
      check(x, y);
      const cell = cells[y][x];
      if (over() || cell.revealed || cell.flagged) return 0;
      if (!placed) {
        lay(
          placeMines(width, height, total, seed, [[x, y], ...neighbours(x, y)]),
        );
        placed = true;
      }
      status = "playing";
      if (cell.mine) {
        status = "lost";
        for (const other of all()) {
          if (other.mine && !other.flagged) other.revealed = true;
        }
        return 0;
      }
      const count = flood(x, y);
      if (all().every((other) => other.mine || other.revealed)) {
        status = "won";
        for (const other of all()) if (other.mine) other.flagged = true;
      }
      return count;
    },
    toggleFlag(x, y) {
      check(x, y);
      const cell = cells[y][x];
      if (over() || cell.revealed) return false;
      cell.flagged = !cell.flagged;
      return cell.flagged;
    },
    chord(x, y) {
      check(x, y);
      return 0;
    },
  };
}
