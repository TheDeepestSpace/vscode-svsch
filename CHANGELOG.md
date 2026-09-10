# svsch

## 0.5.0

### Minor Changes

- 3215b22: Add an "Auto Layout All" toolbar button that re-lays out every block in the current module, using existing block positions as layout hints.
- dabcac1: Support structural combinational feedback loops (e.g. cross-coupled NAND SR latches): the loop renders as a cyclic feedback edge between the gates, the edges that close it are stamped with `combFeedback` metadata, and a per-loop warning diagnostic names the signals involved. Clocked feedback through registers/latches is never flagged.
- e07c97e: Represent declaration-only memories (e.g. `logic mem [0:N-1];` read via `assign instr = mem[addr];` with no procedural write) as a register-kind source node feeding the read mux, instead of leaving its `in` port silently dangling. The synthesized node is flagged `inferred` with a `reason`, and surfaces a warning diagnostic explaining the memory is declared but never written.
- 175f1f8: Add `svsch.fileList` setting to compile a project from a Surelog filelist (`-f`) instead of walking `svsch.projectFolder`, for multi-directory projects, explicit compile order, or library-style resolution.

### Patch Changes

- eee0eb3: Render repeated concat-LHS register branches as one aggregate priority-mux chain with a single final breakout.
- 1fc1a62: Fix `publishCiDurationHistory` CI script: a transient network failure on the `gh-pages` fetch or worktree checkout now retries along with the push, instead of throwing immediately and skipping the existing 3-attempt retry loop.
- 8b0cc68: Fix coverage-summary CI script: a gh-pages publish timeout no longer discards a successfully-parsed coverage summary, since the publish step is now in its own try/catch instead of sharing one with the summary parsing. When publishing fails, the comment now says so explicitly and links to the failing run instead of silently dropping the report link.
- a38da3d: Fix `Cut out`: the cut instance and the newly-created cut-net-end stub(s) landing on it are now reselected after the operation, so the group can be dragged immediately instead of requiring a manual reselect. Only the stub(s) directly attached to the cut-out instance join the group — the corresponding stub at the far end of each net, attached to whatever it was already connected to, is left alone.
- f0405a9: Bump globals from 17.11.0 to 17.12.0
- cfbc14b: Bump js-yaml from 5.3.0 to 5.4.0
- 61c6767: Bump softprops/action-gh-release from 3.0.2 to 3.0.3
- 6c6f7f7: Bump typescript-eslint from 8.67.0 to 8.68.0
- 2649029: Bump typescript-eslint from 8.68.0 to 8.69.0
- e7ff2d9: Bump @types/node from 26.2.0 to 26.3.0
- 1f36d4c: Bump @types/node from 26.3.0 to 26.4.0
- abafec4: Bump @types/vscode from 1.134.0 to 1.136.0
- d2363fb: Add a static orphaned-snapshot checker (`npm run test:snapshots:check-orphans -- <visual|system|bdd|all>`) that flags visual/system/BDD baseline files with no live test producing them, and wire it into CI as `check_snapshot_orphans`.
- ecaaf9f: Order bus and array breakout taps and slice-composition inputs MSB-first, including their top-to-bottom diagram layout.
- bebc499: Fix multi-bit array-breakout taps rendering stacked instead of thick
- 4040e17: Fix CI npm cache poisoning: non-`setup` jobs now use `actions/cache/restore` (read-only) for `node_modules` instead of `actions/cache`, preventing a stale restore from being re-saved under the current lockfile's key and masking a skipped `npm ci`.
- fc041e1: Fix nested ternary mux nodes reusing the whole assign statement's source range instead of their own sub-expression's range.
- 4e26965: Bump transitive js-yaml from 4.3.1 to 4.3.2 to fix high-severity DoS advisory (GHSA-2883-xcg3-v3hh)
- 890805c: Render chained logical `&&` and `||` expressions as n-input gates instead of opaque combinational blocks.
- f03b65e: Bump fast-uri and qs transitive dev dependencies to fix security audit findings
- c89a3f4: Fix gh-pages push races across PR-stats CI scripts (coverage, benchmark, CI-duration, and memory stats): concurrent workflow runs publishing to `gh-pages` at the same time could clobber each other's commits. All publish steps now serialize through a shared concurrency group instead of racing independently, and are additionally chained via `needs` so no more than one job claims the group's single pending slot at once — GitHub Actions cancels a still-pending job when a new one queues for the same group, which was silently dropping PR-stats jobs whenever three or more became ready at the same instant.
- da2e84f: Fix CI scripts that publish to `gh-pages` (`ci-duration.mjs`, `generate-coverage-stats.mjs`, `trim-benchmark-history.mjs`, `generate-benchmark-stats.mjs`, `generate-ci-duration-stats.mjs`) and the two `ci.yml` baseline-fetch steps to use `git fetch --depth=1` instead of a full fetch. None of these need `gh-pages` history — they only read the current tree via `worktree add --detach` or `git show`. `gh-pages`' full history has grown to several GiB from historical BDD video blobs, pushing full-fetch time to the edge of the network timeout; a shallow fetch bounds cost to the current tree size regardless of how large history grows.
- 568449d: Add `os`/`cpu` restrictions (`linux`/`x64`) to `package.json` so `npm install -g svsch` fails fast with a clear "Unsupported platform" error instead of installing a broken CLI on macOS, Windows, or arm64. Document the Linux x86_64-only requirement in the README, since the bundled Surelog binary and native diagram backend are prebuilt for that platform only.
- ce70575: Persist every node's resolved position and every edge's resolved route into the layout snapshot on each render, not just explicitly pinned nodes or manually-dragged routes, so an auto-laid-out (never-dragged) module can still recover its layout after a crash.
- 62291ad: Restore Open VSX Registry publishing (`npx ovsx publish`) in the release script, needed so `svsch` can be installed in Cursor and other Open VSX–based editors. Falls back gracefully (`|| echo 'Open VSX skipped'`) if `OVSX_PAT` is missing or expired, so a publish failure here won't block the npm package publish or VSIX/GitHub release attachment.
  
  Note: this requires a repo admin to add an `OVSX_PAT` secret (Settings → Secrets and variables → Actions) for a real Open VSX publish to happen — until then the fallback will silently no-op.
- f713088: Re-add the `test/system` video gallery (`publish_system_videos`, `comment_video_galleries`, and the `vscodeVideo`/JSON reporter config in `test/system/playwright.config.ts`) that had been silently dropped by a stale branch merge.
- 3c7a0e4: Fix backend coverage publishing to shallow-fetch `gh-pages` and retry fetch timeouts instead of aborting after the first attempt.
- 05796ea: Record per-scenario videos in the `test/system` suite (across the 3-way `vscode_version` matrix) and publish them to a gh-pages gallery, mirroring the BDD video gallery added in #275.

## 0.4.1

### Patch Changes

- 1ea7491: Add an icon for the VS Code extension listing.
- 495a83f: Highlight new (green), modified (orange), and removed (red) scenario cards in the BDD video gallery, with New/Modified/Removed/Unchanged/All filters alongside the existing search box. `publish_bdd_videos` now fetches the PR base ref and diffs `test/features/**/*.feature` against head to classify each scenario.
- 122c972: Bump changesets/action from 2.1.0 to 2.1.1
- 0041e84: Bump docker/setup-buildx-action from 4.2.0 to 4.3.0
- 0acf19a: Bump multiple-cucumber-html-reporter from 4.2.0 to 4.3.0
- fa6b9e6: Bump svgo from 4.0.2 to 4.1.0
- 40f2de0: Bump @types/vscode from 1.125.0 to 1.134.0
- b8a77db: Bump @vitejs/plugin-react from 6.0.3 to 6.1.0
- fd26251: Fix action buttons (e.g. edge/connection controls, port selection handles) scaling with canvas zoom instead of staying a constant screen size. Buttons are now counter-scaled against the current zoom level so they render at a fixed visual size regardless of zoom.
- aa79945: Fix flaky `nested-case-literal-collision-canvas` visual test by widening its screenshot diff tolerance to account for observed CI-only sub-pixel antialiasing noise (~81px) that isn't a real rendering regression.
- 49a5e64: Fix BDD video gallery labels for Scenario Outline rows so each example is labeled correctly instead of collapsing to the outline title.
- 4121125: Preserve declared operand widths in concatenated case selectors when a module is discovered through an instance.
- 75a9c2c: Refactor node rendering: split the monolithic `HdlNode.tsx` if-chain into self-contained per-kind components (register/latch, replicate, literal, inverter, mux/select, alu, comb/loop, instance, port) that each call a shared `HdlNodeBase`, and dedupe the `isBusComposition()` ternary, the `hasArrayConnection`/`arrayConnectionThick` helpers, and the array-stack-skin rect JSX that were copy-pasted across every node-kind SVG file. No render/visual changes — verified with a new render-snapshot regression test covering every node kind. Bus/struct/interface rendering is intentionally left as-is for a follow-up (tracked in issue #172).
- 8bb9317: Add a trailing 10-run moving average overlay per series (elaboration/rendering) to the "Visual suite — historical average per master run" trend chart in PR stats comments, drawn dotted and dimmed behind the raw lines.

## 0.4.0

### Minor Changes

- c6d111e: Extend the `alu`/`inverter` "operator → dedicated node kind" pattern to ALU-style case arms selected by a `case` statement (e.g. an `alu_op` mux). Bitwise/logical `&`/`|`/`^`/`&&`/`||` now get a dedicated `gate` node, comparisons (`<`, `<=`, `>`, `>=`, `==`, `!=`, `===`, `!==`) get a dedicated `comparator` node with a 1-bit output, and a new `zext` node is inserted when a case arm's driving signal is narrower than the mux's resolved output width.
- 64bba8d: Add "Expand" to the selection toolbar for a single selected instance node: unfolds that instance's own module diagram in place inside the parent canvas. Boundary ports render as label-only nodes with a wire stub on each side, and each stub carries the same struct/interface/multi-bit styling as the wire it continues. Inside the frame, the child's IO ports are replaced by cut net ends sitting exactly where the ports sat in the child's own standalone view — there is no auto-routed wire between the frame's boundary labels and the content, so the child's own wire routing is preserved verbatim (and a net already cut at a port collapses to a no-op: its content-side cut ends were already there); nodes and wires inside the expanded module are read-only and always stay within the module's border — the only place to edit that module's own layout, including expanding one of its own instances, is its own standalone view, and any changes there are reflected the next time it's viewed expanded, growing or shrinking the frame to fit. That mirroring includes the child module's own expanded instances: an instance expanded in the child's standalone diagram shows expanded inside the child's spliced sub-diagram too, recursively to any depth (a recursively-instantiated module stays collapsed rather than unfolding forever). Drag-selection is scoped to the top-level diagram (sub-diagram content is exempt), so Auto Layout over a selection containing an expanded instance re-lays out the outer diagram and carries the expanded content along. Array-of-instances nodes are not yet supported (tracked in #169). A "Collapse" control in the selection toolbar reverts an expanded instance back to a normal node. The sub-diagram area inside the frame behaves like ordinary canvas — middle-drag pans there, and clicks fall through instead of grabbing the expanded instance; the frame itself is selected/dragged from its border ring (header rows, boundary-label columns, bottom inset), where its ports and instance name live. Expanding a top-level instance that grows past a neighboring block is free to overlap it — run Auto Layout on the diagram afterward to clear the overlap. SVG export (both the extension's Export SVG button and `svsch render`) includes each expanded instance's spliced sub-diagram — dimmed backdrop, boundary ports, and internal content — instead of the flat collapsed box.
- 68ece7c: Render `inout` ports with a distinct bidirectional skin and aligned source/target handles across boundary, instance, combinational, aggregate, struct, and interface nodes.
- 9ea0a7e: Add r/t/c keyboard shortcuts and glyph badges for edge/net controls, plus a `c` shortcut and badge for the block-selection toolbar's Cut out button.

### Patch Changes

- e229df2: Array-backed mux inputs are now labeled `in[[N]]` instead of `in[N]` to distinguish them from bit-sliced ports.
- 64bba8d: Record per-scenario videos in the BDD suite and fix the CI copy step so Playwright traces and videos actually land in the `bdd-artifacts` upload.
- 6c89d90: Bump eslint-plugin-react-hooks from 5.2.0 to 7.1.1
- 1761e4b: Bump @eslint/js from 9.39.5 to 10.0.1
- 09569d1: Bump globals from 16.5.0 to 17.11.0
- be3efc6: Bump js-yaml from 5.2.2 to 5.3.0
- c4ed47e: chore(deps-dev): bump @changesets/cli from 2.31.0 to 3.0.0
- be3efc6: Bump js-yaml from 5.2.2 to 5.3.0
- ee41bdb: Dim automatic cut-net labels on inactive generate-arm wires to match the rest of the dimmed route. When a declared net is driven by more than one mutually exclusive generate arm, every arm's edge is still auto-cut (none are left wired directly into the output), but only one overlapping sink cut end renders at the shared target port instead of stacking a redundant one on top.
- 7ee4891: Add ESLint (flat config) and Prettier for `src/`, `test/`, and `scripts/` TS/TSX/JS code, with a 100-character line limit enforced in both, wired into CI's Lint step. No runtime behavior changes.
- 312a0fc: Fix continuous variable-index reads from locally written arrays (e.g. `assign read_data = ram[addr];`) emitting a duplicate `select` node alongside the read mux. Arrays with parameterized-but-elaborated unpacked extents are now registered in `mod.arrayDimensions` up front, so the continuous read lowers once to the scalar read mux.
- 9fa0b99: Fix parameterized procedural concatenations (e.g. `{(DATA_WIDTH-4){instr[3]}}, instr[3:0]}`) mislabeling their concat operand widths (e.g. `[1]`/`[0]` instead of `[7:4]`/`[3:0]`) even though the overall output width was correct. Replication and aggregate widths are now resolved before concat inputs are relabeled, and width resolution now falls back to inferring a width from a slice embedded in the operand's signal name.
- 164f571: Fix the write-address mux for a whole-array reset loop (e.g. `for (int i = 0; i < N; i++) regs[i] <= '0;`) losing its selector wiring when the array's size bound is a parameterized expression like `(1<<ADDR_WIDTH)`. UHDM doesn't fold that bound to a constant the way it does for the array's own elaborated declaration range, so the reset loop was misdetected as an ordinary variable-index write keyed on the loop variable `i` — which has no driver — instead of being folded into the register's R/RV ports. The loop-bound expression is now evaluated by walking its operand tree and resolving parameter references against the module's own declared defaults.
- f19d947: Fix array-stack lead stubs rendering as visible duplicate/overlapping marks where they met the array net's own stacked lines (mux `sel`/side ports, register D/Q/R, array ports). Leads now extend exactly to where the routed wire's matching layer begins, so the two form one continuous, seamless line.
- 7eaac3b: Fix duplicate register nodes, multi-driver D inputs, and displaced layout for conditional concat-LHS register assignments. Also fix a regression where the bus-composition node for a concat-LHS register (e.g. `{a[2], a[1:0]} <= ...`) wired the pre-register combinational value into the merge instead of the registers' Q outputs, leaving the registers disconnected.
  
  Also fix multi-bit constant part-select registers (e.g. `a[1:0]`) reporting a 1-bit D/Q width instead of their real width, which under-sized their wires and threw off the total width of any bus-composition node they fed into.
  
  Also fix bus-composition nodes leaving a literal RHS concat segment (e.g. the `1'b0` in `{data_reg, 1'b0}`) unconnected: no node was ever synthesized for the literal, so its port dangled with no wire.
- 029117f: Fix the shared sink cut-net label on a declared net driven by mutually exclusive generate arms rendering dimmed when the target port is actually always driven by whichever arm is active. The dedupe now keeps the active arm's label instead of whichever arm's edge id happened to sort first.
- 36615c5: Fix intermediate signal name collisions between nested `case` statements that reuse the same item label (e.g. two unrelated nested `case`s each with a `2'b01` item). Branch names are now scoped by the full nesting path instead of the item's own label alone, so unrelated literal nodes no longer fight over one synthesized signal name.
- ff1c7e1: Fix a bus breakout tap (e.g. `data_i[3:0]`) rendering as a thin single-bit wire on the source side of the connection when the breakout came from separate procedural statements (`always_comb begin hi_o = data_i[7:4]; lo_o = data_i[3:0]; end`) rather than a continuous `assign`. UHDM doesn't report a usable width for a numeric part-select taken from a reg-driven (procedural) LHS the way it does for a net-driven (continuous-assign) one, so the tap's width now falls back to the slice embedded in its own signal name.
- 4c511c0: Fix an unconditional `always_comb` assignment whose RHS is a bus composition or replication (e.g. `imm = {{(DATA_WIDTH-4){instr[3]}}, instr[3:0]};`) rendering with a spurious "COMBINATIONAL" box between the composition and the output port, where a plain wire was expected. The block only has one statement, so there's nothing for the extra node to disambiguate — it existed only because procedural assignments route the RHS through a `<signal>_next` intermediate name, which now no longer applies to concat/replication RHS in this single-statement case, matching how inverter RHS was already handled.
- 1ad6bcf: Fix a spurious `zext` node appearing on case arms whose RHS is a procedural concatenation with a parameterized replication count (e.g. `imm = {{(DATA_WIDTH-4){instr[3]}}, instr[3:0]};`). UHDM doesn't always fold a parameterized repeat-count expression to a constant when the replication is nested inside a concat operand, so the replication's width was momentarily seen as 1 bit at the point `lowerCaseStatement` decided whether the case arm needed zero-extension into the mux — inserting a zext that a later width-repair pass could no longer retract even after it corrected the replication's own width. The repeat count is now resolved from known parameter values as soon as the replication node is created, so the correct width is visible immediately and no zext is inserted when none is needed.
- fb9f19c: Lower the React Flow `minZoom` floor to 0.05 to allow zooming out further on large diagrams.
- 930bcb0: Update the README hero image.
- 16d703b: Retighten visual regression pixel budgets after measuring legitimate rendering noise across the visual, BDD, and system suites.
- 0c18655: Fix parameterized register-array reset, read, and write connections so every diagram input has one stable source.
- 65b5451: Add vitest coverage baseline for the TS frontend: `npm run test:coverage`, v8 coverage config, and a CI step uploading `coverage/lcov.info` as an artifact.

## 0.3.0

### Minor Changes

- 5f7864e: Add first-class boolean gate nodes (AND/OR/XOR/NAND/NOR/XNOR) with n-ary flattening for same-operator chains (`a&b&c&d` renders as one 4-input AND instead of a cascade), replacing the undifferentiated `comb` blob these expressions previously collapsed into. `(a|b)&c` still renders as OR-feeding-AND — flattening never crosses operator types. NOT already had a dedicated `inverter` glyph and is unchanged. Gate input ports fan out one full grid line apart regardless of input count, growing the gate body to fit instead of falling back to tighter centered spacing for 4+ inputs.
- 24aa5c5: Auto-cut register clock/reset nets and explicitly declared nets when opening a module diagram without a saved layout.
- c787f03: Add grow-only edge/corner resize for `instance` and `register` blocks, with a hover/select-only control to revert to the automatic size.
- 3d5a983: Add a "Cut out" button to the block-selection toolbar that cuts every wire touching the selected block(s), shown from a single selected block onward and merged with "Auto Layout" into one button group when both are visible. Hidden (rather than disabled) once every touching net is already cut, and no longer appears when only a cut net's dangling end is selected.
- 0971ea1: Collapse `[MSB:LSB]` instance arrays into a single stacked instance node instead of emitting N separate nodes with N redundant submodule elaborations. The extractor now detects UHDM's `vpiModuleArray` container, elaborates the submodule once, and stamps the collapsed node with `isArrayNode`/`arrayDimension`/`arraySize`, reusing the existing array-stack rendering. Per-port connections are classified as broadcast vs element-wise per LRM 23.2.
- 35a2762: Add `svsch.minifySvg` config (default on) gating SVGO minification of exported SVGs. Minification runs at export write points (CLI render, extension's exportSvg) — use `--no-minify` in the CLI to opt out.
- 875d245: Render ternary conditional expressions as recursively connected mux nodes in both parser backends.

### Patch Changes

- f76465c: docs: add 8-bit single-cycle CPU example design fixtures, hero preview image, and syntax book reference to README
- 24556c6: chore(deps-dev): bump multiple-cucumber-html-reporter from 4.1.0 to 4.2.0
- 6c0a036: chore(deps-dev): bump @types/node from 26.1.0 to 26.2.0
- d8ef746: chore(deps-dev): bump vite from 8.1.3 to 8.2.0
- 66be5c3: chore(deps): bump actions/cache from 4.3.0 to 6.1.0
- ff3b0b4: chore(deps): bump actions/checkout from 4.4.0 to 7.0.1
- 67dbcf1: chore(deps): bump actions/download-artifact from 4.3.0 to 8.0.1
- 23406c8: chore(deps): bump actions/setup-node from 4.4.0 to 7.0.0
- 07a8ba1: chore(deps): bump actions/upload-artifact from 4.6.2 to 7.0.1
- e636337: chore(deps): bump docker/build-push-action from 5.4.0 to 7.3.0
- 9cf1f31: chore(deps): bump docker/login-action from 3.7.0 to 4.6.0
- c7740b6: chore(deps): bump docker/metadata-action from 5.10.0 to 6.2.0
- 0bd8086: chore(deps): bump docker/setup-buildx-action from 3.12.0 to 4.2.0
- 69b8544: Fix duplicate selection outlines on shaped nodes (scalar mux, select, ALU, and inverter) by removing the redundant rectangular selection element and relying on the node's own SVG shape outline for selection. Array-node selection rectangles are unchanged.
- b3cfd4f: Fix bus composition nodes synthesized from multi-bit unpacked-array elements (e.g. `logic [7:0] arr [3:0]` driven element-by-element and read back as a whole) collapsing each element's width to 1 bit. The composer now uses the array's declared element width instead of treating the `[i]` index as a packed-bus bit slice.
- 438924b: Fix stacked instance-array nodes drawing their left-side (input) port leads on top of the node body, obscuring the `u_child[0]` label, in both the live canvas and exported SVG. CSS z-index doesn't govern paint order for these elements — only raw draw order does — so the front (topmost) card must be the very next element painted after the leads, ahead of the back/middle stack layers, or the leads still bleed through.
- 210e97a: Fix a continuous-assign bug where composing a packed output bus bit-by-bit from array-element reads (e.g. `assign y_bus[i] = y_arr[i];`) dropped the driving edges entirely, leaving the output port unconnected. The alias node representing each bit was deleted before the later pass that stitches those bits into the bus had a chance to consume it.
- fc8f1fb: Fix stacked-instance nodes keeping stale port/edge geometry after a resize drag. React Flow's internal `node.measured` dimension could stay on its pre-resize value when rapid-fire `updateNodeInternals` calls during a multi-step drag raced each other in React Flow's store, most noticeably on slower-to-render stacked/array instance nodes. An extra forced update is now scheduled via `requestAnimationFrame` once the drag's call flurry has drained.
- 46296ff: Fix duplicate address-mux generation when an array has multiple indexed write statements in the same always block. Distinct normal writes now share one array register and chain through address-mux stages, while proven full-range reset loops fold into that register's canonical reset and reset-value ports.
- af774a5: Increase BDD test wait timeouts for the module selector and SVSCH panel tab to reduce CI flakiness under runner resource contention.
- 026c0f1: Fix `captureGraphState()` grabbing the wrong `<path>` for an edge in the visual-regression harness. It selected the first path in the edge's DOM group, which is a jump-halo arc or net-highlight overlay when either is present, instead of the real wire stroke — causing flaky full-route vs tiny-arc JSON diffs with zero PNG diff. Now scoped to `path.svsch-edge`, the class token only the actual stroke paths carry.
- beab4bc: Fix instance-port connections that use a bit-select or literal inline (e.g. `.opcode(instr[7:4])`, `.b(8'd1)`) being silently dropped from the diagram. The instance-port-connection loop now synthesizes the same breakout/literal driver nodes that `processAssign` creates for `assign` statements, so `DesignExtractor::buildEdges`'s exact signal-string matching finds a node to connect to.
- 32c42c0: Fix interface type labels falling back to the browser's serif default instead of the editor font. `.svsch-interface-type-label` had no `font-family`, so it inherited nothing from its SVG ancestors; now set to `var(--vscode-editor-font-family, monospace)` to match the rest of the diagram's text.
- 6a496a7: Fix cut-net-end label highlighting so a marquee-selected block no longer lights up its attached (but unselected) net label's halo/hovered-text. React Flow auto-selects a label's stub edge whenever the block it's attached to is selected; only genuine hover or the label's own `selected` prop now drives the highlight.
- 4a9e119: chore(deps): bump undici, fast-uri, and brace-expansion to clear npm audit high-severity findings
- f151b86: chore(deps): pin transitive js-yaml to patched versions (4.3.1 / 3.15.1) to clear the npm audit high-severity quadratic-CPU finding (GHSA-5p4m-2wfm-xmqj)
- 5c48866: chore(deps): pin transitive js-yaml to patched versions to clear npm audit high-severity finding (CVE-2026-59870)
- 0e247a4: chore(deps-dev): bump nanoid to 3.3.18 (transitive via postcss) to resolve a high-severity `npm audit` advisory (GHSA-2v37-7h3g-55p8) blocking CI
- d9f6a23: Regenerate the syntax-book, visual-regression, and CLI snapshot fixtures that were left stale by the webview CSS split (#157) — they still embedded webview-chrome-only rules (`.shell`, `.busy-indicator`, `.toolbar`, etc.) that no longer belong in exported SVG output since those selectors never match anything in the exported document.
- 6b69676: Fix spurious "No files were found" artifact warning in the test_syntax CI job.
- ef47a73: Fix a race in `extractDesignWithUhdm` where two concurrent calls for the same workspace could spawn Surelog against the same `cacheDir` simultaneously, corrupting one process's partial write and crashing the other's read (`kj::io ... Premature EOF`). Concurrent calls are now serialized per-`cacheDir`: a later caller waits for the earlier one to finish and re-checks the cache before spawning Surelog again.
- c1ddd85: Fix `npm run test:visual` never actually failing on a mismatch. Playwright's `config.updateSnapshots` defaults to `'missing'` unless `--update-snapshots` is passed on the CLI, and the visual-regression helpers treated `'missing'` the same as `'all'`/`'changed'`, unconditionally taking the write-baseline early-return instead of comparing. Dropped `'missing'` from the update-snapshots condition in `test/visual/helper.ts` and `test/visual/elk_geometry.visual.spec.ts`, and regenerated the `loop-node-chromium-linux.json` baseline, which had gone stale since #110's edge-path-selector fix without ever being caught.
- 71a5b32: Anchor the node warning icon to the outline's top-right vertex instead of the bounding box corner, so it no longer floats off shaped nodes (mux, select, ALU, inverter, and skinned port/interface-port nodes).
- a2facc6: Hide the always-visible diagnostics panel and surface warning presence as a status icon in the toolbar instead, mutually exclusive with the busy spinner. The icon shows the warning count inline (e.g. "⚠ 3 warnings"), no per-severity breakdown.
- e1edc28: Add visual regression snapshots (PNG/JSON/SVG) for every module in the example design, so its diagrams are locked in as part of the test suite.
- a76d950: Reduce visual-suite benchmark noise by sampling elaboration and rendering timings median-of-11 instead of once. `buildDesignGraph()` runs up to 11x per fixture build — it repeats filesystem discovery and UHDM extraction each time, so this adds real backend work and may increase CI runtime — and the view is re-opened 11x per test for rendering samples; the screenshot assertion itself still runs once. The system suite is unaffected — its "sample" is a full VS Code boot, not comparable.
- a09f45e: Regenerate snapshot baselines for `docs/syntax-book/assets/mux-*.svg` and `test/visual/__screenshots__/mux.visual.spec.ts-snapshots/*.svg` that went stale from merge skew between #108 and #115, so they pick up #108's `font-family` fix for interface type labels. No source changes.
- 3e6609f: Reject sub-threshold snapshot updates in CI. Visual, BDD, and system Playwright configs now pin `UPDATE_SNAPSHOTS` to compare-first `changed` mode instead of `all`, and `test/steps/fixtures.ts`, `test/steps/diagram.steps.ts`, and the exact comparators in `test/graphRegression.ts` compare before writing a new baseline. A new snapshot gate (`scripts/check-snapshot-updates.ts`) runs on `test_visual`, `test_bdd`, and `test_system` PR jobs and fails the build if a changed baseline's pixel diff falls under its threshold (2 px/120 px for visual overrides, 50 px/100 px for raw pixelmatch), with an allowlist (`test/snapshot-bypass.yml`) for reviewed exceptions.
- 6dcea96: Share and cache project elaboration across diagram panels.
- c0345bc: Split webview styles.css into shared diagram.css and webview-chrome.css so exported SVGs no longer embed unused toolbar/panel CSS, shrinking exported SVGs by ~25-30%.
- 3355265: Tighten the system-test full-window screenshot budget (`maxDiffPixels: 2500` → `500`) and regenerate the stale 1.90.0/1.91.0/1.122.1 baselines. The old budget was high enough that the inline toolbar warning-count label (added in #120) could disappear from a baseline entirely — a 2195px diff — without `--update-snapshots` rewriting it or CI's assertion failing, silently letting a real regression pass.
- e8de93a: Track diagram-generation duration in CI with `github-action-benchmark` so performance regressions are caught automatically. PR runs post one combined comment covering the system/visual suites instead of two separate ones, with a worst/best delta table per suite; visual gets a per-test stacked "elaboration + rendering" bar chart (fastest to slowest), system gets a per-test "baseline vs. this run" bar chart. The visual suite times every test that renders a diagram (previously only fixture-based tests were covered) and reports elaboration (Surelog/UHDM parse) and rendering (webview paint) as separate metrics; the system suite reports one entry per vscode-version instead of only the latest. BDD perf tracking was removed — its timings were dominated by a fixed busy-indicator wait rather than real work (see #167).

## 0.2.2

### Patch Changes

- 2a12b06: Removed VS Code Marketplace and Open VSX publishing from the release workflow. The extension is still packaged and attached to GitHub releases as a `.vsix` file.

## 0.2.1

### Patch Changes

- 35dfe69: Fail BDD snapshot/screenshot comparisons in CI when a baseline is missing instead of silently writing the actual output as the new baseline and passing. This previously let scenarios with no committed baseline pass vacuously. Local runs and `UPDATE_SNAPSHOTS=true` still auto-create baselines as before.
- 486d4e3: Fix edges intermittently failing to render (no `.react-flow__edge` DOM elements, timing out in CI) right after opening a module. React Flow only learns a node's handle positions from a `ResizeObserver` callback that fires on its own, browser-scheduled timing after the node's DOM mounts — under a busy renderer that callback can be delayed arbitrarily, during which no edges can be drawn even though the node/edge data model is already complete. Since the node/handle geometry is already valid the instant the DOM commits (layout doesn't require a paint), the webview now measures it synchronously itself right after nodes mount, instead of waiting on that observer's own scheduling.
- 64a4f1d: Simplify obstacle-safe Libavoid doglegs without adding crossings or shared-path overlap.

## 0.2.0

### Minor Changes

- bebd5fb: CLI: log which layout file (if any) was used for each rendered SVG, e.g. `[svsch] rendering out.svg using layout file .svsch/layouts/top.json` or `[svsch] rendering out.svg without a layout file`. Add a `--svsch-data-dir <dir>` flag so a module's per-module layout under `<dir>/layouts/<module>.json` can be found without spelling out the full path — useful now that layouts live one file per module under `.svsch/layouts/`.
- a6894fd: Route automatically laid-out schematic connections with libavoid, preserving
  orthogonal routes while avoiding diagram nodes and generate-region boundaries.
- 13e558f: Add wire and block selection operations to the diagram: drag-selected wires are now highlighted, Cut/Reroute controls act on an entire multi-wire selection at once (with a hover preview of what will be affected), and a new "Auto Layout" control re-places and reroutes just the selected blocks while leaving the rest of the diagram untouched.
- 88fbb15: Store each module's diagram layout in its own file under `.svsch/layouts/<module>.json` instead of one monolithic `.svsch/layout.json`. This avoids Git merge conflicts when different developers edit different modules' layouts, and keeps every read/write scoped to the module that actually changed instead of the whole project's layout data.

  This is a breaking change to the on-disk layout format: existing `.svsch/layout.json` files are no longer read, so saved node/edge/region positions will reset the first time you open a diagram after upgrading.

- ac53db5: Assign chains (`wire a, b, c; assign a = b; assign b = c; ...`) now report the earliest-declared internal wire/reg name in the chain (preferred over any port it aliases through), with every other internal name it collapsed through available on hover — names that just repeat one of that wire's own two endpoint ports are left out, since those are already visible as the blocks on either side. An ordinary, uncut wire now shows this declared name directly whenever it differs from both of its endpoints — e.g. `wire x; assign x = a; assign y = x;` labels the wire "x" — since otherwise that name would never appear anywhere in the diagram, and a fanout net (one source, many sinks) gets exactly one label, placed near its source instead of duplicated on every branch. Cut-net labels prefer a net's real SV-declared name over a guessed one; a label backed by a real declared name can never be renamed, while a tool-invented label (e.g. `NET_3`) stays freely renameable. Either way, the label renders in regular type right after the cut — since its default text is still the net's legitimate current name — and only switches to italic once the user actively renames it away from that default, with a "Revert label" button to restore it.

  Also fixes a routing bug where a freshly auto-routed wire connecting two ports at the same height could render with a spurious few-pixel notch instead of a flat, straight line, whenever that shared height wasn't itself grid-aligned.

### Patch Changes

- f4ab0d4: Fix "Auto Layout" so a cut net's dangling wire end moves along with the block it's attached to instead of staying stuck at a stale position. Selecting the block (or just its stub wire) now releases the dangling end too, even if the marquee didn't cover it directly; a dangling end whose wire isn't selected is left untouched.
- d069302: Bump elkjs from 0.11.1 to 0.12.0
- 96c2583: Bump typescript from 6.0.3 to 7.0.2
- 6346774: chore(deps-dev): bump jsdom from 29.1.1 to 30.0.0
- 67fa330: chore(deps-dev): bump @playwright/test from 1.61.1 to 1.62.0
- 971e524: Fix Dependabot changeset check logic in GitHub Actions workflow to check for specific PR changeset instead of any markdown file in .changeset.
- b1a001c: Fix flaky BDD test predicate in `_waitForRenderedModule` to support arbitrary path selectors and robust edge element verification.
- 83c77c2: Fix querySelector selector syntax error flakiness in BDD test step `_waitForRenderedModule` on edge IDs containing special characters.
- 18b96eb: Capture diagnostic node/edge state when the BDD `_waitForRenderedModule` render-completion check times out, so a recurrence of the intermittent "Navigating to combinational blocks" CI timeout is diagnosable from logs instead of a bare timeout.
- bddc998: Fix exported/generated SVGs being malformed XML: a couple of source comments in the embedded stylesheet contained literal `<...>` tag references, which is invalid inside an SVG `<style>` element without CDATA wrapping. Browsers render it anyway, but strict XML consumers (e.g. GitHub's SVG preview) rejected the whole file.
- dede9cc: Fix npm audit vulnerabilities in dependencies fast-uri and linkify-it.
- bd33eed: Enforce global exclusive Playwright suite locking, syntax test orchestration, per-worktree port/directory isolation, and config file mtime checking for incremental builds.
- b18738c: Fix Validate Changeset workflow to skip checking version package release PRs.
- 878666e: Render breakout and composition nodes as vertical bars on the minimap instead of rectangles.
- f4e0bb6: Fix npm audit vulnerabilities for brace-expansion, js-yaml, nanoid, and postcss.
- 16e8885: Setup Changesets versioning and automated CI/CD publishing workflows for NPM and VS Code Marketplace.
