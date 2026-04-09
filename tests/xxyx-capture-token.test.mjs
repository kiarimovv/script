import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../xxyx.js', import.meta.url), 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const module = await import(moduleUrl);

assert.equal(typeof module.__test__?.extractTokenFromHeaders, 'function', '缺少 extractTokenFromHeaders 测试导出');

assert.equal(module.__test__.extractTokenFromHeaders({ 'xx-token': 'token-123' }), 'token-123');
assert.equal(module.__test__.extractTokenFromHeaders({ 'XX-TOKEN': 'token-456' }), 'token-456');
assert.equal(module.__test__.extractTokenFromHeaders({}), '');

console.log('PASS xxyx-capture-token');
