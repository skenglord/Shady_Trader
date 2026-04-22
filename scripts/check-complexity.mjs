import fs from 'fs';
import ts from 'typescript';

const threshold = Number(process.env.COMPLEXITY_MAX || 50);
const files = [
  'backend/api/routes.ts',
  'backend/main.ts',
  'backend/shadow/shadow_trader.ts',
  'backend/strategy/signal_generator.ts'
];

function cyclomaticComplexity(node) {
  let complexity = 1;
  function visit(n) {
    if (
      ts.isIfStatement(n) ||
      ts.isForStatement(n) ||
      ts.isForInStatement(n) ||
      ts.isForOfStatement(n) ||
      ts.isWhileStatement(n) ||
      ts.isDoStatement(n) ||
      ts.isCaseClause(n) ||
      ts.isConditionalExpression(n) ||
      ts.isCatchClause(n)
    ) {
      complexity += 1;
    }

    if (ts.isBinaryExpression(n)) {
      if (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        complexity += 1;
      }
    }

    ts.forEachChild(n, visit);
  }

  ts.forEachChild(node, visit);
  return complexity;
}

const failures = [];

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const sourceText = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, sourceText, ts.ScriptTarget.ESNext, true);

  function walk(node) {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node)
    ) {
      const name = node.name?.getText(sf) || '<anonymous>';
      const c = cyclomaticComplexity(node);
      if (c > threshold) {
        failures.push(`${file} :: ${name} => ${c}`);
      }
    }
    ts.forEachChild(node, walk);
  }

  walk(sf);
}

if (failures.length > 0) {
  console.error(`Complexity gate failed (max ${threshold}).`);
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}

console.log(`Complexity gate passed (max ${threshold}).`);
