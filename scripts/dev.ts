/**
 * Development process manager that ONLY touches processes it started.
 *
 *   npx tsx scripts/dev.ts start [api] [worker] [web]   (default: all three)
 *   npx tsx scripts/dev.ts status
 *   npx tsx scripts/dev.ts stop
 *
 * PIDs are recorded in .data/dev-pids.json. `stop` terminates exactly those
 * process trees (Windows: taskkill /PID <pid> /T /F; POSIX: signal to the
 * recorded process group). It NEVER kills by image name - `taskkill /IM
 * node.exe` would terminate unrelated Node processes on the machine.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, '.data');
const PIDS = join(DATA, 'dev-pids.json');
const isWin = process.platform === 'win32';

type Svc = 'api' | 'worker' | 'web';
const COMMANDS: Record<Svc, { cmd: string; args: string[]; cwd: string }> = {
  api: { cmd: 'npx', args: ['tsx', 'src/main.ts'], cwd: ROOT },
  worker: { cmd: 'npx', args: ['tsx', 'src/worker.ts'], cwd: ROOT },
  web: { cmd: 'npm', args: ['run', 'dev'], cwd: join(ROOT, 'apps', 'web') },
};

function readPids(): Record<string, { pid: number; startedAt: string; log: string }> {
  return existsSync(PIDS) ? JSON.parse(readFileSync(PIDS, 'utf8')) : {};
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function start(services: Svc[]): void {
  mkdirSync(DATA, { recursive: true });
  const pids = readPids();
  for (const s of services) {
    if (pids[s] && alive(pids[s].pid)) { console.log(`${s}: already running (pid ${pids[s].pid})`); continue; }
    const log = join(DATA, `${s}.log`);
    const fd = openSync(log, 'a');
    const c = COMMANDS[s];
    const child = spawn(isWin ? `${c.cmd}.cmd` : c.cmd, c.args, { cwd: c.cwd, stdio: ['ignore', fd, fd], detached: !isWin, shell: isWin, windowsHide: true });
    child.unref();
    pids[s] = { pid: child.pid!, startedAt: new Date().toISOString(), log };
    console.log(`${s}: started pid ${child.pid} (log ${log})`);
  }
  writeFileSync(PIDS, JSON.stringify(pids, null, 2));
}

function stop(): void {
  const pids = readPids();
  for (const [s, p] of Object.entries(pids)) {
    if (!alive(p.pid)) { console.log(`${s}: not running`); continue; }
    try {
      if (isWin) execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-p.pid, 'SIGTERM'); // the recorded process group only (graceful: worker releases leases)
      console.log(`${s}: stopped pid ${p.pid}`);
    } catch (err) {
      console.error(`${s}: could not stop pid ${p.pid}: ${(err as Error).message}`);
    }
  }
  writeFileSync(PIDS, '{}');
}

function status(): void {
  const pids = readPids();
  if (!Object.keys(pids).length) console.log('no processes recorded');
  for (const [s, p] of Object.entries(pids)) console.log(`${s}: pid ${p.pid} ${alive(p.pid) ? 'running' : 'NOT running'} since ${p.startedAt}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const services = (rest.length ? rest : ['api', 'worker', 'web']) as Svc[];
if (cmd === 'start') start(services);
else if (cmd === 'stop') stop();
else status();
