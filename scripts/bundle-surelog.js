#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function usage() {
  console.error('Usage: node scripts/bundle-surelog.js --src /path/to/surelog');
  process.exit(2);
}

const argv = process.argv.slice(2);
let src;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--src' && argv[i + 1]) { src = argv[i + 1]; i++; }
}
src = src || process.env.SURELOG_SRC;
if (!src) usage();

if (!fs.existsSync(src)) {
  console.error('Source Surelog binary not found:', src);
  process.exit(1);
}

const destDir = path.join(__dirname, '..', 'dist', 'surelog', 'bin');
fs.mkdirSync(destDir, { recursive: true });
const dest = path.join(destDir, 'surelog');

fs.copyFileSync(src, dest);
fs.chmodSync(dest, 0o755);

console.log('Copied Surelog to', dest);
process.exit(0);
