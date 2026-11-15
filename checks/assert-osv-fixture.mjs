import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const report = JSON.parse(readFileSync('osv-results.json', 'utf8'));
const packages = report.results?.flatMap((result) => result.packages ?? []) ?? [];
assert.ok(packages.some((entry) => entry.package?.name === 'lodash' && entry.vulnerabilities?.length),
  'OSV must report a known vulnerability for the isolated lodash dev dependency; an API/scanner error is not a successful test.');
console.log('PASS: OSV identified the vulnerable dev dependency using the generated lockfile.');
