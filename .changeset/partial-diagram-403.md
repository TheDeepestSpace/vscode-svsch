---
"svsch": minor
---

Add a v1 "Partial Diagram" feature: select one or more nodes in the main diagram and click "Add to Partial [P]" to clone them (all wires cut) into an ephemeral "SVSCH Partial Diagram" pane. Hovering a cut-net end reveals an "Extend" arrow that pulls in every node on that net (all branches, for a fanout net) and ties it within the partial. Selecting one or more blocks inside the pane and clicking "Remove [⌫]" (or pressing Backspace/Delete) takes them back out again, along with any of their own not-yet-expanded cut ends; a net still tied to a remaining node reverts to a cut end there. The pane is reused by subsequent "Add to Partial" clicks and its state is fully discarded on close. The pane's toolbar also has an "Export SVG" button, same as the main diagram, saving the partial's current view (cut ends included) to `<module>_partial.svg`.
