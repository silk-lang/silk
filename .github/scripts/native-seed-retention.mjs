/** Releases are kept whole when any target needs them. `releases` is newest first. */
export const reasons = (releases, historyPins, current, newest = 20) => {
  const kept = new Map()
  const keep = (tag, reason) => kept.set(tag, [...(kept.get(tag) ?? []), reason])
  for (const [target, pins] of historyPins) {
    for (const { tag } of releases
      .filter(({ assets }) => assets.includes(`silk-compiler-${target}`))
      .slice(0, newest))
      keep(tag, `${target}: ${newest} newest`)
    for (const tag of pins) keep(tag, `${target}: pinned in selfhost history`)
  }
  for (const [target, seed] of current) keep(seed.tag, `${target}: current pin`)
  return kept
}
