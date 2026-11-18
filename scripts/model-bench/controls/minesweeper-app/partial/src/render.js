// Partial control for minesweeper-app: misses the "X" wrong-flag rule.

export function render(game) {
  const lines = [];
  for (let y = 0; y < game.height; y++) {
    let line = "";
    for (let x = 0; x < game.width; x++) {
      const cell = game.cell(x, y);
      if (cell.flagged) line += "F";
      else if (!cell.revealed) line += "#";
      else if (cell.mine) line += "*";
      else line += cell.adjacent === 0 ? "." : String(cell.adjacent);
    }
    lines.push(line);
  }
  return lines.join("\n");
}
