---
"svsch": patch
---

Fix "Auto Layout All" in the partial diagram pane ignoring cut net ends: the pane's own routing pass previously built each tied wire's route before its cut-end labels existed, so a released block could land its wire straight through where a label was about to be placed. Cut-end labels are now folded into the same obstacle-avoidance pass the main diagram already uses, so Auto Layout All keeps them clear of the tied wires and other blocks.
