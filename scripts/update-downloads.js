#!/usr/bin/env node
// Aktualisiert downloads.json und die statischen Links in index.html
// auf eine neue Release-Version.
// Aufruf: node scripts/update-downloads.js <version> <ordner-mit-installern>
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [version, dir] = process.argv.slice(2);
if (!version || !dir) {
  console.error('Aufruf: node scripts/update-downloads.js <version> <ordner>');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const repo = 'leonhr03/pdf-editor';
const base = `https://github.com/${repo}/releases/download/v${version}/`;

const entries = {
  macArm: { label: 'macOS · Apple Silicon', name: `PDF-Editor-${version}-mac-arm64.dmg` },
  macIntel: { label: 'macOS · Intel', name: `PDF-Editor-${version}-mac-x64.dmg` },
  win: { label: 'Windows · 64 Bit', name: `PDF-Editor-${version}-win-x64.exe` },
  linuxAppImage: { label: 'Linux · AppImage', name: `PDF-Editor-${version}-linux-x86_64.AppImage` },
  linuxDeb: { label: 'Linux · Debian/Ubuntu', name: `PDF-Editor-${version}-linux-amd64.deb` }
};

const files = {};
for (const [key, e] of Object.entries(entries)) {
  const file = path.join(dir, e.name);
  if (!fs.existsSync(file)) {
    console.error('Fehlt: ' + e.name);
    process.exit(1);
  }
  files[key] = {
    label: e.label,
    file: 'downloads/' + e.name,
    size: fs.statSync(file).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    url: base + e.name
  };
}
fs.writeFileSync(path.join(root, 'downloads.json'), JSON.stringify({ version, files }, null, 2) + '\n');

// Statische Fallback-Links und Versionsangaben in index.html (falls JS aus ist)
const htmlPath = path.join(root, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
html = html.replace(
  /releases\/download\/v[^/"]+\/PDF-Editor-[^-"]+-/g,
  `releases/download/v${version}/PDF-Editor-${version}-`
);
html = html.replace(/(data-version>)Version [^<]*</g, `$1Version ${version}<`);
html = html.replace(/(data-version>)(?!Version )[^<]*</g, `$1${version}<`);
fs.writeFileSync(htmlPath, html);

console.log('Downloads auf Version ' + version + ' gesetzt.');
