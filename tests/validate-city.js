// node tests/validate-city.js cities/batumi.json
const fs = require('fs');
const { loadCityOps } = require('./harness');
const C = loadCityOps();
const res = C.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (res.data) {
  const st = { plan: 0, backup: 0, archived: 0, done: 0 };
  res.data.items.forEach(i => st[i.status]++);
  console.log('VALID ' + C.cityId(res.data) + ': ' + res.data.items.length + ' items (' +
    Object.keys(st).map(k => st[k] + ' ' + k).join(', ') + '), ' +
    res.data.sections.length + ' sections');
} else {
  console.error('INVALID:\n- ' + res.errors.join('\n- '));
  process.exit(1);
}
