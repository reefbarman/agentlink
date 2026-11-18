// Reference solution for the minesweeper-app bench task.
import { placeMines } from "./rng.js";

const isInt = (value) => Number.isInteger(value);

export function createGame(options = {}) {
  const { width, height, mines, mineCount, seed = 1 } = options;
  for (const [name, value] of [
    ["width", width],
    ["height", height],
  ]) {
    if (!isInt(value) || value < 1 || value > 200) {
      throw new RangeError(`${name} must be an integer from 1 to 200`);
    }
  }
  if ((mines === undefined) === (mineCount === undefined)) {
    throw new TypeError("pass exactly one of mines and mineCount");
  }
  const size = width * height;
  const isMine = new Uint8Array(size);
  const revealed = new Uint8Array(size);
  const flagged = new Uint8Array(size);
  const adjacent = new Uint8Array(size);
  const index = (x, y) => y * width + x;
  const onBoard = (x, y) =>
    isInt(x) && isInt(y) && x >= 0 && y >= 0 && x < width && y < height;
  const neighbours = (x, y) => {
    const cells = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx || dy) && onBoard(x + dx, y + dy)) {
          cells.push([x + dx, y + dy]);
        }
      }
    }
    return cells;
  };

  let total;
  let placed = false;
  if (mines !== undefined) {
    if (!Array.isArray(mines) || mines.length >= size) {
      throw new RangeError("mines must leave at least one safe cell");
    }
    for (const position of mines) {
      if (!Array.isArray(position) || !onBoard(position[0], position[1])) {
        throw new RangeError(
          `mine ${JSON.stringify(position)} is off the board`,
        );
      }
      const i = index(position[0], position[1]);
      if (isMine[i]) throw new RangeError("duplicate mine position");
      isMine[i] = 1;
    }
    total = mines.length;
    layMines();
  } else {
    if (
      !isInt(mineCount) ||
      mineCount < 0 ||
      mineCount > Math.max(0, size - 9)
    ) {
      throw new RangeError("mineCount out of range");
    }
    total = mineCount;
  }

  function layMines() {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        adjacent[index(x, y)] = neighbours(x, y).filter(
          ([nx, ny]) => isMine[index(nx, ny)],
        ).length;
      }
    }
    placed = true;
  }

  let status = "ready";
  let flagCount = 0;
  let safeHidden = size - total;

  const assertOnBoard = (x, y) => {
    if (!onBoard(x, y)) throw new RangeError(`(${x}, ${y}) is off the board`);
  };
  const over = () => status === "won" || status === "lost";

  function open(x, y) {
    const start = index(x, y);
    if (revealed[start] || flagged[start]) return 0;
    if (isMine[start]) {
      status = "lost";
      for (let i = 0; i < size; i++) {
        if (isMine[i] && !flagged[i]) revealed[i] = 1;
      }
      return 0;
    }
    let count = 0;
    const stack = [[x, y]];
    revealed[start] = 1;
    while (stack.length) {
      const [cx, cy] = stack.pop();
      count++;
      if (adjacent[index(cx, cy)] !== 0) continue;
      for (const [nx, ny] of neighbours(cx, cy)) {
        const i = index(nx, ny);
        if (!revealed[i] && !flagged[i] && !isMine[i]) {
          revealed[i] = 1;
          stack.push([nx, ny]);
        }
      }
    }
    safeHidden -= count;
    return count;
  }

  function checkWin() {
    if (status === "playing" && safeHidden === 0) {
      status = "won";
      for (let i = 0; i < size; i++) {
        if (isMine[i] && !flagged[i]) {
          flagged[i] = 1;
          flagCount++;
        }
      }
    }
  }

  return {
    width,
    height,
    mineCount: total,
    get status() {
      return status;
    },
    get flagsRemaining() {
      return total - flagCount;
    },
    cell(x, y) {
      assertOnBoard(x, y);
      const i = index(x, y);
      return {
        revealed: Boolean(revealed[i]),
        flagged: Boolean(flagged[i]),
        mine: Boolean(isMine[i]),
        adjacent: adjacent[i],
      };
    },
    reveal(x, y) {
      assertOnBoard(x, y);
      const i = index(x, y);
      if (over() || revealed[i] || flagged[i]) return 0;
      if (!placed) {
        const safe = [[x, y], ...neighbours(x, y)];
        for (const [mx, my] of placeMines(width, height, total, seed, safe)) {
          isMine[index(mx, my)] = 1;
        }
        layMines();
      }
      status = "playing";
      const count = open(x, y);
      checkWin();
      return count;
    },
    toggleFlag(x, y) {
      assertOnBoard(x, y);
      const i = index(x, y);
      if (over() || revealed[i]) return false;
      flagged[i] = flagged[i] ? 0 : 1;
      flagCount += flagged[i] ? 1 : -1;
      return Boolean(flagged[i]);
    },
    chord(x, y) {
      assertOnBoard(x, y);
      const i = index(x, y);
      if (over() || !revealed[i] || adjacent[i] === 0) return 0;
      const around = neighbours(x, y);
      const flags = around.filter(([nx, ny]) => flagged[index(nx, ny)]).length;
      if (flags !== adjacent[i]) return 0;
      let count = 0;
      for (const [nx, ny] of around) {
        if (status !== "playing") break;
        count += open(nx, ny);
      }
      checkWin();
      return count;
    },
  };
}
