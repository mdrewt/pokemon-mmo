// Shared affinity → colour palette, used by the box and battle UIs so same-affinity monsters and
// skills read consistently. A presentation stand-in (no game rule) until real per-species art.

export const AFFINITY_COLOR: Record<string, string> = {
  Neutral: '#9aa3b2',
  Fire: '#e2553c',
  Water: '#2f8fe0',
  Nature: '#5cbf5c',
  Electric: '#e6c534',
  Earth: '#b8865a',
  Light: '#f0e08a',
  Dark: '#7a5fb0',
};

/** Affinity colour for a tag, falling back to the neutral grey. */
export function affinityColor(tag: string): string {
  return AFFINITY_COLOR[tag] ?? '#9aa3b2';
}
