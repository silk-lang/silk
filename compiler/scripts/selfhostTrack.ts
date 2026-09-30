/** Ordered native-corpus programs promised by the self-hosted compiler. */
export const selfhostTrack = [
  'literal',
  'foreign-libc-abs',
  'foreign-libc-pointer-roundtrip',
  'foreign-libc-floating',
  'sealed-scalar-intrinsics',
  'scalar-reference-read',
  'scalar-reference-write-through',
  'scalar-reference-argument-order',
  'mutable-struct-loop',
  'recursive-aggregate-return',
  'inherent-member-over-module-projection',
  'generic-specializations',
  'generic-partial-type-arguments',
  'same-specialization-recursion',
] as const satisfies ReadonlyArray<string>
