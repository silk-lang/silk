---
bump: minor
---

A signature writes `'_` for each lifetime of a nominal type it elides, as in `fn find(tree: &UiTree<'_>) -> usize`, elided result lifetimes follow Rust's rules (a borrowed receiver, else the one input lifetime), and `silk check --fix` or the editor quick fix inserts a missing `'_`.
