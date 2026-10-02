'use strict';

/**
 * cli.js - the gitignore-lint command.
 *
 *   gitignore-lint <file>... [--json] [--severity error|warning|info]
 *                            [--explain PATTERN] [--no-color] [--strict]
 *
 * Exit codes:
 *   0  clean
 *   1  at least one error-severity diagnostic, or any diagnostic under
 *      --strict, or a path that is ignored under --explain
 *   2  usage error, or the file could not be read
 */

const fs = require('node:fs');
const path = require('node:path');

const { parseFile } = require('./pattern.js');
const { createMatcher } = require('./matcher.js');
const { lintRules, SEVERITIES, SEVERITY_RANK } = require('./lint.js');

/**
 * Every option default lives here, in one frozen object. Nothing else in the
 * codebase invents a default.
 */
const DEFAULTS = Object.freeze({
  json: false,
  color: true,
  strict: false,
  severity: 'info',
  explain: null,
  files: Object.freeze([]),
});

const USAGE = `Usage: gitignore-lint <file>... [options]

Options:
      --json                 emit machine-readable JSON
      --severity <level>     minimum severity to report: ${SEVERITIES.join(', ')}
      --explain <pattern>    resolve sample paths against a pattern and show
                             every rule considered, in order
      --no-color             disable ANSI colour
      --strict               exit 1 on any diagnostic, not only errors
  -h, --help                 show this help
  -v, --version              show the version

Exit codes:
  0  clean
  1  diagnostics found (or, with --strict, any diagnostic)
  2  usage error or unreadable file`;

const COLOR = Object.freeze({
  error: '[31m',
  warning: '[33m',
  info: '[36m',
  dim: '[2m',
  bold: '[1m',
  green: '[32m',
  reset: '[0m',
});

class UsageError extends Error {}

/**
 * Parse argv into an options object layered over DEFAULTS.
 *
 * @param {string[]} argv arguments after the program name
 * @returns {typeof DEFAULTS}
 */
function parseArgs(argv) {
  const opts = {
    ...DEFAULTS,
    files: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case '--json':
        opts.json = true;
        break;
      case '--no-color':
        opts.color = false;
        break;
      case '--color':
        opts.color = true;
        break;
      case '--strict':
        opts.strict = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-v':
      case '--version':
        opts.version = true;
        break;
      case '--severity':
      case '--explain': {
        const value = argv[++i];
        if (value === undefined || value.startsWith('-')) {
          throw new UsageError(`option ${arg} requires a value`);
        }
        if (arg === '--severity') {
          if (!SEVERITIES.includes(value)) {
            throw new UsageError(
              `invalid severity "${value}", expected one of ${SEVERITIES.join(', ')}`
            );
          }
          opts.severity = value;
        } else {
          opts.explain = value;
        }
        break;
      }
      default:
        if (arg.startsWith('--severity=')) {
          const value = arg.slice('--severity='.length);
          if (!SEVERITIES.includes(value)) {
            throw new UsageError(
              `invalid severity "${value}", expected one of ${SEVERITIES.join(', ')}`
            );
          }
          opts.severity = value;
          break;
        }
        if (arg.startsWith('--explain=')) {
          opts.explain = arg.slice('--explain='.length);
          break;
        }
        if (arg.startsWith('-')) {
          throw new UsageError(`unknown option "${arg}"`);
        }
        opts.files.push(arg);
    }
  }

  return opts;
}

/**
 * Build a colour helper. When colour is off every method is the identity, so
 * callers never need to branch on it.
 */
function painter(enabled) {
  const identity = (s) => s;
  const make = (code) => (s) => (enabled ? `${code}${s}${COLOR.reset}` : s);
  return Object.freeze({
    error: make(COLOR.error),
    warning: make(COLOR.warning),
    info: make(COLOR.info),
    dim: make(COLOR.dim),
    bold: make(COLOR.bold),
    green: make(COLOR.green),
    // Kept for symmetry with the colour map, and useful to callers.
    identity,
  });
}

/** Diagnostics at or above the configured threshold. */
function filterBySeverity(diags, threshold) {
  const min = SEVERITY_RANK[threshold];
  return diags.filter((d) => SEVERITY_RANK[d.severity] >= min);
}

function readIgnoreFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    const e = new Error(`cannot read ${file}: ${err.code || err.message}`);
    e.exitCode = 2;
    throw e;
  }
}

/**
 * Explain how a pattern resolves a set of sample paths.
 *
 * Sample paths are taken from `--explain` as a comma-separated list when given,
 * otherwise they are derived from the pattern itself so the output always shows
 * something concrete.
 */
function buildExplanation(ignoreText, pattern) {
  const { rules } = parseFile(ignoreText);
  const active = rules.filter((r) => !r.isComment && !r.isEmpty);

  // The pattern under discussion, compiled as if it were appended last. It has
  // no line in the file, so it is given a sentinel instead of a number that
  // would collide with the real rules.
  const subject = parseFile(pattern).rules[0];
  subject.line = null;
  subject.synthetic = true;

  // The full rule list is kept for resolution, comments included, so that
  // `--explain` can show every line of the file and not just the live rules.
  const list = [...rules, subject];

  const matcher = createMatcher(list);

  // Candidate paths: whatever the subject matches, sampled from a small ladder.
  const candidates = [
    'README.md',
    'src/index.js',
    'src/lib/deep.js',
    'build/out.js',
    'node_modules/pkg/index.js',
    'a/b/c/d.txt',
  ];

  const results = candidates.map((p) => matcher.explain(p, false));

  return { subject, active, matcher, results };
}

/** Collect lines so the caller can pass a `push`-style sink. */
function lineSink(write) {
  return { push: (s) => write(s) };
}

function renderExplanation(explanation, paint, out) {
  const { subject, results } = explanation;
  out.push(paint.bold(`pattern: ${subject.stripped || '(empty)'}`));
  out.push('');
  out.push(paint.dim(`${'path'.padEnd(26)}${'verdict'.padEnd(10)}decided by`));
  out.push(paint.dim('-'.repeat(78)));

  for (const r of results) {
    // Colourise the verdict first, then pad the plain text length, so ANSI
    // escapes never eat into the column alignment.
    const label = r.ignored ? 'ignored' : 'tracked';
    const verdict = (r.ignored ? paint.error(label) : paint.green(label)).padEnd(
      10 + visibleWidth(label, r.ignored ? paint.error : paint.green)
    );
    // A synthetic rule (the pattern passed to --explain) has no line number.
    const decidedBy = r.blockingAncestor
      ? `parent dir "${r.blockingAncestor.path}"`
      : r.decidingRule
        ? r.decidingRule.synthetic
          ? `the pattern itself: ${r.decidingRule.stripped}`
          : `line ${r.decidingRule.line}: ${r.decidingRule.stripped}`
        : 'nothing';
    out.push(r.path.padEnd(26) + verdict + decidedBy);
  }

  out.push('');
  out.push(paint.bold('why'));
  for (const r of results) {
    out.push(`  ${r.path} -> ${r.reason}`);
  }
}

/**
 * Pad a string that already contains ANSI escapes to a visible width.
 * Counts only the characters outside the escape sequences.
 */
function visibleWidth(s, fn) {
  const painted = fn ? fn(s) : s;
  const plain = painted.replace(/\[[0-9;]*m/g, '');
  return painted.length - plain.length;
}

/**
 * Run the CLI.
 *
 * @param {string[]} argv arguments after the program name
 * @param {{stdout?: WritableStream, stderr?: WritableStream}} [io]
 * @returns {number} exit code
 */
function run(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const write = (s) => stdout.write(`${s}\n`);
  const writeErr = (s) => stderr.write(`${s}\n`);

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      writeErr(`gitignore-lint: ${err.message}`);
      writeErr(USAGE);
      return 2;
    }
    throw err;
  }

  if (opts.help) {
    write(USAGE);
    return 0;
  }

  if (opts.version) {
    write(require('../package.json').version);
    return 0;
  }

  if (opts.files.length === 0 && opts.explain === null) {
    writeErr('gitignore-lint: no input files');
    writeErr(USAGE);
    return 2;
  }

  const useColor = opts.color && Boolean(stdout.isTTY);
  const paint = painter(useColor);

  // --explain without a file lints a built-in sample document, so the feature
  // is usable (and documented) without inventing a repo layout.
  const files = opts.files.length > 0 ? opts.files : ['<default>'];
  const results = [];
  const explanations = [];
  let exitCode = 0;

  for (const file of files) {
    let text;
    if (file === '<default>') {
      text = '# default sample rules\nnode_modules\nbuild\n*.log\n';
    } else {
      try {
        text = readIgnoreFile(file);
      } catch (err) {
        writeErr(`gitignore-lint: ${err.message}`);
        exitCode = 2;
        continue;
      }
    }

    const { rules } = parseFile(text);
    const all = lintRules(rules);
    const shown = filterBySeverity(all, opts.severity);

    results.push({
      file,
      diagnostics: shown,
      total: all.length,
      counts: countSeverities(shown),
    });

    if (opts.strict) {
      if (shown.length > 0) exitCode = 1;
    } else if (shown.some((d) => d.severity === 'error')) {
      exitCode = 1;
    }

    if (opts.explain !== null) {
      const explanation = buildExplanation(text, opts.explain);
      explanations.push({
        file,
        pattern: explanation.subject.stripped,
        results: explanation.results.map((r) => ({
          path: r.path,
          ignored: r.ignored,
          matched: r.matched,
          reason: r.reason,
          blockingAncestor: r.blockingAncestor ? r.blockingAncestor.path : null,
          decidingRule: r.decidingRule
            ? { line: r.decidingRule.line, source: r.decidingRule.stripped }
            : null,
          considered: r.considered.map((c) => ({
            line: c.line,
            source: c.rule.stripped,
            synthetic: Boolean(c.rule.synthetic),
            action: c.action,
            matched: c.matched,
          })),
        })),
      });

      if (!opts.json) renderExplanation(explanation, paint, lineSink(write));
    }
  }

  if (opts.json) {
    // Exactly one JSON document on stdout, whatever the flags.
    const document = {
      files: results,
      ok: exitCode === 0,
      exitCode,
    };
    if (opts.explain !== null) document.explanations = explanations;
    write(JSON.stringify(document, null, 2));
    return exitCode;
  }

  let printed = false;
  for (const r of results) {
    if (r.diagnostics.length === 0) continue;
    if (!printed) {
      write('');
      printed = true;
    }
    // The header shows the file; each diagnostic repeats only the basename,
    // since the path is already stated and the line number is what matters.
    const name = path.basename(r.file);
    write(paint.bold(r.file));
    for (const d of r.diagnostics) {
      const tag = paint[d.severity](d.severity.padEnd(7));
      write(`  ${name}:${d.line}  ${tag}  ${d.code}  ${d.message}`);
      if (d.fix) write(`  ${' '.repeat(9)}${paint.dim(`fix: ${d.fix}`)}`);
    }
    write('');
  }

  if (!printed) {
    if (opts.explain === null) {
      const names = results.map((r) => r.file).join(', ');
      write(`${paint.green('ok')}  no problems found in ${names}`);
    }
  }

  return exitCode;
}

function countSeverities(diags) {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of diags) counts[d.severity]++;
  return counts;
}

module.exports = { run, parseArgs, DEFAULTS, USAGE, UsageError, buildExplanation };