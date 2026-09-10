---
"svsch": patch
---

Auto Layout now gives a free cut-net-end label's footprint to ELK as a temporary reservation on its owning node's own box (grown only on the port's side, only while a cut is active), instead of feeding the label into ELK's placement graph as a separate node. ELK's layered algorithm accounts for the reservation the same way it accounts for the node's own size — no extra layer, no extra node-separation gap — so the earlier real-node approach's leftover empty space is gone. Routing and final rendering still see the node at its canonical size; the old collision search and obstacle-avoiding stub routing remain as a safety net for whatever a same-side margin alone can't resolve.
