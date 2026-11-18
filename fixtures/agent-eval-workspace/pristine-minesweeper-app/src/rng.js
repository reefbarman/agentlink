// Deterministic mine placement. Provided by the spec: do not change this file.

/** Seeded pseudo-random number generator returning floats in [0, 1). */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Pick `count` mine positions, never on a cell in `safeCells`.
 * @param {number} width
 * @param {number} height
 * @param {number} count
 * @param {number} seed
 * @param {Array<[number, number]>} safeCells
 * @returns {Array<[number, number]>} `[x, y]` positions sorted by y, then x.
 */
export function placeMines(width, height, count, seed, safeCells = []) {
  const safe = new Set(safeCells.map(([x, y]) => `${x},${y}`));
  const candidates = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!safe.has(`${x},${y}`)) candidates.push([x, y]);
    }
  }
  if (count > candidates.length) {
    throw new RangeError(
      `cannot place ${count} mines in ${candidates.length} cells`,
    );
  }
  const random = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(random() * (candidates.length - i));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, count).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}
