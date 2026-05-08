const assert = require('assert');
const {
  FREE_REPORT_LIMITS,
  PRO_REPORT_LIMITS,
  AGENCY_REPORT_LIMITS,
  countCsvRows,
  validateCsvUploads,
  normalizeEmail,
  hashValue,
} = require('./_limits');

const csv = (rows) => Buffer.from(rows.join('\n'), 'utf8');

assert.strictEqual(FREE_REPORT_LIMITS.planLabel, 'Free Snapshot');
assert.strictEqual(PRO_REPORT_LIMITS.maxFiles, 5);
assert.strictEqual(AGENCY_REPORT_LIMITS.maxTotalRows, 250000);
assert.strictEqual(normalizeEmail('  Test@Example.com '), 'test@example.com');
assert.strictEqual(hashValue('abc').length, 16);
assert.strictEqual(countCsvRows(csv(['a,b', '1,2', '3,4'])), 2);

const tooManyFiles = validateCsvUploads({
  files: [
    { filename: 'a.csv', contentType: 'text/csv' },
    { filename: 'b.csv', contentType: 'text/csv' },
    { filename: 'c.csv', contentType: 'text/csv' },
  ],
  buffers: [csv(['h', '1']), csv(['h', '1']), csv(['h', '1'])],
  limits: FREE_REPORT_LIMITS,
});
assert.strictEqual(tooManyFiles.ok, false);
assert.match(tooManyFiles.error, /up to 2 CSV exports/i);

const oversized = validateCsvUploads({
  files: [{ filename: 'a.csv', contentType: 'text/csv' }],
  buffers: [Buffer.alloc(FREE_REPORT_LIMITS.maxFileBytes + 1, 'a')],
  limits: FREE_REPORT_LIMITS,
});
assert.strictEqual(oversized.ok, false);
assert.match(oversized.error, /under 3 MB/i);

const nonCsv = validateCsvUploads({
  files: [{ filename: 'a.txt', contentType: 'text/plain' }],
  buffers: [csv(['h', '1'])],
  limits: FREE_REPORT_LIMITS,
});
assert.strictEqual(nonCsv.ok, false);
assert.match(nonCsv.error, /Unsupported file type/i);

const tooManyRows = validateCsvUploads({
  files: [{ filename: 'a.csv', contentType: 'text/csv' }],
  buffers: [csv(['h', ...Array.from({ length: FREE_REPORT_LIMITS.maxTotalRows + 1 }, (_, i) => `${i},${i}`)])],
  limits: FREE_REPORT_LIMITS,
});
assert.strictEqual(tooManyRows.ok, false);
assert.match(tooManyRows.error, /5,000 rows/i);

const validTwoFile = validateCsvUploads({
  files: [
    { filename: 'google.csv', contentType: 'text/csv' },
    { filename: 'meta.csv', contentType: 'text/csv' },
  ],
  buffers: [csv(['h', '1']), csv(['h', '2'])],
  limits: FREE_REPORT_LIMITS,
});
assert.strictEqual(validTwoFile.ok, true);
assert.strictEqual(validTwoFile.totalRows, 2);

console.log('api/test_limits.js passed');
