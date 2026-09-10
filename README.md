# svsch

SystemVerilog Schematics. Make beautiful vector diagrams of your digital circuits from the comfort
of your IDE.

![svsch](hero.png)

Check out the [SVSCH Syntax Book](docs/svsch-syntax-book.md) for a visual reference of supported SystemVerilog constructs and their generated block diagrams.

## Requirements

The extension and CLI currently only support **Linux x86_64 (x64)**. The bundled Surelog binary and
the native diagram backend are prebuilt for that platform; macOS, Windows, and arm64 are not supported
yet.

Notable features:
* live updates: diagram is updated in real time after the code is updated
* source code navigation: double click on the diagram node to highlight the corresponding SV
* SVG export: diagram is exported with a complete stylesheet used in the extension and can be
  modified manually after export

## Development

Master-branch stats (unit coverage, backend coverage, CI duration, diagram-generation benchmark,
memory profiling) are published at [thedeepestspace.github.io/svsch](https://thedeepestspace.github.io/svsch/).
