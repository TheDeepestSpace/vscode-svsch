import fs from 'fs';

// ---------------------------------------------------------------------------
// Parses `@tag` lines out of a .feature file without pulling in a full
// Gherkin parser — this only needs to answer "which scenario titles carry a
// given tag", the same job the syntax-book cases loader
// (test/system/partial_diagram_nodes.spec.ts) does for node kinds by reading
// its yaml case files directly instead of going through playwright-bdd's own
// compiler. Tags are expected to sit on their own line(s) directly above a
// `Scenario:`/`Scenario Outline:` line, exactly like the existing `@skip`
// convention already used throughout test/features/*.feature.
// ---------------------------------------------------------------------------

export interface TaggedScenario {
  title: string;
  tags: string[];
}

const SCENARIO_LINE = /^\s*Scenario(?: Outline)?:\s*(.+?)\s*$/;
const TAG_LINE = /^(@[\w-]+(?:\s+@[\w-]+)*)$/;

export function parseFeatureScenarios(featurePath: string): TaggedScenario[] {
  const lines = fs.readFileSync(featurePath, 'utf8').split('\n');
  const scenarios: TaggedScenario[] = [];

  for (let i = 0; i < lines.length; i++) {
    const scenarioMatch = lines[i].match(SCENARIO_LINE);
    if (!scenarioMatch) continue;

    // Walk back over blank lines and comments to collect the tag lines
    // immediately attached to this scenario (e.g. `# TODO...` then `@skip`).
    const tags: string[] = [];
    for (let j = i - 1; j >= 0; j--) {
      const line = lines[j].trim();
      if (line === '' || line.startsWith('#')) continue;
      const tagMatch = line.match(TAG_LINE);
      if (!tagMatch) break;
      tags.unshift(...tagMatch[1].split(/\s+/));
    }

    scenarios.push({ title: scenarioMatch[1], tags });
  }

  return scenarios;
}

export function scenarioTitlesWithTag(featurePath: string, tag: string): string[] {
  return parseFeatureScenarios(featurePath)
    .filter((scenario) => scenario.tags.includes(tag))
    .map((scenario) => scenario.title);
}
