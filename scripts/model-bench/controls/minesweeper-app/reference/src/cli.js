// Reference solution for the minesweeper-app bench task.
import * as fs from "node:fs";

import { createGame } from "./game.js";
import { render } from "./render.js";

function parseOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag.startsWith("--") || value === undefined) {
      throw new Error(`unexpected argument ${flag}`);
    }
    options[flag.slice(2)] = value;
  }
  const integer = (name) => {
    const value = options[name];
    if (!/^-?\d+$/.test(value ?? "")) {
      throw new Error(`--${name} must be an integer`);
    }
    return Number(value);
  };
  const known = new Set(["width", "height", "mines", "mines-at", "seed"]);
  for (const name of Object.keys(options)) {
    if (!known.has(name)) throw new Error(`unknown option --${name}`);
  }
  if ("mines" in options === "mines-at" in options) {
    throw new Error("pass exactly one of --mines and --mines-at");
  }
  const config = { width: integer("width"), height: integer("height") };
  if ("mines" in options) {
    config.mineCount = integer("mines");
    if ("seed" in options) config.seed = integer("seed");
  } else {
    config.mines = options["mines-at"]
      .split(";")
      .filter((entry) => entry.trim())
      .map((entry) => {
        const parts = entry.split(",").map((part) => part.trim());
        if (
          parts.length !== 2 ||
          !parts.every((part) => /^-?\d+$/.test(part))
        ) {
          throw new Error(`bad mine position "${entry}"`);
        }
        return parts.map(Number);
      });
  }
  return config;
}

let game;
try {
  game = createGame(parseOptions(process.argv.slice(2)));
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(2);
}

const actions = { r: "reveal", f: "toggleFlag", c: "chord" };
for (const line of fs.readFileSync(0, "utf8").split(/\r?\n/)) {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) continue;
  if (tokens[0] === "q" && tokens.length === 1) break;
  try {
    const action = actions[tokens[0]];
    if (!action) throw new Error(`unknown command "${tokens[0]}"`);
    if (tokens.length !== 3) throw new Error(`${tokens[0]} takes x and y`);
    if (!tokens.slice(1).every((token) => /^-?\d+$/.test(token))) {
      throw new Error("coordinates must be integers");
    }
    game[action](Number(tokens[1]), Number(tokens[2]));
  } catch (error) {
    console.error(`Error: ${error.message}`);
  }
}

process.stdout.write(
  `${render(game)}\nStatus: ${game.status}\nFlags remaining: ${game.flagsRemaining}\n`,
);
