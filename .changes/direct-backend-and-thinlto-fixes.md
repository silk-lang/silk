---
bump: patch
---

Fix direct x86-64 XMM parallel-move cycle clobbering, add `%fs:`/`%gs:` segment-override and `prefetch*` inline assembly support in the direct x86-64 backend, gate `@inlineAlways` MIR leaf splicing to optimized non-debug builds while releasing emitted MIR progressively, and tune ThinLTO speed builds with `-inline-threshold=500` and `-import-instr-limit=300`.
