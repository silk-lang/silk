/** Ordered native-corpus programs promised by the self-hosted compiler. */
export const selfhostTrack = [
  'literal',
  'foreign-libc-abs',
  'foreign-libc-pointer-roundtrip',
  'foreign-libc-floating',
  'sealed-scalar-intrinsics',
  'scalar-reference-read',
  'scalar-reference-write-through',
  // Re-add scalar-reference-argument-order when CLI profile selection lands (U8 #603).
] as const satisfies ReadonlyArray<string>
