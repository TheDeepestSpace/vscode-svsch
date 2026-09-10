// The `typescript` devDependency is pinned to the new native-preview compiler,
// which doesn't expose the classic parser API (createSourceFile, ts.is*
// node-kind guards, etc.) this module needs. typescript-eslint-ts-compat is
// the same classic-API package (aliased from `typescript@6.0.3`) that
// typescript-eslint itself depends on for that reason — reuse it here instead
// of adding a second TS-parser dependency.
import * as ts from 'typescript-eslint-ts-compat';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Reproduces (rather than executes) the two Playwright snapshot naming shapes
// used by test/visual and test/system, statically, from the .spec.ts source:
//
//   1. expectGraphAndScreenshot(page, name, ...) [test/visual/helper.ts] writes
//      three sibling files per call: an image ("<base>-<project>-<platform>.png"),
//      a JSON graph-state baseline with the same suffix ("...json"), and an
//      unsuffixed SVG twin ("<base>.svg") — see test/visual/helper.ts and
//      test/graphRegression.ts.
//   2. A direct `expect(x).toHaveScreenshot(name, ...)` (or .toMatchSnapshot)
//      call writes just the suffixed image/asset.
//   3. A direct compareSvgSnapshot(svg, name, ...) call (test/visual/elk_geometry)
//      writes just the unsuffixed "<name>.svg".
//
// The "<project>-<platform>" suffix mirrors Playwright's own default
// snapshotPathTemplate resolution (playwright-core), which every one of these
// paths ultimately goes through: `{arg}{-projectName}{-platform}{ext}`. This
// repo's checked-in baselines are Linux-only (CI-generated), and only the
// visual suite defines a named project ("chromium"); system defines none, so
// its projectName segment is empty.

export type SnapshotCallKind =
  'expectGraphAndScreenshot' | 'toHaveScreenshot' | 'toMatchSnapshot' | 'compareSvgSnapshot';

export interface UnresolvedNote {
  file: string;
  line: number;
  reason: string;
}

export interface SpecAudit {
  /** Filenames (basenames) this spec's calls currently produce. */
  expected: Set<string>;
  /** Calls whose name argument couldn't be statically resolved. */
  unresolved: UnresolvedNote[];
}

const sourceFileCache = new Map<string, ts.SourceFile | null>();

function readSourceFile(filePath: string): ts.SourceFile | null {
  if (sourceFileCache.has(filePath)) return sourceFileCache.get(filePath)!;
  let result: ts.SourceFile | null = null;
  if (fs.existsSync(filePath)) {
    const text = fs.readFileSync(filePath, 'utf8');
    result = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  }
  sourceFileCache.set(filePath, result);
  return result;
}

function resolveModuleFile(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (true) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
    } else if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
    } else {
      return current;
    }
  }
}

function findTopLevelConst(sourceFile: ts.SourceFile, name: string): ts.Expression | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
        return decl.initializer;
      }
    }
  }
  return undefined;
}

function findImportedModuleSpecifier(sourceFile: ts.SourceFile, name: string): string | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
    for (const element of namedBindings.elements) {
      const localName = element.name.text;
      if (localName === name && ts.isStringLiteral(statement.moduleSpecifier)) {
        return statement.moduleSpecifier.text;
      }
    }
  }
  return undefined;
}

/**
 * Resolves an identifier bound to a top-level `const` (locally, or one hop
 * through a relative import) to its initializer expression.
 */
function resolveIdentifierInitializer(
  identifier: ts.Identifier,
  sourceFile: ts.SourceFile,
): { expr: ts.Expression; sourceFile: ts.SourceFile } | undefined {
  const local = findTopLevelConst(sourceFile, identifier.text);
  if (local) return { expr: local, sourceFile };

  const specifier = findImportedModuleSpecifier(sourceFile, identifier.text);
  if (!specifier) return undefined;
  const resolvedFile = resolveModuleFile(sourceFile.fileName, specifier);
  if (!resolvedFile) return undefined;
  const importedSource = readSourceFile(resolvedFile);
  if (!importedSource) return undefined;
  const imported = findTopLevelConst(importedSource, identifier.text);
  if (!imported) return undefined;
  return { expr: imported, sourceFile: importedSource };
}

function resolveArrayLiteralOfStrings(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
): string[] | undefined {
  const node = unwrap(expr);
  if (ts.isArrayLiteralExpression(node)) {
    const values: string[] = [];
    for (const element of node.elements) {
      if (!ts.isStringLiteralLike(element)) return undefined;
      values.push(element.text);
    }
    return values;
  }
  if (ts.isIdentifier(node)) {
    const resolved = resolveIdentifierInitializer(node, sourceFile);
    if (!resolved) return undefined;
    return resolveArrayLiteralOfStrings(resolved.expr, resolved.sourceFile);
  }
  return undefined;
}

function resolveArrayLiteralOfObjects(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
): Array<Record<string, string>> | undefined {
  const node = unwrap(expr);
  if (ts.isArrayLiteralExpression(node)) {
    const values: Array<Record<string, string>> = [];
    for (const element of node.elements) {
      const objectLiteral = unwrap(element);
      if (!ts.isObjectLiteralExpression(objectLiteral)) return undefined;
      const record: Record<string, string> = {};
      for (const prop of objectLiteral.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const key = ts.isIdentifier(prop.name)
          ? prop.name.text
          : ts.isStringLiteralLike(prop.name)
            ? prop.name.text
            : undefined;
        if (!key) continue;
        const value = unwrap(prop.initializer);
        if (ts.isStringLiteralLike(value)) {
          record[key] = value.text;
        } else if (ts.isNumericLiteral(value)) {
          record[key] = value.text;
        }
      }
      values.push(record);
    }
    return values;
  }
  if (ts.isIdentifier(node)) {
    const resolved = resolveIdentifierInitializer(node, sourceFile);
    if (!resolved) return undefined;
    return resolveArrayLiteralOfObjects(resolved.expr, resolved.sourceFile);
  }
  return undefined;
}

/**
 * Finds the nearest enclosing `for (const <name> of <iterable>)` binding
 * <name>, walking up from `node`.
 */
function findEnclosingForOfIterable(node: ts.Node, name: string): ts.Expression | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isForOfStatement(current) && ts.isVariableDeclarationList(current.initializer)) {
      const [decl] = current.initializer.declarations;
      if (decl && ts.isIdentifier(decl.name) && decl.name.text === name) {
        return current.expression;
      }
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Finds the nearest enclosing named function declaration that declares `name`
 * as one of its parameters, walking up from `node`. Handles the case where a
 * template's `${...}` interpolation is a parameter of a helper function
 * called from inside the real `for (const x of ARRAY)` loop, rather than the
 * loop variable itself — e.g. test/system/diagram.spec.ts's
 * resizeSystemRegisterAndAssertPersistence(workbox, evaluateInVSCode, resizeCase).
 */
function findEnclosingFunctionParamIndex(
  node: ts.Node,
  name: string,
): { func: ts.FunctionDeclaration; paramIndex: number } | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      const paramIndex = current.parameters.findIndex(
        (p) => ts.isIdentifier(p.name) && p.name.text === name,
      );
      if (paramIndex >= 0) return { func: current, paramIndex };
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

function findCallArguments(
  sourceFile: ts.SourceFile,
  functionName: string,
  argIndex: number,
): ts.Expression[] {
  const args: ts.Expression[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === functionName &&
      node.arguments[argIndex]
    ) {
      args.push(node.arguments[argIndex]);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return args;
}

/**
 * Resolves a bare identifier (optionally followed by `.propName`) to every
 * literal string value it can currently take on.
 */
function resolveIdentifierToValues(
  identifier: ts.Identifier,
  sourceFile: ts.SourceFile,
  propName?: string,
): string[] | undefined {
  const iterable = findEnclosingForOfIterable(identifier, identifier.text);
  if (iterable) {
    if (!propName) return resolveArrayLiteralOfStrings(iterable, sourceFile);
    const objects = resolveArrayLiteralOfObjects(iterable, sourceFile);
    if (!objects) return undefined;
    const values = objects.map((obj) => obj[propName]);
    return values.every((v) => v !== undefined) ? (values as string[]) : undefined;
  }

  const paramBinding = findEnclosingFunctionParamIndex(identifier, identifier.text);
  if (paramBinding) {
    const functionName = paramBinding.func.name?.text;
    if (!functionName) return undefined;
    const callArgs = findCallArguments(sourceFile, functionName, paramBinding.paramIndex);
    if (callArgs.length === 0) return undefined;

    const allValues: string[] = [];
    for (const argExpr of callArgs) {
      const values = resolveExpressionValues(argExpr, sourceFile, propName);
      if (!values) return undefined;
      allValues.push(...values);
    }
    return allValues;
  }

  return undefined;
}

function resolveExpressionValues(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  propName?: string,
): string[] | undefined {
  const node = unwrap(expr);

  // A literal call argument at the end of a traced function-param chain
  // (e.g. `screenshotPartialStep(workbox, view, 'literal.png')` where the
  // helper does `toHaveScreenshot(name)`) — not itself an identifier/property
  // access to resolve further, just the value.
  if (!propName && ts.isStringLiteralLike(node)) return [node.text];

  if (ts.isIdentifier(node)) {
    return resolveIdentifierToValues(node, sourceFile, propName);
  }

  if (!propName && ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    return resolveIdentifierToValues(node.expression, sourceFile, node.name.text);
  }

  return undefined;
}

/**
 * Resolves a screenshot-name argument expression to every literal string it
 * can currently produce.
 */
export function resolveNameArgument(
  nameArg: ts.Expression,
  sourceFile: ts.SourceFile,
): string[] | undefined {
  const node = unwrap(nameArg);

  if (ts.isStringLiteralLike(node)) return [node.text];

  // A helper function's own screenshot call passing its whole name argument
  // straight through, e.g. `toHaveScreenshot(name)` where every call site of
  // that helper passes a literal — not wrapped in a template, so it never
  // reaches the per-span resolution below.
  if (ts.isIdentifier(node)) return resolveExpressionValues(node, sourceFile);

  if (ts.isTemplateExpression(node)) {
    let combos = [node.head.text];
    for (const span of node.templateSpans) {
      const values = resolveExpressionValues(span.expression, sourceFile);
      if (!values) return undefined;
      const nextCombos: string[] = [];
      for (const combo of combos) {
        for (const value of values) {
          nextCombos.push(combo + value + span.literal.text);
        }
      }
      combos = nextCombos;
    }
    return combos;
  }

  return undefined;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

export interface AuditOptions {
  /** Project name segment Playwright inserts (e.g. "chromium"); empty if no project configured. */
  projectName: string;
  /** Snapshot platform suffix Playwright inserts; this repo only checks in Linux baselines. */
  platform?: string;
}

// Mirrors playwright-core's sanitizeForFilePath(), applied by Playwright's
// snapshotPath() resolution to the name argument's base (pre-extension) for
// every snapshot kind EXCEPT the SVG twin, which this repo writes directly
// via fs.writeFileSync (see compareSvgSnapshot in test/graphRegression.ts) and
// so never passes through Playwright's own path templating. Concretely this
// means an underscore in a `toHaveScreenshot('foo_bar.png')`/
// `expectGraphAndScreenshot(page, 'foo_bar.png')` call becomes a hyphen in the
// .png/.json baseline name, but the .svg baseline keeps the literal
// underscore — a real, observed inconsistency in this repo's own baselines.
// eslint-disable-next-line no-control-regex -- mirrors playwright-core's sanitizeForFilePath()
const PLAYWRIGHT_FILE_PATH_SANITIZE_PATTERN = /[\x00-\x2C\x2E-\x2F\x3A-\x40\x5B-\x60\x7B-\x7F]+/g;

function playwrightSanitizeForFilePath(base: string): string {
  return base.replace(PLAYWRIGHT_FILE_PATH_SANITIZE_PATTERN, '-');
}

function suffixedName(base: string, ext: string, projectName: string, platform: string): string {
  const projectSegment = projectName ? `-${projectName}` : '';
  return `${playwrightSanitizeForFilePath(base)}${projectSegment}-${platform}${ext}`;
}

function expectedFilesForCall(
  kind: SnapshotCallKind,
  names: string[],
  options: Required<AuditOptions>,
): string[] {
  if (kind === 'expectGraphAndScreenshot') {
    return names.flatMap((name) => {
      const base = name.endsWith('.png') ? name.slice(0, -4) : name;
      return [
        suffixedName(base, '.png', options.projectName, options.platform),
        suffixedName(base, '.json', options.projectName, options.platform),
        `${base}.svg`,
      ];
    });
  }
  if (kind === 'compareSvgSnapshot') {
    return names.map((name) => `${name}.svg`);
  }
  // toHaveScreenshot / toMatchSnapshot
  return names.map((name) => {
    const ext = path.extname(name) || '.png';
    const base = name.slice(0, name.length - ext.length);
    return suffixedName(base, ext, options.projectName, options.platform);
  });
}

/**
 * Scans one .spec.ts file's AST for screenshot/snapshot calls and returns the
 * filenames they currently produce.
 */
export function auditSpecFile(specFile: string, options: AuditOptions): SpecAudit {
  const resolvedOptions: Required<AuditOptions> = { platform: 'linux', ...options };
  const sourceFile = readSourceFile(specFile);
  const expected = new Set<string>();
  const unresolved: UnresolvedNote[] = [];
  if (!sourceFile) return { expected, unresolved };

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      let kind: SnapshotCallKind | undefined;
      let nameArg: ts.Expression | undefined;

      if (ts.isIdentifier(node.expression)) {
        if (node.expression.text === 'expectGraphAndScreenshot') {
          kind = 'expectGraphAndScreenshot';
          nameArg = node.arguments[1];
        } else if (node.expression.text === 'compareSvgSnapshot') {
          kind = 'compareSvgSnapshot';
          nameArg = node.arguments[1];
        }
      } else if (ts.isPropertyAccessExpression(node.expression)) {
        const methodName = node.expression.name.text;
        if (methodName === 'toHaveScreenshot' || methodName === 'toMatchSnapshot') {
          kind = methodName;
          nameArg = node.arguments[0];
        }
      }

      if (kind) {
        if (!nameArg) {
          unresolved.push({
            file: specFile,
            line: lineOf(sourceFile, node),
            reason: `${kind}() called with no name argument (title-derived snapshot names aren't supported by this checker)`,
          });
        } else {
          const names = resolveNameArgument(nameArg, sourceFile);
          if (!names) {
            unresolved.push({
              file: specFile,
              line: lineOf(sourceFile, node),
              reason: `${kind}(...) name argument could not be statically resolved to a fixed set of strings`,
            });
          } else {
            for (const file of expectedFilesForCall(kind, names, resolvedOptions)) {
              expected.add(file);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { expected, unresolved };
}

export interface OrphanReport {
  /** Baseline files on disk with no live call producing them. */
  orphans: string[];
  /** Calls whose name argument couldn't be statically resolved — not scored as orphan or not. */
  unresolved: UnresolvedNote[];
}

/**
 * Audits every .spec.ts file directly under `specDir` against its sibling
 * `<basename>-snapshots` directory under `screenshotsDir`.
 */
export function findOrphanedSnapshots(
  specDir: string,
  screenshotsDir: string,
  specFilePattern: RegExp,
  options: AuditOptions,
): OrphanReport {
  const orphans: string[] = [];
  const unresolved: UnresolvedNote[] = [];
  if (!fs.existsSync(specDir)) return { orphans, unresolved };

  const specFiles = fs
    .readdirSync(specDir)
    .filter((f) => specFilePattern.test(f))
    .map((f) => path.join(specDir, f));

  for (const specFile of specFiles) {
    const audit = auditSpecFile(specFile, options);
    unresolved.push(...audit.unresolved);

    const snapshotDir = path.join(screenshotsDir, `${path.basename(specFile)}-snapshots`);
    if (!fs.existsSync(snapshotDir)) continue;

    // An unresolved call's own filenames are unknown, so every *other*
    // baseline in this file's directory would otherwise look orphaned too
    // (an empty-ish `expected` set can't be trusted to be complete) — that's
    // a false positive on exactly the "pattern the script doesn't understand
    // yet" case this checker is meant to stay silent on. Skip the diff for
    // this file entirely; the `unresolved` report above is still surfaced.
    if (audit.unresolved.length > 0) continue;

    for (const actualFile of fs.readdirSync(snapshotDir)) {
      if (!audit.expected.has(actualFile)) {
        orphans.push(path.join(snapshotDir, actualFile));
      }
    }
  }

  return { orphans, unresolved };
}
