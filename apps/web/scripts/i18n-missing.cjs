/**
 * Prints the t()/msg() keys that still have no Hindi translation, grouped by the
 * file where each first appears.  node scripts/i18n-missing.cjs [filter]
 */
const { scan, missingHindi } = require('./i18n-scan.cjs');
const { keys } = scan();
const { missing } = missingHindi(keys);
const filter = process.argv[2];
const by = {};
for (const k of missing) {
  const f = keys.get(k).replace(/:\d+$/, '').split('\\').join('/');
  if (filter && !f.includes(filter)) continue;
  (by[f] = by[f] || []).push(k);
}
let n = 0;
for (const f of Object.keys(by).sort()) {
  console.log(`## ${f}`);
  for (const k of by[f]) { console.log(JSON.stringify(k)); n++; }
}
console.log(`# ${n} missing`);
