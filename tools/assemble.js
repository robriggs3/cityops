// node tools/assemble.js  : rebuilds template.html and index.html from src/
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const engine = fs.readFileSync(path.join(root, 'src', 'cityops.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src', 'cityops.css'), 'utf8').replace(/\n$/, '');

function inline(shell, shellName) {
  if (shell.indexOf('<!--CITYOPS_ENGINE-->') === -1) throw new Error('engine marker missing in ' + shellName);
  if (shell.indexOf('/*CITYOPS_CSS*/') === -1) throw new Error('css marker missing in ' + shellName);
  // A closing script sequence inside authored script text (even in a comment)
  // ends that script element and silently truncates it in the browser.
  const opens = (shell.match(/<script[\s>]/g) || []).length;
  const closes = (shell.match(/<\/script/g) || []).length;
  if (opens !== closes) {
    throw new Error(shellName + ': ' + opens + ' script opens vs ' + closes +
      ' closes; a stray closing script sequence in authored code truncates the block');
  }
  return shell
    .replace('/*CITYOPS_CSS*/', () => css)
    .replace('<!--CITYOPS_ENGINE-->', () => engine);
}

function build(shellName, outName, extra) {
  const shell = fs.readFileSync(path.join(root, 'src', shellName), 'utf8');
  let out = inline(shell, shellName);
  if (extra) out = extra(out, shellName);
  fs.writeFileSync(path.join(root, outName), out);
  console.log('assembled ' + outName);
  return out;
}

// The standalone template, assembled first, is then embedded INSIDE the app so
// the app can write a full offline guide file with no network access. The copy
// keeps a __CITY_DATA__ marker where the city JSON goes.
const template = build('guide-shell.html', 'template.html');

function guideTemplateBlock() {
  const marked = template.replace(
    /(<script type="application\/json" id="city-data">)[\s\S]*?(<\/script>)/,
    (m, open, close) => open + '\n__CITY_DATA__\n' + close
  );
  if (marked === template) throw new Error('city-data block not found in template.html');
  // A <script type="text/plain"> block ends at the first `</script`, so every
  // one inside the embedded copy is escaped; the app reverses this on export.
  const escaped = marked.replace(/<\/script/g, '<\\/script');
  if (escaped.indexOf('</script') !== -1) throw new Error('unescaped </script survived');
  // `<!--` would put the HTML tokenizer into script-data-escaped state, where a
  // later `<script` makes even the real closing tag inert. Nothing in the shell
  // uses HTML comments today; fail loudly if that ever changes.
  if (escaped.indexOf('<!--') !== -1) {
    throw new Error('embedded template contains <!-- which would break the text/plain block');
  }
  return '<script type="text/plain" id="guide-template">\n' + escaped + '\n</script>';
}

if (fs.existsSync(path.join(root, 'src', 'app-shell.html'))) {
  build('app-shell.html', 'index.html', function (out, shellName) {
    if (out.indexOf('<!--CITYOPS_TEMPLATE-->') === -1) throw new Error('template marker missing in ' + shellName);
    return out.replace('<!--CITYOPS_TEMPLATE-->', () => guideTemplateBlock());
  });
}
