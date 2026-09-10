import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';
import {
  DEFAULT_CLOCK_SIGNAL_NAMES,
  DEFAULT_RESET_SIGNAL_NAMES,
} from '../../src/parser/textExtractor';

// main.cpp is C++ and can't import the TS defaults, so its own hardcoded
// defaults (applied there, not on the DesignExtractor class) are parsed out
// here and checked for drift too.
const MAIN_CPP_PATH = join(__dirname, '../../src/parser/backend_cpp/src/main.cpp');
const mainCpp = readFileSync(MAIN_CPP_PATH, 'utf-8');

function parseBackendDefault(fieldName: string): string[] {
  const match = mainCpp.match(new RegExp(`extractor\\.${fieldName}\\s*=\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Could not find default for ${fieldName} in main.cpp`);
  return match[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter((entry) => entry.length > 0);
}

describe('package.json configuration defaults', () => {
  const properties = packageJson.contributes.configuration.properties;

  it('svsch.clockSignalNames default matches DEFAULT_CLOCK_SIGNAL_NAMES', () => {
    expect(properties['svsch.clockSignalNames'].default).toEqual(DEFAULT_CLOCK_SIGNAL_NAMES);
  });

  it('svsch.resetSignalNames default matches DEFAULT_RESET_SIGNAL_NAMES', () => {
    expect(properties['svsch.resetSignalNames'].default).toEqual(DEFAULT_RESET_SIGNAL_NAMES);
  });

  it('backend clock_signal_names default matches DEFAULT_CLOCK_SIGNAL_NAMES', () => {
    expect(parseBackendDefault('clock_signal_names')).toEqual(DEFAULT_CLOCK_SIGNAL_NAMES);
  });

  it('backend reset_signal_names default matches DEFAULT_RESET_SIGNAL_NAMES', () => {
    expect(parseBackendDefault('reset_signal_names')).toEqual(DEFAULT_RESET_SIGNAL_NAMES);
  });
});
