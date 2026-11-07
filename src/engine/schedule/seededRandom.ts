// Deterministic randomness: the engine only uses seeded generators, so every
// recommendation is reproducible from its seed.

/** Mulberry32: a tiny deterministic RNG returning floats in [0, 1). */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** FNV-1a 32-bit hash of a string. */
function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A stable value in [0, 1) for one player under one seed. It depends on the
 * seed as well as the id, so a new seed reshuffles everyone and no player is
 * favoured by their id or their position in a list.
 */
export function seededUnitValue(seed: number, participantId: string): number {
  return createSeededRandom(hashString(participantId) ^ seed)();
}
