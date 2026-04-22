#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const supportedTargets = new Set([
  'auto',
  'android',
  'ios',
  'windows',
  'macos',
  'ubuntu',
  'arch',
  'fedora',
  'linux'
]);

function parseArgs(argv) {
  const args = { target: 'auto', mode: 'dev', skipInstall: false };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--target' && argv[i + 1]) {
      args.target = argv[i + 1].toLowerCase();
      i += 1;
    } else if (token === '--mode' && argv[i + 1]) {
      args.mode = argv[i + 1].toLowerCase();
      i += 1;
    } else if (token === '--skip-install') {
      args.skipInstall = true;
    } else if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  if (!supportedTargets.has(args.target)) {
    throw new Error(`Unsupported --target "${args.target}".`);
  }

  if (!['dev', 'start'].includes(args.mode)) {
    throw new Error('Unsupported --mode. Use "dev" or "start".');
  }

  return args;
}

function printHelp() {
  console.log(`\nCross-platform bot launcher\n\nUsage:\n  npm run bot:launch -- [--target <target>] [--mode <dev|start>] [--skip-install]\n\nTargets:\n  auto (default), android, ios, windows, macos, ubuntu, arch, fedora, linux\n\nExamples:\n  npm run bot:launch\n  npm run bot:launch -- --target windows --mode start\n  npm run bot:launch -- --target android --skip-install\n`);
}

function readLinuxDistro() {
  try {
    const content = fs.readFileSync('/etc/os-release', 'utf8');
    const idLine = content.split('\n').find((line) => line.startsWith('ID='));
    return idLine ? idLine.replace('ID=', '').replaceAll('"', '').trim().toLowerCase() : '';
  } catch {
    return '';
  }
}

function resolveTarget(requestedTarget) {
  if (requestedTarget !== 'auto') return requestedTarget;

  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') {
    if (process.env.ANDROID_ROOT || process.env.TERMUX_VERSION) return 'android';
    const distro = readLinuxDistro();
    if (distro.includes('ubuntu')) return 'ubuntu';
    if (distro.includes('arch')) return 'arch';
    if (distro.includes('fedora')) return 'fedora';
    return 'linux';
  }

  return 'linux';
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = resolveTarget(options.target);
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  const hostHint = ['android', 'ios'].includes(target) ? ' --host 0.0.0.0' : '';

  console.log(`[launcher] target=${target} mode=${options.mode} skipInstall=${options.skipInstall}`);

  if (target === 'ios') {
    console.log('[launcher] iOS support assumes a shell runtime like iSH or a-Shell with Node.js installed.');
  }

  if (!options.skipInstall) {
    await run(npmCmd, ['install']);
  }

  if (options.mode === 'start') {
    await run(npmCmd, ['run', 'start']);
    return;
  }

  if (hostHint) {
    process.env.VITE_HOST = '0.0.0.0';
  }

  await run(npmCmd, ['run', 'dev', '--', ...hostHint.trim().split(' ').filter(Boolean)]);
}

main().catch((error) => {
  console.error(`[launcher] ${error.message}`);
  process.exit(1);
});
