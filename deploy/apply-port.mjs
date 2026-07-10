// apply-port.mjs — cross-platform (Windows/Mac/Linux) version of apply-port.sh.
// No bash or `patch` needed; uses Node + `git apply` (git ships on every dev box).
//
//   node deploy/apply-port.mjs C:\path\to\storesdb --seed
//   node deploy/apply-port.mjs /path/to/storesdb --seed
//
// Applies the UMMS security port to a COPY of your storesdb app (drops in auth/,
// applies server.js.patch, installs deps, optionally seeds the first users).
import { execSync } from 'node:child_process';
import { readdirSync, copyFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PORT_DIR = join(REPO, 'reference', 'storesdb-auth-port');

const appDir = process.argv[2];
const doSeed = process.argv.includes('--seed');
if (!appDir) { console.error('usage: node deploy/apply-port.mjs <app_dir> [--seed]'); process.exit(2); }
if (!existsSync(join(appDir, 'server.js'))) { console.error(`error: ${appDir}/server.js not found`); process.exit(2); }

const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

console.log(`==> Applying UMMS port to: ${appDir}`);

// 1) Drop in auth module + login page + seeder.
mkdirSync(join(appDir, 'auth'), { recursive: true });
for (const f of readdirSync(join(PORT_DIR, 'auth')).filter((f) => f.endsWith('.js'))) {
  copyFileSync(join(PORT_DIR, 'auth', f), join(appDir, 'auth', f));
}
for (const f of ['seed-users.js', 'login.html']) copyFileSync(join(PORT_DIR, f), join(appDir, f));
console.log('    auth/, seed-users.js, login.html copied.');

// 2) Apply the server.js patch (idempotent).
if (readFileSync(join(appDir, 'server.js'), 'utf8').includes("require('./auth/siteGuard')")) {
  console.log('    server.js already ported — skipping patch.');
} else {
  try {
    run(`git apply -p0 --unsafe-paths "${join(PORT_DIR, 'server.js.patch')}"`, appDir);
    console.log('    server.js patched.');
  } catch {
    console.error('!! git apply failed — your server.js differs from the baseline.');
    console.error(`   Apply the edits from ${join(PORT_DIR, 'server.js.patch')} by hand, then re-run.`);
    process.exit(1);
  }
}

// 3) Runtime deps.
console.log('==> Installing runtime dependencies (cookie-parser, express-rate-limit)');
run('npm install --save cookie-parser express-rate-limit', appDir);

// 4) Optional seed.
if (doSeed) {
  console.log('==> Seeding roles/permissions/users (change the passwords immediately!)');
  run('node seed-users.js', appDir);
}

console.log('==> Done. Run it locally with:  cd ' + appDir + ' && node server.js   (then open http://localhost:5000)');
