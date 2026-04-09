import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../xcbwc.js', import.meta.url), 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const module = await import(moduleUrl);

assert.equal(typeof module.__test__?.extractAccountFromHeaders, 'function', '缺少 extractAccountFromHeaders 测试导出');
assert.equal(typeof module.__test__?.createLoggerBridge, 'function', '缺少 createLoggerBridge 测试导出');

const logMessages = [];
const logger = module.__test__.createLoggerBridge('小蚕霸王餐', (...args) => {
    logMessages.push(args.join(' '));
});
logger.error('boom');
assert.equal(logMessages[0], '[小蚕霸王餐] boom');

const account = module.__test__.extractAccountFromHeaders({
    'x-vayne': 'uid-001',
    'x-teemo': 'teemo-abc',
    'x-sivir': 'token-xyz',
    'x-user-name': 'Kiarimo',
});

assert.deepEqual(account, {
    userId: 'uid-001',
    teemo: 'teemo-abc',
    token: 'token-xyz',
    userName: 'Kiarimo',
});

console.log('PASS xcbwc-extract-account');
