// Public smoke tests. SPEC.md is the full contract; these cover only basics.
import assert from "node:assert/strict";
import { createGame } from "../src/game.js";
import { render } from "../src/render.js";

const game = createGame({
  width: 3,
  height: 2,
  mines: [[2, 0]],
});
assert.equal(game.status, "ready");
assert.equal(game.flagsRemaining, 1);
assert.equal(render(game), "###\n###");
assert.deepEqual(game.cell(1, 0), {
  revealed: false,
  flagged: false,
  mine: false,
  adjacent: 1,
});

assert.equal(game.reveal(0, 1), 4);
assert.equal(game.status, "playing");
assert.equal(render(game), ".1#\n.1#");

console.log("ok");
