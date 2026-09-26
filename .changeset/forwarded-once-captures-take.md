---
'@silklang/compiler': patch
---

Anonymous callables that invoke a captured `once fn` now take that environment, and those invoking a
captured `mut fn` borrow it exclusively, so forwarded owned captures are cleaned exactly once.
