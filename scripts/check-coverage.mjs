import fs from 'fs';

const summaryPath = 'coverage/coverage-summary.json';
if (!fs.existsSync(summaryPath)) {
  console.error('coverage-summary.json not found. Run test coverage first.');
  process.exit(1);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const total = summary.total;
const minLinePct = Number(process.env.COVERAGE_MIN_LINES || 50);
const minBranchPct = Number(process.env.COVERAGE_MIN_BRANCHES || 65);

if (!total) {
  console.error('No total coverage data found.');
  process.exit(1);
}

const linePct = Number(total.lines?.pct || 0);
const branchPct = Number(total.branches?.pct || 0);

if (linePct < minLinePct || branchPct < minBranchPct) {
  console.error(`Coverage gate failed: lines=${linePct}% (min ${minLinePct}%), branches=${branchPct}% (min ${minBranchPct}%).`);
  process.exit(1);
}

console.log(`Coverage gate passed: lines=${linePct}%, branches=${branchPct}%.`);
