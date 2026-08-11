// Extracts the <script id="app"> block from template.html and evals it in Node.
// DOM globals are stubbed so CityOps.init() bails out and only pure logic loads.
const fs = require('fs');
const path = require('path');

function loadCityOps() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'template.html'), 'utf8');
  const m = html.match(/<script id="app">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('No <script id="app"> block in template.html');
  const stubDoc = { getElementById: function () { return null; }, addEventListener: function () {} };
  const fn = new Function('document', 'window', 'localStorage',
    m[1] + '\nreturn CityOps;');
  return fn(stubDoc, undefined, undefined);
}
module.exports = { loadCityOps };
