// Optional convenience: node tools/embed.js cities/batumi.json batumi.html
// Equivalent to manually pasting the JSON into template.html's city-data block.
const fs = require('fs');
const path = require('path');
const [, , jsonPath, outPath] = process.argv;
if (!jsonPath || !outPath) {
  console.error('usage: node tools/embed.js <city.json> <out.html>');
  process.exit(1);
}
const root = path.join(__dirname, '..');
const tpl = fs.readFileSync(path.join(root, 'template.html'), 'utf8');
const json = fs.readFileSync(jsonPath, 'utf8').trim();
if (json.indexOf('</script') !== -1) { console.error('JSON contains </script'); process.exit(1); }
const out = tpl.replace(
  /(<script type="application\/json" id="city-data">)[\s\S]*?(<\/script>)/,
  function (m, open, close) { return open + '\n' + json + '\n' + close; }
);
if (out === tpl) { console.error('city-data block not found'); process.exit(1); }
fs.writeFileSync(outPath, out);
console.log('wrote ' + outPath);
