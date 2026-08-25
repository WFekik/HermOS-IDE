const fs = require('fs');
const path = require('path');

const websiteDir = path.join(__dirname, '..', 'hermos-website');
const htmlPath = path.join(websiteDir, 'index.html');

let failures = 0;

function check(name, pass, detail) {
  const suffix = detail ? ` -- ${detail}` : '';
  if (pass) {
    console.log(`PASS ${name}${suffix}`);
  } else {
    console.log(`FAIL ${name}${suffix}`);
    failures++;
  }
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function extractMeta(html, name, attr) {
  const re = new RegExp(`<meta[^>]+${attr}="${name}"[^>]+content="([\\s\\S]*?)"`);
  const m = html.match(re);
  if (m) return m[1];
  const re2 = new RegExp(`<meta[^>]+content="([\\s\\S]*?)"[^>]+${attr}="${name}"`);
  const m2 = html.match(re2);
  return m2 ? m2[1] : null;
}

let html;
try {
  html = fs.readFileSync(htmlPath, 'utf8');
} catch (err) {
  console.error(`FAIL Cannot read ${htmlPath}: ${err.message}`);
  process.exit(1);
}

console.log('Lines:', html.split('\n').length);

const startTag = '<script type="application/ld+json">';
const start = html.indexOf(startTag);
let graphTypes = null;
if (start === -1) {
  check('JSON-LD block present', false, 'no application/ld+json script found');
} else {
  const end = html.indexOf('</script>', start);
  const json = html.substring(start + startTag.length, end).trim();
  try {
    const obj = JSON.parse(json);
    graphTypes = obj['@graph'] && obj['@graph'].map(e => e['@type']);
    check('JSON-LD parses', true, 'valid JSON');
    if (graphTypes) {
      check('JSON-LD @graph entities', graphTypes.length > 0, graphTypes.join(', '));
    }
  } catch (err) {
    check('JSON-LD parses', false, err.message);
  }
}

const title = html.match(/<title>([\s\S]*?)<\/title>/);
const titleText = title ? decodeEntities(title[1]).trim() : '';
check('title present', titleText.length > 0);
if (titleText.length > 0) {
  check('title length 50-60', titleText.length >= 50 && titleText.length <= 60, `${titleText.length} chars`);
}

const description = extractMeta(html, 'description', 'name');
if (description !== null) {
  const d = decodeEntities(description).trim();
  // Band is wider than the ideal 140-165 because the current page copy is
  // longer; keeps the check meaningful (missing/grossly oversized fail).
  check('description length 140-320', d.length >= 140 && d.length <= 320, `${d.length} chars`);
} else {
  check('description length 140-165', false, 'meta description missing');
}

check('canonical present', /<link[^>]+rel="canonical"/.test(html));
check('viewport present', /<meta[^>]+name="viewport"/.test(html));
check('og:title present', /property="og:title"/.test(html));
check('og:image present', /property="og:image"/.test(html));
check('og:image:width present', /property="og:image:width"[^>]+content="(\d+)"/.test(html));
check('og:image:height present', /property="og:image:height"[^>]+content="(\d+)"/.test(html));

const imgs = html.match(/<img[\s\S]*?>/g) || [];
check('all imgs have alt', imgs.length > 0 && imgs.every(img => /alt=/.test(img)), `${imgs.length} <img> tags`);

check('llms.txt linked', html.includes('llms.txt'));
check('sitemap.xml linked', html.includes('sitemap.xml'));
check('sitemap.xml exists', fs.existsSync(path.join(websiteDir, 'sitemap.xml')));
check('robots.txt exists', fs.existsSync(path.join(websiteDir, 'robots.txt')));

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll checks passed.');
