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
  // Symmetric guard: if the template already contains a literal escaped sequence
  // before WE escape it, the app's export-time unescape (which reverses exactly
  // one layer of `<\/script` -> `</script`) would corrupt it. This should never
  // happen today (guide-shell.html has no such text) but fail loudly if it does.
  if (marked.indexOf('<\\/script') !== -1) {
    throw new Error('marked template already contains an escaped <\\/script sequence; embedding would not reverse cleanly');
  }
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

// PROMPT.md rides in the app the same way: a text/plain block the prompt
// builders read at runtime, so Build my prompt works offline and with no fetch.
// Standalone guides never get it (the marker lives in app-shell.html only).
function promptTemplateBlock() {
  const prompt = fs.readFileSync(path.join(root, 'PROMPT.md'), 'utf8');
  if (prompt.indexOf('<\\/script') !== -1) {
    throw new Error('PROMPT.md already contains an escaped <\\/script sequence; embedding would not reverse cleanly');
  }
  const escaped = prompt.replace(/<\/script/g, '<\\/script');
  if (escaped.indexOf('</script') !== -1) throw new Error('unescaped </script survived in PROMPT.md');
  // PROMPT.md deliberately carries `<!--` landmarks. That alone is safe (a
  // closing script tag still ends the block from script-data-escaped state),
  // but `<!--` followed by a literal `<script` would put the tokenizer into
  // double-escaped state where the real closing tag goes inert. Fail loudly
  // rather than ship a truncated app.
  if (escaped.indexOf('<!--') !== -1 && /<script[\s>]/.test(escaped)) {
    throw new Error('PROMPT.md mixes <!-- with a literal <script tag; that would break the text/plain block');
  }
  return '<script type="text/plain" id="prompt-template">\n' + escaped + '\n</script>';
}

// The trip surface: the same app, the other half. It brings its own stylesheet
// (a whole editor's worth, with its own tokens under the same names), so it
// takes the ENGINE only and no CSS. What it wants from the engine is syncKit:
// the pure sync decisions the city app already ships and already tests, so the
// two surfaces cannot drift on whose data is newer.
//
// Its script-tag arithmetic differs from the guide shells: the family-share
// page it generates is a template literal containing its own <script> tags,
// whose closers are escaped as `<\/script` precisely so they cannot end the
// authored block. So the balance to check is opens against real closers PLUS
// escaped ones; an unescaped closer in that literal still shows up as a
// mismatch, which is the bug the check exists to catch.
if (fs.existsSync(path.join(root, 'src', 'trip-shell.html'))) {
  const shellName = 'trip-shell.html';
  const shell = fs.readFileSync(path.join(root, 'src', shellName), 'utf8');
  if (shell.indexOf('<!--CITYOPS_ENGINE-->') === -1) throw new Error('engine marker missing in ' + shellName);
  const opens = (shell.match(/<script[\s>]/g) || []).length;
  const closes = (shell.match(/<\/script/g) || []).length;
  const escaped = (shell.match(/<\\\/script/g) || []).length;
  if (opens !== closes + escaped) {
    throw new Error(shellName + ': ' + opens + ' script opens vs ' + closes + ' closes and ' +
      escaped + ' escaped closes; an unescaped closing script sequence in authored code truncates the block');
  }
  fs.writeFileSync(path.join(root, 'trip.html'),
    shell.replace('<!--CITYOPS_ENGINE-->', () => engine));
  console.log('assembled trip.html');
}

if (fs.existsSync(path.join(root, 'src', 'app-shell.html'))) {
  build('app-shell.html', 'index.html', function (out, shellName) {
    if (out.indexOf('<!--CITYOPS_TEMPLATE-->') === -1) throw new Error('template marker missing in ' + shellName);
    if (out.indexOf('<!--CITYOPS_PROMPT-->') === -1) throw new Error('prompt marker missing in ' + shellName);
    return out
      .replace('<!--CITYOPS_TEMPLATE-->', () => guideTemplateBlock())
      .replace('<!--CITYOPS_PROMPT-->', () => promptTemplateBlock());
  });
}
