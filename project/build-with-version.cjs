// Builds with version <major>.<minor>.<number of git commits> without modifying package.json.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('./package.json');

function computeVersion() {
  try {
    const count = Number.parseInt(
      execFileSync('git', ['rev-list', '--count', 'HEAD'], {
        cwd: __dirname,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
      10
    );
    if (Number.isFinite(count) && count > 0) {
      const [major, minor] = String(pkg.version || '1.0.0').split('.');
      return `${Number.parseInt(major, 10) || 0}.${Number.parseInt(minor, 10) || 0}.${count}`;
    }
  } catch { /* git unavailable */ }
  return pkg.version;
}

if (process.argv.includes('--print-version')) {
  process.stdout.write(computeVersion());
  process.exit(0);
}

const version = computeVersion();

// Record local project path inside the package so the installed app can trigger local updates.
try {
  fs.writeFileSync(path.join(__dirname, 'project-meta.json'), JSON.stringify({ projectRoot: __dirname }, null, 2), 'utf8');
} catch { /* optional */ }

console.log(`[Build] Building version ${version}...`);
const result = spawnSync(
  process.execPath,
  [require.resolve('electron-builder/out/cli/cli.js'), `--config.extraMetadata.version=${version}`, ...process.argv.slice(2)],
  { cwd: __dirname, stdio: 'inherit', shell: false }
);

const args = process.argv.slice(2);
const buildingWindows = args.includes('--win') || (process.platform === 'win32' && !args.includes('--mac') && !args.includes('--linux'));
const buildingMac = args.includes('--mac') || (process.platform === 'darwin' && !args.includes('--win') && !args.includes('--linux'));

if (result.status === 0 && buildingMac) {
  const outputDir = path.resolve(__dirname, pkg.build?.directories?.output || 'dist_electron');
  const prefix = `${pkg.build?.productName || pkg.name}-`;
  const currentPrefix = `${prefix}${version}-`;
  if (fs.existsSync(outputDir)) {
    const entries = fs.readdirSync(outputDir, { withFileTypes: true });
    const hasCurrentDmg = entries.some(entry => entry.isFile() && entry.name.startsWith(currentPrefix) && entry.name.endsWith('.dmg'));
    if (hasCurrentDmg) {
      for (const entry of entries) {
        const generatedArchive = entry.name.startsWith(prefix) && /(?:\.dmg(?:\.blockmap)?|-mac\.zip(?:\.blockmap)?)$/.test(entry.name);
        const currentDmg = entry.name.startsWith(currentPrefix) && entry.name.endsWith('.dmg');
        if (entry.isFile() && generatedArchive && !currentDmg) {
          try { fs.unlinkSync(path.join(outputDir, entry.name)); } catch { /* ignore */ }
        }
      }
    }
  }
}

if (result.status === 0 && buildingWindows) {
  const outputDir = path.resolve(__dirname, pkg.build?.directories?.output || 'dist_electron');
  const prefix = `${pkg.build?.productName || pkg.name} Setup `;
  const currentInstaller = `${prefix}${version}.exe`;
  if (fs.existsSync(path.join(outputDir, currentInstaller))) {
    for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.exe') && entry.name !== currentInstaller) {
        try { fs.unlinkSync(path.join(outputDir, entry.name)); } catch { /* ignore */ }
      }
    }
  }
}

process.exit(result.status ?? 1);
