/** Ordered native-corpus programs promised by the self-hosted compiler. */
export const selfhostTrack = [
  'literal',
  'foreign-libc-abs',
  'foreign-libc-pointer-roundtrip',
  'foreign-libc-floating',
  'scalar-reference-read',
  'scalar-reference-write-through',
  'scalar-reference-argument-order',
  'mutable-struct-loop',
  'recursive-aggregate-return',
] as const satisfies ReadonlyArray<string>
