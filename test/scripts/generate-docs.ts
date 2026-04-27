import * as reporter from 'cucumber-html-reporter';
import * as path from 'path';

const options: reporter.Options = {
  theme: 'bootstrap',
  jsonFile: 'test-results/bdd/cucumber-report.json',
  output: 'test-results/bdd/documentation.html',
  reportSuiteAsScenarios: true,
  scenarioTimestamp: true,
  launchReport: false,
  metadata: {
    "App Version": "0.0.1",
    "Test Environment": "Development",
    "Browser": "Chromium",
    "Platform": "Linux",
    "Parallel": "Scenarios",
    "Executed": "Local"
  }
};

reporter.generate(options);
console.log('Documentation generated: test-results/bdd/documentation.html');
