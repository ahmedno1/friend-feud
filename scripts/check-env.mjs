import { execSync } from 'node:child_process';

const major = Number(process.versions.node.split('.')[0]);
const run = (cmd) => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

const checks = [
  ['Node.js >= 22', major >= 22, process.version],
  ['npm', run('npm --version'), run('npm --version')],
  ['Git', run('git --version'), run('git --version')],
];

let failed = false;
for (const [name, ok, info] of checks) {
  if (!ok) failed = true;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`);
}
process.exit(failed ? 1 : 0);
