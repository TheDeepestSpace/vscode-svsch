# SVSCH

SVSCH is a VS Code extension MVP for generating visual block diagrams from SystemVerilog/Verilog projects.

The first implementation treats HDL as read-only, renders a diagram in a webview editor panel, and persists only layout state in `.svsch/layout.json`.

## Development

This workspace expects Node.js and npm:

```sh
npm install
npm run compile
npm test
```

Set `svsch.projectFolder` to the workspace-relative folder containing `.sv`, `.v`, `.svh`, or `.vh` files. Set `svsch.veriblePath` if `verible-verilog-syntax` is not on `PATH`.
