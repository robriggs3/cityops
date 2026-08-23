// Shared by tools that consume a city dataset (today: embed.js). Accepts
// either cities/<city>.json directly, or a .md handoff from an AI chat that
// wraps the same JSON in a fenced code block (chats often hand back .md
// instead of raw .json). The .md path is never parsed as prose: it only
// looks for a fenced code block whose contents parse as JSON.
const fs = require('fs');
const path = require('path');
// tests/harness.js already loads the real CityOps.parse/validate straight out
// of template.html, so validation here can never drift from what the app
// actually enforces. The fence-extraction rules live in the same engine now
// (CityOps.extractJsonBlock), ported there so the in-app "generate with
// Claude" path (Phase 2) and this CLI path share one rule instead of two
// copies that can drift.
const { loadCityOps } = require('../tests/harness');

// Reads a city dataset from a .json or .md path and validates it against the
// real template.html contract. Returns { json, data, mdSourcePath }, where
// json is the canonical JSON text and mdSourcePath is set only when the
// input was a .md file. Throws Error with a message safe to print as-is.
function readCityInput(inputPath) {
  const raw = fs.readFileSync(inputPath, 'utf8');
  const isMd = /\.md$/i.test(inputPath);
  let json = raw.trim();
  let mdSourcePath = null;
  const C = loadCityOps();

  if (isMd) {
    const block = C.extractJsonBlock(raw);
    if (block === null) {
      throw new Error(
        'No parseable ```json code block found in ' + inputPath + '.\n' +
        C.RETRY_INSTRUCTION
      );
    }
    json = block;
    mdSourcePath = inputPath;
  }

  const res = C.parse(json);
  if (!res.data) {
    throw new Error(inputPath + ' failed validation:\n- ' + res.errors.join('\n- '));
  }
  // Re-serialize so the file written to cities/ has a consistent shape no
  // matter how the source chat formatted its JSON.
  const canonical = JSON.stringify(res.data, null, 2) + '\n';
  return { json: canonical, data: res.data, mdSourcePath: mdSourcePath };
}

// Writes the canonical cities/<city>.json next to a .md source (same
// directory, same base name) so the repo keeps JSON as the source of truth.
// Returns the path written.
function writeCanonicalJson(mdSourcePath, canonicalJson) {
  const outPath = path.join(
    path.dirname(mdSourcePath),
    path.basename(mdSourcePath).replace(/\.md$/i, '.json')
  );
  fs.writeFileSync(outPath, canonicalJson);
  return outPath;
}

// extractJsonBlock is re-exported for any caller that only wants the fence
// rule; it delegates to the engine copy so there is still only one
// implementation.
module.exports = {
  readCityInput: readCityInput, writeCanonicalJson: writeCanonicalJson,
  extractJsonBlock: function (md) { return loadCityOps().extractJsonBlock(md); }
};
