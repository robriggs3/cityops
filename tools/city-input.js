// Shared by tools that consume a city dataset (today: embed.js). Accepts
// either cities/<city>.json directly, or a .md handoff from an AI chat that
// wraps the same JSON in a fenced code block (chats often hand back .md
// instead of raw .json). The .md path is never parsed as prose: it only
// looks for a fenced code block whose contents parse as JSON.
const fs = require('fs');
const path = require('path');
// tests/harness.js already loads the real CityOps.parse/validate straight out
// of template.html, so validation here can never drift from what the app
// actually enforces.
const { loadCityOps } = require('../tests/harness');

// Matches ```json ... ``` or a bare ``` ... ``` fence. Chats sometimes forget
// the `json` language tag, so a bare fence is accepted too as long as its
// contents parse.
const FENCE_RE = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g;

// Returns the trimmed text of the first fenced block that parses as JSON, or
// null if the file has no fenced block that does.
function extractJsonBlock(md) {
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(md)) !== null) {
    const body = m[1].trim();
    try {
      JSON.parse(body);
      return body;
    } catch (e) {
      // Not this fence (e.g. a ```bash block before the JSON one); keep looking.
    }
  }
  return null;
}

const RETRY_INSTRUCTION =
  'Ask the chat to reply again with: "reply with the full city guide as a ' +
  'single ```json code block and nothing else after it."';

// Reads a city dataset from a .json or .md path and validates it against the
// real template.html contract. Returns { json, data, mdSourcePath }, where
// json is the canonical JSON text and mdSourcePath is set only when the
// input was a .md file. Throws Error with a message safe to print as-is.
function readCityInput(inputPath) {
  const raw = fs.readFileSync(inputPath, 'utf8');
  const isMd = /\.md$/i.test(inputPath);
  let json = raw.trim();
  let mdSourcePath = null;

  if (isMd) {
    const block = extractJsonBlock(raw);
    if (block === null) {
      throw new Error(
        'No parseable ```json code block found in ' + inputPath + '.\n' +
        RETRY_INSTRUCTION
      );
    }
    json = block;
    mdSourcePath = inputPath;
  }

  const C = loadCityOps();
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

module.exports = { readCityInput: readCityInput, writeCanonicalJson: writeCanonicalJson, extractJsonBlock: extractJsonBlock };
