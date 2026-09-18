// Cheap gaussian-ish noise (sum of uniforms) - faster than Box-Muller for 1s ticks.
export function gaussLike(): number {
  return (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 0.87
}
