// Optional convenience: node tools/embed.js cities/batumi.json batumi.html
// Equivalent to manually pasting the JSON into template.html's city-data block.
// Also accepts a .md handoff from an AI chat (the JSON wrapped in a fenced
// code block); see tools/city-input.js.
const fs = require('fs');
const path = require('path');
const { readCityInput, writeCanonicalJson } = require('./city-input');
const [, , jsonPath, outPath] = process.argv;
if (!jsonPath || !outPath) {
  console.error('usage: node tools/embed.js <city.json|city.md> <out.html>');
  process.exit(1);
}
const root = path.join(__dirname, '..');
const tpl = fs.readFileSync(path.join(root, 'template.html'), 'utf8');

let input;
try {
  input = readCityInput(jsonPath);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (input.mdSourcePath) {
  const written = writeCanonicalJson(input.mdSourcePath, input.json);
  console.log('extracted JSON from ' + jsonPath + ' and wrote ' + written);
}

const json = input.json.trim();
if (json.indexOf('</script') !== -1) { console.error('JSON contains </script'); process.exit(1); }
const out = tpl.replace(
  /(<script type="application\/json" id="city-data">)[\s\S]*?(<\/script>)/,
  function (m, open, close) { return open + '\n' + json + '\n' + close; }
);
if (out === tpl) { console.error('city-data block not found'); process.exit(1); }
fs.writeFileSync(outPath, out);
console.log('wrote ' + outPath);
