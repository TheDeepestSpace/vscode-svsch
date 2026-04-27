const reporter = require('multiple-cucumber-html-reporter');
import * as path from 'path';

reporter.generate({
  jsonDir: 'test-results/bdd/',
  reportPath: 'test-results/bdd/',
  openReportInBrowser: false,
  pageTitle: 'SVSCH BDD Documentation',
  reportName: 'SVSCH Diagram Generation & Manipulation',
  displayDuration: true,
  displayReportTime: true,
  metadata: {
    browser: {
      name: 'chromium',
      version: 'latest'
    },
    device: 'Local Development Machine',
    platform: {
      name: 'linux',
      version: 'ubuntu'
    }
  },
  customData: {
    title: 'Project Info',
    data: [
      { label: 'Project', value: 'SVSCH' },
      { label: 'Release', value: '0.0.1' },
      { label: 'Environment', value: 'Development' }
    ]
  }
});

console.log('Documentation generated: test-results/bdd/index.html');
