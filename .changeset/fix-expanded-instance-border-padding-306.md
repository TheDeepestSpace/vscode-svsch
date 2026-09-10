---
"svsch": patch
---

Fix routed wires cutting into or running flush along an expanded module instance's border: give it the same routing obstacle border padding other node kinds get, and reject a cut-stub detour lane that clears the frame it's routing around but still runs along a second, unrelated same-row expanded frame. Also catch the case where the *original* route only grazes an unrelated frame's edge (never crossing its interior) so a detour is attempted at all, and stop exempting a pinned endpoint's lead segment from every frame — only the one frame it actually abuts.
