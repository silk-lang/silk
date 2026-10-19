# Silk lexer pressure program

This is a complete lexer written in ordinary Silk. It consumes a borrowed `&[u8]`, classifies the
same lexical surface as the canonical TypeScript lexer, and returns owned token and diagnostic
lists allocated through the public `Allocator` service.

It is deliberately an exercise, not a self-hosting milestone. The TypeScript lexer remains the
compiler implementation and differential oracle. The example exists to expose where a larger
stateful program feels natural, awkward, incorrect, or unexpectedly expensive in Silk.

The checked-in entry lexes a representative declaration. The acceptance harness substitutes only
the marked input and fingerprint literals to run its systematic corpus; the lexer body itself is
never generated. See [findings.md](findings.md) for the walls discovered while building it.
