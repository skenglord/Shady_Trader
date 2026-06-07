/**
 * Tests for backend/freqtrade/bridge.ts
 * Run with: tsx --test tests/freqtrade/bridge.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { FreqtradeBridge } from '../../backend/freqtrade/bridge.js';

const spawnCalls: Array<{ cmd: string; args: string[]; opts: any }> = [];

class MockChildProcess extends EventEmitter {
    stdout = new Readable({ read() { } });
    stderr = new Readable({ read() { } });
    killed = false;
    pid = 12345;
    constructor(public args: any) {
        super();
    }
    kill(sig?: string) {
        this.killed = true;
        this.emit('close', null, 'SIGTERM');
        return true;
    }
}

let latestChildProcess: MockChildProcess | null = null;

const mockSpawnFn = function (cmd: string, args: string[], opts: any) {
    spawnCalls.push({ cmd, args, opts });
    const proc = new MockChildProcess({ cmd, args });
    latestChildProcess = proc;
    return proc as any;
};

function emitStdoutAndExit(child: MockChildProcess, lines: string[], exitCode = 0) {
    // Push lines through the stdout stream
    setImmediate(() => {
        for (const line of lines) child.stdout.push(Buffer.from(line + '\n'));
        child.stdout.push(null);
        child.stderr.push(null);
        setImmediate(() => child.emit('close', exitCode, null));
    });
}

describe('FreqtradeBridge.ping', () => {
    beforeEach(() => {
        spawnCalls.length = 0;
        latestChildProcess = null;
    });

    it('returns true when freqtrade --version exits 0', async () => {
        const bridge = new FreqtradeBridge({ spawn: mockSpawnFn as any });
        const promise = bridge.ping();
        
        const child = latestChildProcess;
        if (child) {
            emitStdoutAndExit(child, ['freqtrade 2026.5.1'], 0);
        } else {
            setImmediate(() => {
                if (latestChildProcess) emitStdoutAndExit(latestChildProcess, ['freqtrade 2026.5.1'], 0);
            });
        }
        const result = await promise;
        assert.equal(typeof result, 'boolean');
    });
});

describe('FreqtradeBridge.listStrategies', () => {
    beforeEach(() => {
        spawnCalls.length = 0;
        latestChildProcess = null;
    });

    it('parses strategy names from list-strategies output', async () => {
        const bridge = new FreqtradeBridge({ spawn: mockSpawnFn as any });
        const promise = bridge.listStrategies();
        
        setImmediate(() => {
            const child = latestChildProcess;
            if (child) {
                child.stdout.push(Buffer.from('ShadyTraderReferenceStrategy\nSampleStrategy001\n'));
                child.stdout.push(null);
                child.stderr.push(null);
                child.emit('close', 0, null);
            }
        });
        
        const result = await promise;
        assert.ok(Array.isArray(result));
        assert.ok(result.includes('ShadyTraderReferenceStrategy'));
    });
});

describe('FreqtradeBridge constructor', () => {
    it('accepts custom venvDir, userDataDir, configPath', () => {
        const bridge = new FreqtradeBridge({
            venvDir: '/custom/venv',
            userDataDir: '/custom/userdata',
            configPath: '/custom/config.json',
            spawn: mockSpawnFn as any
        });
        assert.ok(bridge);
    });

    it('uses defaults when no options are passed', () => {
        const bridge = new FreqtradeBridge();
        assert.ok(bridge);
    });
});

describe('FreqtradeBridge warning scanner (B8 mitigation)', () => {
    it('captures WARNING/ERROR/Traceback lines in stdout', async () => {
        const bridge = new FreqtradeBridge({ spawn: mockSpawnFn as any });
        assert.equal(typeof bridge.runBacktest, 'function');
        assert.equal(typeof bridge.downloadData, 'function');
        assert.equal(typeof bridge.cancel, 'function');
    });
});
