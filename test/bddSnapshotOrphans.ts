import * as fs from 'node:fs';
import * as path from 'node:path';

// Reproduces the BDD baseline naming scheme from test/steps/fixtures.ts
// (BddWorld.takeScreenshot) and test/steps/diagram.steps.ts
// (persistCliPngSnapshot/persistSvgSnapshot) statically, from the .feature
// files, without running the suite:
//
//   `${safeScenarioName}${scenarioId}--${stepNumber}--${safeLabel}`
//
// - safeScenarioName: the Gherkin "Scenario:"/"Scenario Outline:" title,
//   sanitized with the exact same `replace(/[^a-z0-9]/gi, '-').toLowerCase()`
//   used by fixtures.ts.
// - scenarioId: `-${exampleIndex}` (1-based, per Scenario Outline, counted
//   across all of its Examples: rows in file order) for outlines, '' for
//   plain scenarios — mirrors outlineMetadataFromFeature().
// - stepNumber/safeLabel: NOT reproduced here. The label text is computed at
//   runtime from step arguments captured out of the live page/CLI state, so
//   reproducing it exactly would mean re-implementing cucumber step matching
//   — out of scope for a static check. Instead, this module treats
//   "scenario is live" + "the file's shape matches `--NN--label`" +
//   "png/json baselines are always written in pairs" as the checkable
//   invariants; see findOrphanedBddSnapshots() below for exactly what that
//   catches (in particular: scenario/outline rename or deletion, and
//   half-written png/json pairs) and what it doesn't (a step's label text
//   changing while its scenario survives).

export function sanitizeForSnapshotName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, '-').toLowerCase();
}

export interface LiveScenario {
  featureFile: string;
  scenarioName: string;
  /** `${safeScenarioName}${scenarioId}` — prefix a live scenario's baselines must start with. */
  prefix: string;
}

/** Parses one .feature file into its list of live scenario/example-row prefixes. */
export function parseFeatureFile(featureFile: string): LiveScenario[] {
  const lines = fs.readFileSync(featureFile, 'utf8').split(/\r?\n/);
  const scenarios: LiveScenario[] = [];

  let outlineName: string | undefined;
  let inExamples = false;
  let sawHeader = false;
  let exampleIndex = 0;

  const endOutline = () => {
    outlineName = undefined;
    inExamples = false;
    sawHeader = false;
    exampleIndex = 0;
  };

  for (const line of lines) {
    const scenarioMatch = /^\s*Scenario:\s*(.+?)\s*$/.exec(line);
    if (scenarioMatch) {
      endOutline();
      const name = scenarioMatch[1];
      scenarios.push({
        featureFile,
        scenarioName: name,
        prefix: sanitizeForSnapshotName(name),
      });
      continue;
    }

    const outlineMatch = /^\s*Scenario Outline:\s*(.+?)\s*$/.exec(line);
    if (outlineMatch) {
      endOutline();
      outlineName = outlineMatch[1];
      continue;
    }

    if (!outlineName) continue;

    if (/^\s*Examples:/.test(line)) {
      inExamples = true;
      sawHeader = false;
      continue;
    }

    if (!inExamples || !/^\s*\|/.test(line)) continue;

    if (!sawHeader) {
      sawHeader = true;
      continue;
    }

    exampleIndex += 1;
    scenarios.push({
      featureFile,
      scenarioName: outlineName,
      prefix: `${sanitizeForSnapshotName(outlineName)}-${exampleIndex}`,
    });
  }

  return scenarios;
}

function listFeatureFiles(featuresDir: string): string[] {
  if (!fs.existsSync(featuresDir)) return [];
  return fs
    .readdirSync(featuresDir)
    .filter((f) => f.endsWith('.feature'))
    .map((f) => path.join(featuresDir, f));
}

export interface BddOrphan {
  file: string;
  reason: string;
}

const STEP_NUMBER_AND_LABEL = /^(\d{2})--(.+)$/;
// Labels written by persistCliPngSnapshot/persistSvgSnapshot (diagram.steps.ts)
// as a single file with no png/json sibling expected: cli-png/cli-svg for
// `svsch render` CLI output, exported-svg for "should match the exported SVG
// snapshot" (Export SVG button output written to a workspace file).
const CLI_LABELS = new Set(['cli-png', 'cli-svg', 'exported-svg']);

/**
 * Audits test/features/snapshots against every currently-live scenario in
 * test/features/**\/*.feature. Returns definite orphans: baseline files whose
 * scenario prefix no longer exists, whose name doesn't have the expected
 * `<prefix>--NN--<label>` shape, or whose png/json pair is incomplete.
 */
export function findOrphanedBddSnapshots(featuresDir: string, snapshotsDir: string): BddOrphan[] {
  const orphans: BddOrphan[] = [];
  if (!fs.existsSync(snapshotsDir)) return orphans;

  const livePrefixes = listFeatureFiles(featuresDir)
    .flatMap(parseFeatureFile)
    .map((s) => s.prefix)
    // Longest first, so a scenario prefix that happens to be a prefix of
    // another scenario's prefix doesn't shadow the more specific match.
    .sort((a, b) => b.length - a.length);

  const filesByBase = new Map<string, Set<string>>();
  for (const file of fs.readdirSync(snapshotsDir)) {
    const ext = path.extname(file);
    const base = file.slice(0, -ext.length);
    const exts = filesByBase.get(base) ?? new Set<string>();
    exts.add(ext);
    filesByBase.set(base, exts);
  }

  for (const [base, exts] of filesByBase) {
    const matchedPrefix = livePrefixes.find((prefix) => base.startsWith(`${prefix}--`));
    if (!matchedPrefix) {
      for (const ext of exts) {
        orphans.push({
          file: path.join(snapshotsDir, `${base}${ext}`),
          reason: 'no live scenario/example row produces this baseline name (renamed or deleted?)',
        });
      }
      continue;
    }

    const remainder = base.slice(matchedPrefix.length + 2);
    const shapeMatch = STEP_NUMBER_AND_LABEL.exec(remainder);
    if (!shapeMatch) {
      for (const ext of exts) {
        orphans.push({
          file: path.join(snapshotsDir, `${base}${ext}`),
          reason: `matches scenario "${matchedPrefix}" but "${remainder}" isn't a "<NN>--<label>" step suffix`,
        });
      }
      continue;
    }

    const label = shapeMatch[2];
    // CLI_LABELS are always single-file, no pairing expected.
    if (CLI_LABELS.has(label)) continue;

    const hasPng = exts.has('.png');
    const hasJson = exts.has('.json');
    if (hasPng !== hasJson) {
      const presentExt = hasPng ? '.png' : '.json';
      orphans.push({
        file: path.join(snapshotsDir, `${base}${presentExt}`),
        reason: `"${presentExt}" baseline has no matching ${hasPng ? '.json' : '.png'} sibling (regular screenshots are always written as a pair)`,
      });
    }
    if (exts.has('.svg')) {
      orphans.push({
        file: path.join(snapshotsDir, `${base}.svg`),
        reason:
          'unexpected .svg baseline for a non-CLI step (only "cli-svg" steps write .svg here)',
      });
    }
  }

  return orphans;
}
