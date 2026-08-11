// node tools/assemble.js  : rebuilds template.html and index.html from src/
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const engine = fs.readFileSync(path.join(root, 'src', 'cityops.js'), 'utf8');
function build(shellName, outName) {
  const shell = fs.readFileSync(path.join(root, 'src', shellName), 'utf8');
  if (shell.indexOf('<!--CITYOPS_ENGINE-->') === -1) throw new Error('marker missing in ' + shellName);
  fs.writeFileSync(path.join(root, outName), shell.replace('<!--CITYOPS_ENGINE-->', () => engine));
  console.log('assembled ' + outName);
}
build('guide-shell.html', 'template.html');
if (fs.existsSync(path.join(root, 'src', 'app-shell.html'))) build('app-shell.html', 'index.html');
