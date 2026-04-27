module.exports = {
  default: {
    paths: ['test/features/**/*.feature'],
    require: ['test/steps/**/*.ts'],
    requireModule: ['ts-node/register'],
    format: ['progress', 'summary'],
    worldParameters: {
      baseUrl: 'http://127.0.0.1:5174'
    }
  }
};
