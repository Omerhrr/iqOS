export function wilsonLowerBound(w: number, n: number): number {
  if (n <= 0) return 0
  const z = 1.96, p = w / n, d = 1 + (z * z) / n
  return Math.max(0, (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d)
}
