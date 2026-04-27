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

Visual regression tests use Playwright. After `npm install`, install Chromium and its system dependencies with:

```sh
npx playwright install --with-deps chromium
```

Then run:

```sh
npm run test:visual
```

Set `svsch.projectFolder` to the workspace-relative folder containing `.sv`, `.v`, `.svh`, or `.vh` files. Set `svsch.veriblePath` if `verible-verilog-syntax` is not on `PATH`.

## TODOs

Random list of things to improve
* use Selenium for behavioral testing
* do regression testing via image comparison
* add shapes and port arrangement for common modules like IO, registers, muxes, etc.
* allow dragging around multiple modules at a time
* supporting multi-bit wires (buses, etc.)
* supporting interfaces
* supporting structs both in combinational inputs and registers (with ability to expand)
* add line jumps like in draw.io
* make the grid more like the schematic grid
* let labels be draggable
* make clk inputs have special input type on registers
* allow annotations a la `// svsch: ALU A input selector`
* allow expanding nested blocks or combinational blocks
* convert comments in SV into notes
* fix that bug with vertical segment not being movable
* nested cases, cases with combinational blocks, etc.
* figure out why the webview is not reappearing after reloading window
* configurable fonts
* use sass for stylsheets
* separate test extractor into a seaprate IR executable
