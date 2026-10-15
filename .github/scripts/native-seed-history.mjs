// Immutable Git history predates the per-target pin. These are archival release facts, not an
// alternate active pin schema: NativeSeed.readPin accepts only schemaVersion 2.
export const historicalSeeds = (pin) => {
  if (pin.schemaVersion === 2) return Object.values(pin.seeds)
  if (pin.schemaVersion === 1 && pin.seed?._tag === 'Release') return [pin.seed]
  return []
}
