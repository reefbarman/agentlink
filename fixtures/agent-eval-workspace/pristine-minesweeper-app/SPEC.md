# Minesweeper: specification

Build a Minesweeper game engine, a text renderer and a command-line app in plain
JavaScript (Node.js ES modules, no dependencies). This spec is the source of
truth: `npm test` only covers a few basics, and the work will be checked against
everything below.

Files:

| File            | Status                  | Purpose                                     |
| --------------- | ----------------------- | ------------------------------------------- |
| `src/rng.js`    | Provided, do not change | Deterministic mine placement (`placeMines`) |
| `src/game.js`   | Implement               | Game engine (`createGame`)                  |
| `src/render.js` | Implement               | Text renderer (`render`)                    |
| `src/cli.js`    | Implement               | Command-line app                            |
| `test/`         | Provided, do not change | Public tests                                |

You may add more modules under `src/`.

## Coordinates

`x` is the column (`0` to `width - 1`, left to right) and `y` is the row (`0` to
`height - 1`, top to bottom). A cell's neighbours are the up to 8 cells around it
that are on the board.

## Engine: `src/game.js`

### `createGame(options)`

Returns a new game object. Options:

- `width`, `height`: integers from 1 to 200. Anything else throws `RangeError`.
- Exactly one of the following. Passing both, or neither, throws `TypeError`.
  - `mines`: an array of `[x, y]` mine positions. Each must be an on-board
    integer pair with no duplicates, and at least one cell must be left without a
    mine. Otherwise throw `RangeError`.
  - `mineCount`: an integer from 0 to `max(0, width * height - 9)`. Otherwise
    throw `RangeError`. Mines are placed on the first reveal (see below).
- `seed`: integer seed used with `mineCount`. Default `1`. Ignored with `mines`.

### Game object

Properties:

- `width`, `height`: board size.
- `mineCount`: total number of mines (`mines.length` or `mineCount`).
- `status`: one of `"ready"`, `"playing"`, `"won"`, `"lost"`.
- `flagsRemaining`: `mineCount` minus the number of flagged cells. It can go
  negative.

Methods. Every method that takes `x, y` throws `RangeError` if they are not
integers on the board. This check happens first, in every status.

- `cell(x, y)` returns a new plain object
  `{ revealed: boolean, flagged: boolean, mine: boolean, adjacent: number }`, where
  `adjacent` is the number of neighbouring mines (also for mine cells). Before a
  `mineCount` game places its mines, every cell has `mine: false` and
  `adjacent: 0`.
- `reveal(x, y)` returns the number of non-mine cells it newly revealed.
- `toggleFlag(x, y)` returns the cell's new `flagged` value.
- `chord(x, y)` returns the number of non-mine cells it newly revealed.

### Status

- A new game is `"ready"`. It becomes `"playing"` on the first reveal that
  changes the board. Flagging alone does not start the game.
- When the game is `"won"` or `"lost"`, `reveal` and `chord` return `0` and
  `toggleFlag` returns `false`, without changing anything.

### Revealing

`reveal(x, y)` on a cell that is already revealed or is flagged does nothing and
returns `0`. Otherwise:

1. **First reveal of a `mineCount` game:** place the mines first, using
   `placeMines(width, height, mineCount, seed, safeCells)` from `src/rng.js`,
   where `safeCells` is the revealed cell plus all of its neighbours. The first
   reveal can therefore never hit a mine.
2. **Mine:** the game is lost. The cell is revealed, and so is every other mine
   that is not flagged. Flags stay as they are. Returns `0`.
3. **Safe cell:** reveal it. If its `adjacent` count is 0, also reveal its
   neighbours, repeating for every newly revealed cell with `adjacent` 0 (flood
   fill). Flood fill never reveals or unflags a flagged cell. This must work on a
   200 × 200 board.
4. **Win:** when every non-mine cell is revealed, the game is won and every mine
   becomes flagged (so `flagsRemaining` is 0).

### Flags

`toggleFlag(x, y)` flags or unflags an unrevealed cell. On a revealed cell it
does nothing and returns `false`.

### Chording

`chord(x, y)` applies only to a revealed cell with `adjacent` greater than 0 whose
number of flagged neighbours equals its `adjacent` count. Then it reveals every
neighbour that is neither revealed nor flagged, exactly as `reveal` would
(including flood fill, losing on a mine, and winning). In every other case it
does nothing and returns `0`.

## Renderer: `src/render.js`

`render(game)` returns the board as text: one line per row, top to bottom, one
character per cell, lines joined with `"\n"` and no trailing newline. For each
cell, use the first rule that applies:

| Cell                                          | Character |
| --------------------------------------------- | --------- |
| Flagged, not a mine, and the game is `"lost"` | `X`       |
| Flagged                                       | `F`       |
| Not revealed                                  | `#`       |
| Revealed mine                                 | `*`       |
| Revealed, `adjacent` is 0                     | `.`       |
| Revealed, `adjacent` is 1 to 8                | the digit |

## App: `src/cli.js`

Run as `node src/cli.js <options>`. Options:

- `--width <n>` and `--height <n>`: required.
- Either `--mines <count>` (with optional `--seed <n>`, default 1), or
  `--mines-at "<x>,<y>;<x>,<y>;..."` for explicit positions. Exactly one of
  `--mines` and `--mines-at` is required.

If the options are missing or invalid (including any error from `createGame`),
print one line starting `Error:` to stderr and exit with code 2.

Then read commands from stdin, one per line. Tokens are separated by any
whitespace, and blank lines are ignored:

| Command | Action                                   |
| ------- | ---------------------------------------- |
| `r x y` | `reveal(x, y)`                           |
| `f x y` | `toggleFlag(x, y)`                       |
| `c x y` | `chord(x, y)`                            |
| `q`     | Stop reading; ignore any remaining input |

An unknown command, the wrong number of arguments, coordinates that are not
integers, or coordinates off the board: print one line starting `Error:` to
stderr and continue with the next line.

When input ends (or after `q`), print to stdout the `render` output followed by
these two lines, each line ending in `"\n"`, and exit with code 0:

```text
Status: <status>
Flags remaining: <flagsRemaining>
```

Example, for `--width 3 --height 2 --mines-at "2,0"` and input `r 0 1`:

```text
.1#
.1#
Status: playing
Flags remaining: 1
```
