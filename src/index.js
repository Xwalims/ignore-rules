'use strict';

/**
 * index.js - public API of the ignore-rules package.
 */

const pattern = require('./pattern.js');
const matcher = require('./matcher.js');
const lint = require('./lint.js');
const cli = require('./cli.js');

module.exports = {
  // pattern.js
  parsePattern: pattern.parsePattern,
  parseFile: pattern.parseFile,
  stripTrailingSpaces: pattern.stripTrailingSpaces,

  // matcher.js
  createMatcher: matcher.createMatcher,
  normalizePath: matcher.normalizePath,
  ancestorsOf: matcher.ancestorsOf,

  // lint.js
  lint: lint.lint,
  lintRules: lint.lintRules,
  SEVERITIES: lint.SEVERITIES,

  // cli.js
  run: cli.run,
  parseArgs: cli.parseArgs,
  DEFAULTS: cli.DEFAULTS,
  USAGE: cli.USAGE,
};