#!/usr/bin/env node
'use strict';

const { run } = require('../src/cli.js');

process.exitCode = run(process.argv.slice(2));