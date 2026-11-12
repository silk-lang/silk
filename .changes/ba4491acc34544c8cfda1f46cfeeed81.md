---
bump: minor
---

Ship LLVM 23.1.5 (Clang, lld and llvm-ar) in every release archive and build with it unless `--clang` or `SILK_CLANG` names another Clang, so building programs needs no installed LLVM; a Mac with no working `xcrun` finds the Command Line Tools or Xcode SDK at its fixed path.
