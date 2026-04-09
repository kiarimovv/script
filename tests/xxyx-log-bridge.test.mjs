import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../xxyx.js', import.meta.url), 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const module = await import(moduleUrl);

assert.equal(typeof module.__test__?.createLoggerBridge, 'function', '缺少 createLoggerBridge 测试导出');

const messages = [];
const logger = module.__test__.createLoggerBridge('晓晓优选', (...args) => {
    messages.push(args.join(' '));
});

logger.log('hello', 'world');
logger.error('boom');

assert.equal(messages.length, 2);
assert.equal(messages[0], '[晓晓优选] hello world');
assert.equal(messages[1], '[晓晓优选] boom');

console.log('PASS xxyx-log-bridge');
