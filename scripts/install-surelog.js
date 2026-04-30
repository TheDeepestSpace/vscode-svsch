#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SURELOG_VERSION = process.env.SURELOG_VERSION || '1.84.1';
const WHEEL_NAME = `sc_surelog-${SURELOG_VERSION}-cp310-cp310-manylinux_2_17_x86_64.manylinux2014_x86_64.whl`;
const WHEEL_URL = `https://github.com/siliconcompiler/sc-surelog/releases/download/v${SURELOG_VERSION}/${WHEEL_NAME}`;

function log(...args) { console.log('[install-surelog]', ...args); }
function abort(msg) { console.error('[install-surelog] ERROR:', msg); process.exit(1); }

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: node scripts/install-surelog.js [--src /path/to/surelog]');
  console.log('Environment: set SURELOG_AUTO_INSTALL=1 to allow automatic download and install.');
  process.exit(0);
}

const srcArgIndex = process.argv.indexOf('--src');
const srcPath = srcArgIndex >= 0 ? process.argv[srcArgIndex + 1] : process.env.SURELOG_SRC;
const autoInstall = process.env.SURELOG_AUTO_INSTALL === '1';

const outDir = path.join(__dirname, '..', 'dist', 'surelog');
const outBinDir = path.join(outDir, 'bin');
const dest = path.join(outBinDir, 'surelog');

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

async function main() {
  // Prefer explicit source
  if (srcPath) {
    if (!fs.existsSync(srcPath)) abort(`Provided source not found: ${srcPath}`);
    ensureDir(outBinDir);
    fs.copyFileSync(srcPath, dest);
    fs.chmodSync(dest, 0o755);
    log('Copied local surelog to', dest);
    return;
  }

  if (fs.existsSync(dest)) {
    log('Surelog already exists at', dest);
    return;
  }

  if (!autoInstall) {
    log('Auto-install disabled. To enable, set SURELOG_AUTO_INSTALL=1 or pass --src');
    return;
  }

  if (process.platform !== 'linux' || process.arch !== 'x64') {
    abort('Automatic install currently supports linux x86_64 only. Provide --src to bundle a binary.');
  }

  ensureDir(outDir);
  const tmpWheel = path.join(outDir, WHEEL_NAME);

  try {
    log('Downloading surelog wheel from', WHEEL_URL);
    execSync(`curl -L -o "${tmpWheel}" "${WHEEL_URL}"`, { stdio: 'inherit' });

    log('Extracting surelog binary from wheel');
    ensureDir(outBinDir);
    // Extract only the binary we need
    execSync(`unzip -p "${tmpWheel}" "surelog/bin/surelog" > "${dest}"`, { stdio: 'inherit' });
    fs.chmodSync(dest, 0o755);
    
    log('Cleaning up');
    fs.unlinkSync(tmpWheel);

    log('Installed surelog to', dest);
  } catch (e) {
    if (fs.existsSync(tmpWheel)) fs.unlinkSync(tmpWheel);
    abort(e.message || String(e));
  }
}

main();
