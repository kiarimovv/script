/*
 * 晓晓优选 - Egern 兼容包装层
 * 原作者：Sliverkiss | Egern 适配包装
 *
 * 说明：
 * 1. 初始化阶段由包装层自行抓取 xx-token 并补全账号
 * 2. 定时阶段调用原始上游脚本，自动继承原版任务更新
 */

const SCRIPT_NAME = '晓晓优选';
const STORAGE_KEY = 'xxyx_data';
const TEMP_TOKEN_KEY = 'xxyx_temp_token';
const BASE_URL = 'https://xxyx-client-api.xiaoxiaoyouxuan.com';
const ORIGINAL_SCRIPT = 'https://gist.githubusercontent.com/Sliverkiss/991a81be1fc8cf2a1937432be68f5521/raw/xxyx.js';
const UPSTREAM_TIMEOUT_MS = 175000;

function normalizeHeaders(headers) {
    return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [String(key).toLowerCase(), value]));
}

function extractTokenFromHeaders(headers) {
    const normalizedHeaders = normalizeHeaders(headers);
    const token = normalizedHeaders['xx-token'];
    return typeof token === 'string' ? token.trim() : '';
}

function loadAccounts(ctx) {
    const raw = ctx.env?.[STORAGE_KEY] || ctx.storage.get(STORAGE_KEY);
    if (!raw) {
        return [];
    }

    try {
        const accounts = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(accounts) ? accounts : [];
    } catch {
        return [];
    }
}

function saveAccounts(ctx, accounts) {
    ctx.storage.set(STORAGE_KEY, JSON.stringify(accounts));
}

function upsertAccount(ctx, account) {
    const accounts = loadAccounts(ctx);
    const index = accounts.findIndex((item) => item?.userId === account.userId);
    if (index >= 0) {
        accounts[index] = { ...accounts[index], ...account };
    } else {
        accounts.push(account);
    }
    saveAccounts(ctx, accounts);
}

function hdrsToObj(headers) {
    try {
        return Object.fromEntries(Object.entries(headers));
    } catch {
        return {};
    }
}

async function api(ctx, token, path, method = 'GET', body = null) {
    const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
    const options = {
        headers: {
            'xx-platform': 'ios',
            Host: 'xxyx-client-api.xiaoxiaoyouxuan.com',
            'User-Agent': 'XiaoXiaoYouXuan/20127 CFNetwork/1331.0.7 Darwin/21.4.0',
            'xx-version': '30221',
            'xx-token': token,
            'content-type': 'application/json;charset=utf-8',
        },
        timeout: 30000,
    };
    if (body) {
        options.body = JSON.stringify(body);
    }
    const httpMethod = method === 'POST' ? ctx.http.post : ctx.http.get;
    const response = await httpMethod.call(ctx.http, url, options);
    return response.json();
}

function installBridge(ctx) {
    globalThis.$environment = { 'surge-version': '1000' };
    globalThis.$persistentStore = {
        read: (key) => ctx.storage.get(key),
        write: (value, key) => {
            ctx.storage.set(key, value);
            return true;
        },
    };
    globalThis.$notification = {
        post: (title, subtitle, body) => ctx.notify({
            title: String(title ?? SCRIPT_NAME),
            subtitle: String(subtitle ?? ''),
            body: String(body ?? ''),
        }),
    };

    const makeMethod = (method) => (options, callback) => {
        const requestOptions = typeof options === 'string' ? { url: options } : options;
        const { url, headers = {}, body, timeout } = requestOptions;
        const httpOptions = {
            headers,
            timeout: timeout ? (timeout < 1000 ? timeout * 1000 : timeout) : 30000,
        };
        if (body) {
            httpOptions.body = body;
        }

        ctx.http[method](url, httpOptions)
            .then(async (response) => {
                const text = await response.text();
                callback(null, {
                    status: response.status,
                    statusCode: response.status,
                    headers: hdrsToObj(response.headers),
                    body: text,
                }, text);
            })
            .catch((error) => callback(String(error)));
    };

    globalThis.$httpClient = {
        get: makeMethod('get'),
        post: makeMethod('post'),
        put: makeMethod('put'),
        delete: makeMethod('delete'),
        head: makeMethod('head'),
        patch: makeMethod('patch'),
    };
}

async function materializeTempAccount(ctx) {
    const tempToken = ctx.storage.get(TEMP_TOKEN_KEY);
    if (!tempToken) {
        return;
    }

    ctx.storage.set(TEMP_TOKEN_KEY, '');
    try {
        const response = await api(ctx, tempToken, '/my?platform=ios');
        const userInfo = response?.data;
        if (!userInfo?.mobile) {
            ctx.notify({ title: SCRIPT_NAME, body: 'Token 无效或已过期，请重新打开 App 进入“我的”页面。' });
            return;
        }

        upsertAccount(ctx, {
            userId: userInfo.identityId || userInfo.mobile,
            token: tempToken,
            userName: userInfo.mobile,
        });
    } catch (error) {
        ctx.notify({ title: SCRIPT_NAME, body: `账号补全失败：${error.message}` });
    }
}

async function runUpstreamScript(ctx) {
    await new Promise((resolve) => {
        let isFinished = false;
        const finish = () => {
            if (isFinished) {
                return;
            }
            isFinished = true;
            clearTimeout(timer);
            resolve();
        };

        globalThis.$done = () => finish();
        const timer = setTimeout(() => finish(), UPSTREAM_TIMEOUT_MS);

        ctx.http.get(ORIGINAL_SCRIPT)
            .then((response) => response.text())
            .then((code) => {
                try {
                    // eslint-disable-next-line no-eval
                    eval(code);
                } catch (error) {
                    ctx.notify({ title: SCRIPT_NAME, body: `脚本执行错误: ${error.message}` });
                    finish();
                }
            })
            .catch((error) => {
                ctx.notify({ title: SCRIPT_NAME, body: `脚本加载失败: ${error.message}` });
                finish();
            });
    });
}

export default async function (ctx) {
    if (ctx.env?.[STORAGE_KEY]) {
        ctx.storage.set(STORAGE_KEY, ctx.env[STORAGE_KEY]);
    }

    if (ctx.request && !ctx.response) {
        const token = extractTokenFromHeaders(hdrsToObj(ctx.request.headers));
        if (token) {
            ctx.storage.set(TEMP_TOKEN_KEY, token);
            ctx.notify({ title: SCRIPT_NAME, body: 'Token 已捕获，下次定时任务将自动补全账号并执行。' });
        }
        return;
    }

    await materializeTempAccount(ctx);
    installBridge(ctx);
    await runUpstreamScript(ctx);
}

export const __test__ = {
    extractTokenFromHeaders,
};
