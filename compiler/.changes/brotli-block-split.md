---
bump: patch
---

Split Brotli meta-blocks into block types with their own prefix codes from quality 5 (literals at qualities 10 and 11), and smooth histograms toward runs before building prefix codes from quality 4, as the reference `brotli` does
