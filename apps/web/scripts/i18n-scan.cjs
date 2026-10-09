/**
 * i18n scanner (also used by tests/i18n-coverage.test.ts).
 *   node scripts/i18n-scan.cjs            -> prints untranslated user text + missing Hindi keys
 *   node scripts/i18n-scan.cjs --keys     -> prints every t()/msg() key as JSON
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
const DIRS = ['app', 'components', 'lib'];
// app/layout.tsx is a server component (browser tab title only); the rest here is not user-visible text.
const SKIP = [/^app[\\/]layout\.tsx$/, /^app[\\/]api[\\/]/, /^lib[\\/]i18n/, /^lib[\\/]server[\\/]/, /^lib[\\/](sse|cache-merge|realtime|types|permissions)\.tsx?$/, /^lib[\\/]brand\.ts$/, /^components[\\/]landing[\\/]code-samples\.ts$/, /^components[\\/]whatsapp[\\/]api-snippets\.ts$/, /^components[\\/]billing[\\/]invoice-html\.ts$/,/^components[\\/]nav-icons\.tsx$/];
const PROPS = new Set(['title', 'label', 'description', 'body', 'hint', 'placeholder', 'header', 'confirmLabel', 'submitLabel', 'aria-label', 'alt', 'subtitle', 'caption', 'error']);
const T_FUNCS = new Set(['t', 'tr', 'tx', 'msg']);
// Proper nouns / codes that read the same in both languages.
const SAME = new Set(['WhatsApp', 'HyperSender', 'EN', 'API', 'QR', 'OK', 'JSON', 'URL', 'ID', 'UPI', 'COD', 'GST', 'PDF', 'CSV', 'Webhook', 'Webhooks', 'AI']);

function files() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(tsx|ts)$/.test(e.name) && !e.name.endsWith('.d.ts') && !SKIP.some((r) => r.test(rel))) out.push(rel);
    }
  };
  DIRS.forEach(walk);
  return out;
}

const isClassy = (s) => {
  const toks = s.trim().split(/\s+/);
  const cls = toks.filter((x) => /^[!-]?[a-z0-9]+(-[a-z0-9./[\]%#]+)+$|^[a-z]+:[\w:[\]./%-]+$|^(flex|grid|block|hidden|truncate|italic|underline|rounded|shadow|border|relative|absolute|sticky|fixed|inline|contents|uppercase|lowercase|capitalize|antialiased|transition|grow|shrink|isolate|invisible|visible|static)$/.test(x));
  return cls.length >= Math.max(1, toks.length * 0.6);
};
const looksLikeText = (s) => {
  const x = s.trim();
  if (!/[A-Za-z]{2,}/.test(x) || SAME.has(x) || isClassy(x)) return false;
  if (/^(\/|https?:|[a-z]+:\/\/|#|\.)/.test(x) || /^[A-Z0-9_ ,|.:-]+$/.test(x)) return false;
  // one word: only a Capitalised word counts as UI text ('Never', 'Issued'); enum values, keys, camelCase do not
  if (!/\s/.test(x)) return /^[A-Z][a-z]/.test(x) && !/[\/@_]/.test(x) && !/^[A-Z][a-z]+[A-Z]/.test(x);
  return true;
};

function program() {
  const cfgPath = path.join(ROOT, 'tsconfig.json');
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, ROOT);
  return ts.createProgram(parsed.fileNames, parsed.options);
}

/** A literal whose expected type is a fixed union of strings is a value (step id, tone), not UI text. */
function typedValue(checker, n) {
  const ct = checker.getContextualType(n);
  if (!ct) return false;
  const parts = ct.isUnion() ? ct.types : [ct];
  return parts.length > 0 && parts.every((p) => p.isStringLiteral() || (p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null))) && parts.some((p) => p.isStringLiteral());
}

function scan() {
  const keys = new Map();
  const problems = [];
  const prog = program();
  const checker = prog.getTypeChecker();
  for (const rel of files()) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const sf = prog.getSourceFile(path.join(ROOT, rel).replace(/\\/g, '/')) ?? ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const where = (n) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    const inTCall = (n) => ts.isCallExpression(n.parent) && T_FUNCS.has(n.parent.expression.getText(sf)) && n.parent.arguments[0] === n;
    const ignoredContext = (n) => {
      for (let p = n.parent; p; p = p.parent) {
        if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isTypeNode(p) || ts.isLiteralTypeNode(p)) return true;
        if (ts.isExpressionStatement(p) && ts.isSourceFile(p.parent)) return true; // 'use client'
        if (ts.isNewExpression(p) && /Error$/.test(p.expression.getText(sf))) return true; // developer errors
        if (ts.isPropertyAssignment(p) && p.parent && ts.isObjectLiteralExpression(p.parent) && ts.isVariableDeclaration(p.parent.parent) && p.parent.parent.name.getText(sf) === 'metadata') return true;
        if (ts.isJsxAttribute(p) && ['className', 'href', 'id', 'name', 'type', 'role', 'key', 'value', 'defaultValue', 'autoComplete', 'inputMode', 'pattern', 'lang', 'htmlFor', 'accept', 'rel', 'target', 'tone', 'variant', 'size'].includes(p.name.getText(sf))) return true;
        if (ts.isCallExpression(p) && ['cx', 'api', 'require', 'fetch', 'useQuery', 'useMutation', 'setItem', 'getItem', 'removeItem', 'get', 'set', 'has', 'startsWith', 'endsWith', 'includes', 'replace', 'split', 'join', 'test', 'match', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'NumberFormat', 'DateTimeFormat', 'assign', 'replaceState', 'open', 'addEventListener', 'removeEventListener', 'querySelector', 'invalidateQueries', 'qs', 'console'].some((f) => p.expression.getText(sf).endsWith(f))) return true;
        if (ts.isBinaryExpression(p) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(p.operatorToken.kind)) return true;
        if (ts.isCaseClause(p) || ts.isElementAccessExpression(p) || ts.isPropertyAccessExpression(p)) return true;
        if (ts.isPropertyAssignment(p) && ['className', 'queryKey', 'method', 'tone', 'id', 'key', 'type', 'status', 'href', 'code', 'value', 'kind', 'dateStyle', 'timeStyle', 'currency', 'style'].includes(p.name.getText(sf))) return true;
        if (ts.isBlock(p) || ts.isSourceFile(p)) return false;
      }
      return false;
    };
    const lines = src.split(/\r?\n/);
    const ignored = (n) => { const l = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line; return /i18n-ignore/.test(lines[l] ?? '') || /i18n-ignore/.test(lines[l - 1] ?? ''); };
    const visit = (n) => {
      if (!ts.isSourceFile(n) && ignored(n) && !((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && inTCall(n))) { ts.forEachChild(n, visit); return; }
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && inTCall(n)) {
        keys.set(n.text, keys.get(n.text) ?? where(n));
      } else if (ts.isJsxText(n) && /[A-Za-z]/.test(n.getText(sf)) && !SAME.has(n.getText(sf).trim())) {
        problems.push(`${where(n)}  JSX text: ${n.getText(sf).trim().slice(0, 70)}`);
      } else if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer) && PROPS.has(n.name.getText(sf)) && /[A-Za-z]/.test(n.initializer.text) && !SAME.has(n.initializer.text)) {
        problems.push(`${where(n)}  prop ${n.name.getText(sf)}="${n.initializer.text.slice(0, 60)}"`);
      } else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && !inTCall(n) && looksLikeText(n.text) && !ignoredContext(n) && !typedValue(checker, n)) {
        problems.push(`${where(n)}  string: ${n.text.slice(0, 70)}`);
      } else if (ts.isTemplateExpression(n) && !ignoredContext(n) && [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].some((x) => /[A-Za-z]{3,}\s|\s[A-Za-z]{3,}/.test(x) && !isClassy(x)) && !inTCall(n)) {
        problems.push(`${where(n)}  template: ${n.getText(sf).slice(0, 80)}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { keys, problems };
}

function missingHindi(keys) {
  const hi = new Map();
  const visit = (n) => {
    if (ts.isPropertyAssignment(n) && (ts.isStringLiteral(n.name) || ts.isIdentifier(n.name)) && ts.isStringLiteral(n.initializer)) hi.set(n.name.text, n.initializer.text);
    ts.forEachChild(n, visit);
  };
  // Code-side dictionaries (i18n-hi-db.ts holds backend texts, which the code scan cannot see as keys).
  for (const file of ['i18n-hi.ts', 'i18n-hi-landing.ts', 'i18n-hi-marketing.ts']) {
    const src = fs.readFileSync(path.join(ROOT, 'lib', file), 'utf8');
    visit(ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true));
  }
  const missing = [...keys.keys()].filter((k) => !SAME.has(k) && !hi.get(k));
  const unused = [...hi.keys()].filter((k) => !keys.has(k));
  return { missing, unused, hi };
}

module.exports = { scan, missingHindi, SAME };

if (require.main === module) {
  const { keys, problems } = scan();
  if (process.argv.includes('--keys')) { console.log(JSON.stringify([...keys.keys()], null, 1)); process.exit(0); }
  const { missing, unused } = missingHindi(keys);
  console.log(problems.join('\n'));
  console.log(`\n${problems.length} untranslated spots, ${keys.size} keys, ${missing.length} missing Hindi, ${unused.length} unused Hindi`);
  if (process.argv.includes('--missing')) console.log(JSON.stringify(missing, null, 1));
}
