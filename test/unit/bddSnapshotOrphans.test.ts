import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findOrphanedBddSnapshots,
  parseFeatureFile,
  sanitizeForSnapshotName,
} from '../bddSnapshotOrphans';

describe('sanitizeForSnapshotName', () => {
  it('mirrors fixtures.ts: each non-alphanumeric char becomes its own hyphen', () => {
    expect(sanitizeForSnapshotName('Selected u2, u3')).toBe('selected-u2--u3');
  });
});

describe('parseFeatureFile', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svsch-bdd-orphans-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeFeature(content: string): string {
    const file = path.join(tempDir, 'test.feature');
    fs.writeFileSync(file, content);
    return file;
  }

  it('gives a plain Scenario its sanitized title as the prefix, with no id suffix', () => {
    const file = writeFeature(`Feature: demo\n\n  Scenario: Moving a single block\n    Given x\n`);
    expect(parseFeatureFile(file)).toEqual([
      { featureFile: file, scenarioName: 'Moving a single block', prefix: 'moving-a-single-block' },
    ]);
  });

  it('numbers each Examples row sequentially, across multiple Examples blocks', () => {
    const file = writeFeature(
      `Feature: demo\n\n` +
        `  Scenario Outline: Reroute trigger\n` +
        `    Given <trigger>\n\n` +
        `    Examples:\n` +
        `      | trigger |\n` +
        `      | click   |\n` +
        `      | press R |\n\n` +
        `    Examples:\n` +
        `      | trigger |\n` +
        `      | third   |\n`,
    );
    expect(parseFeatureFile(file).map((s) => s.prefix)).toEqual([
      'reroute-trigger-1',
      'reroute-trigger-2',
      'reroute-trigger-3',
    ]);
  });

  it('resets the example counter for each new Scenario Outline', () => {
    const file = writeFeature(
      `Feature: demo\n\n` +
        `  Scenario Outline: First\n` +
        `    Given <a>\n` +
        `    Examples:\n` +
        `      | a |\n` +
        `      | 1 |\n\n` +
        `  Scenario Outline: Second\n` +
        `    Given <a>\n` +
        `    Examples:\n` +
        `      | a |\n` +
        `      | 1 |\n` +
        `      | 2 |\n`,
    );
    expect(parseFeatureFile(file).map((s) => s.prefix)).toEqual([
      'first-1',
      'second-1',
      'second-2',
    ]);
  });
});

describe('findOrphanedBddSnapshots', () => {
  let tempDir: string;
  let featuresDir: string;
  let snapshotsDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svsch-bdd-orphans-'));
    featuresDir = path.join(tempDir, 'features');
    snapshotsDir = path.join(featuresDir, 'snapshots');
    fs.mkdirSync(snapshotsDir, { recursive: true });
    fs.writeFileSync(
      path.join(featuresDir, 'demo.feature'),
      `Feature: demo\n\n  Scenario: Moving a block\n    Given x\n`,
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function touch(name: string): void {
    fs.writeFileSync(path.join(snapshotsDir, name), '');
  }

  it("does not flag a live scenario's complete png+json pair", () => {
    touch('moving-a-block--01--after-move.png');
    touch('moving-a-block--01--after-move.json');
    expect(findOrphanedBddSnapshots(featuresDir, snapshotsDir)).toEqual([]);
  });

  it('flags a baseline whose scenario prefix has no live scenario', () => {
    touch('renamed-scenario--01--after-move.png');
    touch('renamed-scenario--01--after-move.json');
    const orphans = findOrphanedBddSnapshots(featuresDir, snapshotsDir);
    expect(orphans).toHaveLength(2);
    expect(orphans.every((o) => o.reason.includes('no live scenario'))).toBe(true);
  });

  it('flags a png with no matching json sibling', () => {
    touch('moving-a-block--01--after-move.png');
    const orphans = findOrphanedBddSnapshots(featuresDir, snapshotsDir);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].reason).toContain('no matching .json sibling');
  });

  it('does not require a json/png pair for cli-png/cli-svg steps', () => {
    touch('moving-a-block--02--cli-png.png');
    touch('moving-a-block--03--cli-svg.svg');
    expect(findOrphanedBddSnapshots(featuresDir, snapshotsDir)).toEqual([]);
  });

  it('does not require a json/png pair for an exported-svg step', () => {
    touch('moving-a-block--04--exported-svg.svg');
    expect(findOrphanedBddSnapshots(featuresDir, snapshotsDir)).toEqual([]);
  });

  it('flags an unexpected svg sibling on a non-CLI step', () => {
    touch('moving-a-block--01--after-move.png');
    touch('moving-a-block--01--after-move.json');
    touch('moving-a-block--01--after-move.svg');
    const orphans = findOrphanedBddSnapshots(featuresDir, snapshotsDir);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].reason).toContain('unexpected .svg baseline');
  });

  it('flags a baseline that matches a live scenario prefix but not the <NN>--<label> shape', () => {
    touch('moving-a-block--not-a-step-number.png');
    const orphans = findOrphanedBddSnapshots(featuresDir, snapshotsDir);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].reason).toContain('step suffix');
  });
});
