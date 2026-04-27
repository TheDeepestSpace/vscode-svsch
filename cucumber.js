module.exports = {
  default: {
    paths: ['test/features/**/*.feature'],
    require: ['test/steps/**/*.ts'],
    requireModule: ['ts-node/register'],
    format: ['@cucumber/pretty-formatter', 'json:test-results/bdd/cucumber-report.json'],
    worldParameters: {
      baseUrl: 'http://127.0.0.1:5174'
    }
  }
};
