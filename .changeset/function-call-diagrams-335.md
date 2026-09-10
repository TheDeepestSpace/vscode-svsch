---
"svsch": patch
---

Extract SystemVerilog function/task declarations and call sites from UHDM, render function/task calls as distinct node kinds, and let each call-site's Expand button unfold its body in place (read-only, auto-laid-out) with persisted expansion state — double-click is a no-op for these kinds, since a call site has no standalone module of its own to navigate to.
