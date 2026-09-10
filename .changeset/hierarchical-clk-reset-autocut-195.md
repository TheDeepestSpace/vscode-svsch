---
"svsch": patch
---

Auto-cut clock/reset nets on first open even when they fan out to instance ports rather than a top-level register, by following the net into the instantiated module (recursively) to check whether it reaches a register's clock/reset pin.
