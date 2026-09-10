import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import { buildDesignGraph } from '../../src/parser/backend';
import {
  buildViewModel,
  firstOpenAutoCutEdges,
  mergeFirstOpenNetCuts,
} from '../../src/layout/mergeLayout';
import { renderSvg } from '../../src/cli/svgRenderer';
import { resolveSignalSource } from '../../src/core';
import type { SourceRange } from '../../src/ir/types';

function getCharOffset(lines: string[], line: number, column: number): number {
  let offset = 0;
  const targetLine = Math.min(line, lines.length);
  for (let i = 0; i < targetLine - 1; i++) {
    offset += lines[i].length + 1; // +1 for newline
  }
  if (lines[targetLine - 1] !== undefined) {
    offset += Math.min(column, lines[targetLine - 1].length);
  }
  return offset;
}

function escapeAndHighlight(fileContent: string, range: SourceRange): string {
  let escaped = '';
  let startOffsetEscaped = -1;
  let endOffsetEscaped = -1;

  const lines = fileContent.split('\n');
  const startLine = range.startLine ?? 1;
  const startColumn = range.startColumn ?? 0;
  const endLine = range.endLine ?? range.startLine ?? lines.length;
  const endColumn = range.endColumn ?? lines[endLine - 1]?.length ?? 0;

  const startOffset = getCharOffset(lines, startLine, startColumn);
  const endOffset = getCharOffset(lines, endLine, endColumn);

  for (let i = 0; i < fileContent.length; i++) {
    if (i === startOffset) {
      startOffsetEscaped = escaped.length;
    }
    if (i === endOffset) {
      endOffsetEscaped = escaped.length;
    }
    const char = fileContent[i];
    if (char === '&') escaped += '&amp;';
    else if (char === '<') escaped += '&lt;';
    else if (char === '>') escaped += '&gt;';
    else if (char === '"') escaped += '&quot;';
    else if (char === "'") escaped += '&#39;';
    else escaped += char;
  }

  if (startOffsetEscaped === -1) startOffsetEscaped = escaped.length;
  if (endOffsetEscaped === -1) endOffsetEscaped = escaped.length;

  return (
    escaped.slice(0, startOffsetEscaped) +
    '<mark>' +
    escaped.slice(startOffsetEscaped, endOffsetEscaped) +
    '</mark>' +
    escaped.slice(endOffsetEscaped)
  );
}

// Plain HTML-escaped source with no <mark> at all — for the wiring section,
// which shows a code block without pointing at any one declaration.
function escapeCode(fileContent: string): string {
  let escaped = '';
  for (const char of fileContent) {
    if (char === '&') escaped += '&amp;';
    else if (char === '<') escaped += '&lt;';
    else if (char === '>') escaped += '&gt;';
    else if (char === '"') escaped += '&quot;';
    else if (char === "'") escaped += '&#39;';
    else escaped += char;
  }
  return escaped;
}

function getRawSelectedText(fileContent: string, range: SourceRange): string {
  const lines = fileContent.split('\n');
  const startLine = range.startLine ?? 1;
  const startColumn = range.startColumn ?? 0;
  const endLine = range.endLine ?? range.startLine ?? lines.length;
  const endColumn = range.endColumn ?? lines[endLine - 1]?.length ?? 0;

  const startOffset = getCharOffset(lines, startLine, startColumn);
  const endOffset = getCharOffset(lines, endLine, endColumn);

  return fileContent.slice(startOffset, endOffset);
}

const casesDir = path.resolve(__dirname, 'cases');
const sectionFiles = [
  'ports.yaml',
  'modules_hierarchy.yaml',
  'registers.yaml',
  'muxes.yaml',
  'combinational_logic.yaml',
  'wiring.yaml',
  'buses.yaml',
  'structs.yaml',
  'interfaces.yaml',
  'generate.yaml',
  'other.yaml',
];

test.describe('Syntax Book Generation & Verification', () => {
  const generatedEntries: Array<{
    id: string;
    title: string;
    description: string;
    group: string;
    highlightedHtml: string;
    svgContent: string;
  }> = [];

  test('Assert unique IDs across all cases', () => {
    const ids: string[] = [];
    for (const sectionFile of sectionFiles) {
      const sectionPath = path.join(casesDir, sectionFile);
      if (!fs.existsSync(sectionPath)) continue;
      const sectionData = yaml.load(fs.readFileSync(sectionPath, 'utf8')) as any;
      for (const caseData of sectionData.cases) {
        ids.push(caseData.id);
      }
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  test.afterAll(async () => {
    if (generatedEntries.length === 0) {
      return;
    }

    let mdContent = `# SVSCH Syntax Book\n\n`;
    mdContent +=
      `This book contains generated block diagrams representing various SystemVerilog ` +
      `constructs.\n\n`;

    for (const sectionFile of sectionFiles) {
      const sectionPath = path.join(casesDir, sectionFile);
      if (!fs.existsSync(sectionPath)) continue;
      const sectionData = yaml.load(fs.readFileSync(sectionPath, 'utf8')) as any;
      const groupName = sectionData.group;

      const groupEntries = sectionData.cases
        .map((c: any) => generatedEntries.find((e) => e.id === c.id))
        .filter(Boolean);

      if (groupEntries.length === 0) continue;

      mdContent += `## ${groupName}\n\n`;

      for (const entry of groupEntries) {
        let codeHtml = entry.highlightedHtml;
        while (codeHtml.includes('\n\n')) {
          codeHtml = codeHtml.replace(/\n\n/g, '\n<br />\n');
        }

        mdContent += `### ${entry.title}\n\n`;
        mdContent += `${entry.description}\n\n`;
        mdContent += `<pre><code>${codeHtml}</code></pre>\n\n`;
        mdContent += `<p align="center">\n`;
        mdContent +=
          `  <img src="syntax-book/assets/${entry.id}.svg" ` + `alt="${entry.title} diagram" />\n`;
        mdContent += `</p>\n\n`;
      }
    }

    const docsDir = path.resolve(__dirname, '../../docs');
    const assetsDir = path.resolve(docsDir, 'syntax-book/assets');
    const mdPath = path.join(docsDir, 'svsch-syntax-book.md');

    if (process.env.GENERATE_SYNTAX_BOOK === '1') {
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.writeFileSync(mdPath, mdContent);
      for (const entry of generatedEntries) {
        fs.writeFileSync(path.join(assetsDir, `${entry.id}.svg`), entry.svgContent);
      }
      console.log(`Successfully generated syntax book at ${mdPath}`);
    } else {
      expect(fs.existsSync(mdPath)).toBe(true);
      const existingMd = fs.readFileSync(mdPath, 'utf8');
      expect(mdContent).toBe(existingMd);

      for (const entry of generatedEntries) {
        const svgPath = path.join(assetsDir, `${entry.id}.svg`);
        expect(fs.existsSync(svgPath)).toBe(true);
        const existingSvg = fs.readFileSync(svgPath, 'utf8');
        expect(entry.svgContent).toBe(existingSvg);
      }
      console.log('Diff-check passed! All generated files match checked-in files.');
    }
  });

  for (const sectionFile of sectionFiles) {
    const sectionPath = path.join(casesDir, sectionFile);
    if (!fs.existsSync(sectionPath)) continue;
    const sectionData = yaml.load(fs.readFileSync(sectionPath, 'utf8')) as any;
    const groupName = sectionData.group;

    for (const caseData of sectionData.cases) {
      test(`Verify and generate: ${groupName} -> ${caseData.id}`, async ({ page }) => {
        // 1. Validate YAML schema
        expect(caseData.id).toBeDefined();
        expect(caseData.title).toBeDefined();
        expect(caseData.description).toBeDefined();
        expect(caseData.files).toBeDefined();
        expect(caseData.module).toBeDefined();
        expect(caseData.target).toBeDefined();
        expect(caseData.expect).toBeDefined();

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `svsch-sb-${caseData.id}-`));
        try {
          for (const [filename, content] of Object.entries(caseData.files)) {
            fs.writeFileSync(path.join(tmpDir, filename), content as string);
          }

          const surelogPath =
            process.env.SVSCH_SURELOG_PATH ??
            path.resolve(__dirname, '../../dist/surelog/bin/surelog');
          const backendPath = path.resolve(__dirname, '../../dist/svsch_backend');

          const graph = await buildDesignGraph({
            workspaceRoot: tmpDir,
            projectFolder: '.',
            backend: 'uhdm',
            veriblePath: 'verible-verilog-syntax',
            surelogPath,
            backendPath,
            includeExternalDiagnostics: false,
          });

          const designModule = graph.modules[caseData.module];
          expect(designModule).toBeDefined();
          const layout = mergeFirstOpenNetCuts(
            { version: 1, modules: {} },
            caseData.module,
            firstOpenAutoCutEdges(designModule, true, graph.modules),
            designModule,
          );
          const viewModel = await buildViewModel(graph, caseData.module, layout);

          // Assert declared node kinds and target exist
          for (const kind of caseData.expect.nodeKinds) {
            const kindExists = viewModel.nodes.some((n) => n.kind === kind);
            if (!kindExists) {
              console.log(
                `CASE ${caseData.id}: MISSING KIND "${kind}". Nodes:`,
                viewModel.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label })),
              );
            }
            expect(kindExists).toBe(true);
          }

          if (caseData.target.kind === 'node') {
            const targetNode = viewModel.nodes.find(
              (n) => n.kind === caseData.target.nodeKind && n.label === caseData.target.nodeLabel,
            );
            if (!targetNode) {
              console.log(
                `CASE ${caseData.id}: TARGET NOT FOUND. Kind: ${caseData.target.nodeKind}, ` +
                  `Label: ${caseData.target.nodeLabel}. Nodes:`,
                viewModel.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label })),
              );
            }
            expect(targetNode).toBeDefined();
            if (caseData.expect.targetIsArray !== undefined) {
              expect(targetNode?.isArrayNode ?? targetNode?.metadata?.isArrayNode).toBe(
                caseData.expect.targetIsArray,
              );
            }
          } else if (caseData.target.kind === 'region') {
            const targetExists = viewModel.generateRegions?.some(
              (r) => r.label === caseData.target.regionLabel,
            );
            if (!targetExists) {
              console.log(
                `CASE ${caseData.id}: REGION TARGET NOT FOUND. ` +
                  `Label: ${caseData.target.regionLabel}. Regions:`,
                viewModel.generateRegions?.map((r) => ({ id: r.id, label: r.label, kind: r.kind })),
              );
            }
            expect(targetExists).toBe(true);
          } else if (caseData.target.kind === 'netLabel') {
            const targetExists = viewModel.edges.some((e) => e.signal === caseData.target.signal);
            if (!targetExists) {
              console.log(
                `CASE ${caseData.id}: NET-LABEL TARGET NOT FOUND. ` +
                  `Signal: ${caseData.target.signal}. Edges:`,
                viewModel.edges.map((e) => ({ id: e.id, signal: e.signal })),
              );
            }
            expect(targetExists).toBe(true);
          }

          // A net label (unlike every other case here) has no
          // click-to-navigate interaction to drive — it's either visible on
          // the plain wire or on the automatically cut ends, so this asserts
          // straight against the rendered view model instead of the webview.
          // The wiring section exists to show the diagram's overall shape
          // (whether a label appears at all), not to point at one specific
          // declaration, so unlike every other section, no source line is
          // ever marked/selected here — the code block just shows the plain
          // source as-is.
          if (caseData.target.kind === 'netLabel') {
            const targetEdge = viewModel.edges.find((e) => e.signal === caseData.target.signal)!;
            const cutLabelId =
              targetEdge.metadata?.cutStub?.role === 'source'
                ? targetEdge.target
                : targetEdge.metadata?.cutStub?.role === 'sink'
                  ? targetEdge.source
                  : undefined;
            const cutLabel = cutLabelId
              ? viewModel.nodes.find((node) => node.id === cutLabelId && node.kind === 'netLabel')
              : undefined;
            expect(cutLabel?.label ?? targetEdge.label ?? null).toBe(
              caseData.expect.labelText ?? null,
            );
            if (caseData.expect.aliasNames) {
              expect(
                cutLabel?.metadata?.cutNet?.aliasNames ?? targetEdge.metadata?.aliasNames,
              ).toEqual(caseData.expect.aliasNames);
            }

            const firstFileContent = Object.values(caseData.files)[0] as string;
            const highlightedHtml = escapeCode(firstFileContent);

            const nodeModulesPaths = [
              path.resolve(__dirname, '../../node_modules/@xyflow/react/dist/style.css'),
              path.resolve(__dirname, '../../../node_modules/@xyflow/react/dist/style.css'),
            ];
            let reactFlowCss = '';
            for (const p of nodeModulesPaths) {
              if (fs.existsSync(p)) {
                reactFlowCss = fs.readFileSync(p, 'utf8');
                break;
              }
            }
            const extensionCss = fs.readFileSync(
              path.resolve(__dirname, '../../src/webview/diagram.css'),
              'utf8',
            );
            const svgContent = renderSvg(viewModel, { reactFlowCss, extensionCss, theme: 'dark' });

            generatedEntries.push({
              id: caseData.id,
              title: caseData.title,
              description: caseData.description,
              group: groupName,
              highlightedHtml,
              svgContent,
            });
            return;
          }

          for (const signal of caseData.expect.cutSignals ?? []) {
            const cutRoles = viewModel.edges
              .filter((edge) => edge.signal === signal)
              .map((edge) => edge.metadata?.cutStub?.role);
            expect(cutRoles).toContain('source');
            expect(cutRoles).toContain('sink');
          }

          // Initialize webview
          await page.goto('/');

          const testView = JSON.parse(JSON.stringify(viewModel));
          if (caseData.target.kind === 'node') {
            const targetNode = testView.nodes.find(
              (n: any) =>
                n.kind === caseData.target.nodeKind && n.label === caseData.target.nodeLabel,
            );
            if (targetNode) {
              if (targetNode.kind === 'instance') {
                delete targetNode.moduleName;
                if (targetNode.metadata) delete targetNode.metadata.moduleName;
              }
              if (targetNode.kind === 'interface') {
                delete targetNode.typeName;
                if (targetNode.metadata) delete targetNode.metadata.typeName;
              }
            }
          }

          let capturedMsg: any = null;
          const consolePromise = new Promise<void>((resolve) => {
            const handler = (msg: any) => {
              if (msg.text().startsWith('NAVIGATE:')) {
                try {
                  capturedMsg = JSON.parse(msg.text().substring(9));
                  page.off('console', handler);
                  resolve();
                } catch {}
              }
            };
            page.on('console', handler);
            setTimeout(resolve, 15000);
          });

          await page.evaluate((view) => {
            window.postMessage(
              {
                type: 'graph',
                view,
                modules: [view.moduleName],
              },
              '*',
            );
          }, testView);

          await page.waitForSelector('.react-flow__node', { state: 'attached' });
          await page.waitForTimeout(200);

          // Perform interaction
          if (caseData.target.kind === 'node') {
            const targetNode = viewModel.nodes.find(
              (n) => n.kind === caseData.target.nodeKind && n.label === caseData.target.nodeLabel,
            );
            const locator = page.locator(`[data-node-id="${targetNode!.id}"]`).first();
            await locator.dblclick({ position: { x: 5, y: 5 }, force: true });
          } else if (caseData.target.kind === 'edge') {
            const targetEdge = viewModel.edges.find((e) => e.signal === caseData.target.signal);
            const locator = page.locator(`.react-flow__edge[data-id="${targetEdge!.id}"]`).first();
            await locator.dblclick({ force: true });
          } else if (caseData.target.kind === 'region') {
            await page.waitForSelector('.generate-region-title', { state: 'attached' });
            await page.evaluate((labelText) => {
              const buttons = Array.from(document.querySelectorAll('.generate-region-title'));
              const targetButton = buttons.find((b) => b.textContent?.trim() === labelText);
              if (targetButton) {
                targetButton.dispatchEvent(
                  new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
                );
              }
            }, caseData.target.regionLabel);
          }

          await consolePromise;

          // Assert webview interaction emits expected message
          expect(capturedMsg).not.toBeNull();

          let range: SourceRange | undefined;
          if (capturedMsg.type === 'navigateToSource') {
            range = capturedMsg.source;
          } else if (capturedMsg.type === 'navigateToSignal') {
            range = resolveSignalSource(graph, caseData.module, capturedMsg.edge);
          } else if (capturedMsg.type === 'navigateToRegion') {
            range = capturedMsg.region.source;
          }

          expect(range).toBeDefined();
          expect(range!.file).toBeDefined();

          const fileContent = caseData.files[range!.file];
          expect(fileContent).toBeDefined();

          const rawSelectedText = getRawSelectedText(fileContent, range!);
          expect(rawSelectedText.replace(/\r\n/g, '\n').trim()).toBe(
            caseData.expect.selectedText.replace(/\r\n/g, '\n').trim(),
          );

          const highlightedHtml = escapeAndHighlight(fileContent, range!);

          expect(highlightedHtml.match(/<mark>/g)?.length).toBe(1);
          expect(highlightedHtml.match(/<\/mark>/g)?.length).toBe(1);

          const nodeModulesPaths = [
            path.resolve(__dirname, '../../node_modules/@xyflow/react/dist/style.css'),
            path.resolve(__dirname, '../../../node_modules/@xyflow/react/dist/style.css'),
          ];
          let reactFlowCss = '';
          for (const p of nodeModulesPaths) {
            if (fs.existsSync(p)) {
              reactFlowCss = fs.readFileSync(p, 'utf8');
              break;
            }
          }
          const extensionCss = fs.readFileSync(
            path.resolve(__dirname, '../../src/webview/diagram.css'),
            'utf8',
          );

          const targetNode = viewModel.nodes.find(
            (n) => n.kind === caseData.target.nodeKind && n.label === caseData.target.nodeLabel,
          );

          let customCss = extensionCss;
          if (targetNode) {
            // Array-stack leads are the node's own SVG content (drawn by
            // *NodeSvg components, not by OrthogonalEdge), so the blanket
            // `.svsch-node[data-node-id=...] { opacity: 1 }` below would
            // otherwise keep the target's lead stubs at full brightness
            // while the routed wire they join into stays dimmed — a visible
            // seam right where they're supposed to read as one continuous
            // line. Leads are visually part of the wire, so dim them back
            // down to the same opacity as the rest of the (dimmed) net.
            customCss +=
              `\n/* Dim everything except target node */\n` +
              `.svsch-edges { opacity: 0.3; }\n` +
              `.svsch-node { opacity: 0.3; }\n` +
              `.svsch-node[data-node-id="${targetNode.id}"] { opacity: 1 !important; }\n` +
              `.svsch-node[data-node-id="${targetNode.id}"] .svsch-array-stack-lead { opacity: 0.3; }\n`;
          }

          const svgContent = renderSvg(viewModel, {
            reactFlowCss,
            extensionCss: customCss,
            theme: 'dark',
          });

          generatedEntries.push({
            id: caseData.id,
            title: caseData.title,
            description: caseData.description,
            group: groupName,
            highlightedHtml,
            svgContent,
          });
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      });
    }
  }
});
