/** Ordered native-corpus programs promised by the self-hosted compiler. */
export const selfhostTrack = [
  'literal',
  'foreign-libc-abs',
] as const satisfies ReadonlyArray<string>
