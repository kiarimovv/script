import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../wmbwc.js', import.meta.url), 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const module = await import(moduleUrl);

assert.equal(typeof module.__test__?.extractAccountFromRequest, 'function', '缺少 extractAccountFromRequest 测试导出');

const account = module.__test__.extractAccountFromRequest({
    headers: {
        authorization: 'Bearer token-123',
        'x-user-id': 'user-001',
    },
    body: '{"userName":"Kiarimo"}',
});

assert.deepEqual(account, {
    userId: 'user-001',
    token: 'token-123',
    userName: 'Kiarimo',
});

console.log('PASS wmbwc-extract-account');
