/** Ordered native-corpus programs promised by the self-hosted compiler. */
export const selfhostTrack = [
  'literal',
  'scalar-reference-read',
  'scalar-reference-write-through',
  'scalar-reference-argument-order',
] as const satisfies ReadonlyArray<string>
