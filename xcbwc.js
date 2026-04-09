/*
 * 小蚕霸王餐 - Egern 兼容包装层
 * 原作者：Sliverkiss | Egern 适配包装
 *
 * 说明：
 * 1. 初始化阶段由包装层从请求头抓取账号凭证，不再重组响应体
 * 2. 定时阶段调用原始上游脚本，自动继承原版任务更新
 */

const SCRIPT_NAME = '小蚕霸王餐';
const ENV_VAR_NAME = 'xcbwc_data';
const ORIGINAL_SCRIPT = 'https://gist.githubusercontent.com/Sliverkiss/250a02315f0a2c99f42da3b3573375c8/raw/xcbwc.js';
const UPSTREAM_TIMEOUT_MS = 175000;

function createLoggerBridge(name, sink = console.log) {
    const write = (...args) => {
        sink(`[${name}]`, ...args.map((item) => String(item)));
    };
    return {
        log: (...args) => write(...args),
        error: (...args) => write(...args),
    };
}

function normalizeHeaders(headers) {
    return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [String(key).toLowerCase(), value]));
}

function isPlaceholderValue(value) {
    if (typeof value !== 'string') {
        return false;
    }
    return value.includes('填入') || value.includes('x-vayne值') || value.includes('x-teemo值')
        || value.includes('x-sivir值') || value === '备注';
}

function sanitizeStoredAccounts(ctx) {
    const raw = ctx.storage.get(ENV_VAR_NAME);
    if (!raw) {
        return;
    }

    try {
        const accounts = JSON.parse(raw);
        if (!Array.isArray(accounts)) {
            return;
        }

        const validAccounts = accounts.filter((account) => {
            if (!account || typeof account !== 'object') {
                return false;
            }
            const { userId, teemo, token, userName } = account;
            if (!userId || !teemo || !token) {
                return false;
            }
            return ![userId, teemo, token, userName].some(isPlaceholderValue);
        });

        if (validAccounts.length !== accounts.length) {
            ctx.storage.set(ENV_VAR_NAME, JSON.stringify(validAccounts));
        }
    } catch {
        // 保持原始数据，交由上游脚本继续处理
    }
}

function loadAccounts(ctx) {
    const raw = ctx.storage.get(ENV_VAR_NAME);
    if (!raw) {
        return [];
    }

    try {
        const accounts = JSON.parse(raw);
        return Array.isArray(accounts) ? accounts : [];
    } catch {
        return [];
    }
}

function saveAccounts(ctx, accounts) {
    ctx.storage.set(ENV_VAR_NAME, JSON.stringify(accounts));
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

function extractAccountFromHeaders(headers) {
    const normalizedHeaders = normalizeHeaders(headers);
    const userId = normalizedHeaders['x-vayne'];
    const teemo = normalizedHeaders['x-teemo'];
    const token = normalizedHeaders['x-sivir'];
    const userName = normalizedHeaders['x-user-name'] || normalizedHeaders['x-nickname'] || userId;

    if (![userId, teemo, token].every((item) => typeof item === 'string' && item.trim())) {
        return null;
    }

    return {
        userId: userId.trim(),
        teemo: teemo.trim(),
        token: token.trim(),
        userName: typeof userName === 'string' ? userName.trim() : userId.trim(),
    };
}

function hdrsToObj(headers) {
    try {
        return Object.fromEntries(Object.entries(headers));
    } catch {
        return {};
    }
}

function installBridge(ctx) {
    const logger = createLoggerBridge(SCRIPT_NAME);
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
    globalThis.console = {
        ...console,
        log: (...args) => logger.log(...args),
        error: (...args) => logger.error(...args),
        warn: (...args) => logger.log(...args),
        info: (...args) => logger.log(...args),
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
    sanitizeStoredAccounts(ctx);

    if (ctx.env?.[ENV_VAR_NAME]) {
        ctx.storage.set(ENV_VAR_NAME, ctx.env[ENV_VAR_NAME]);
    }

    if (ctx.request && !ctx.response) {
        const account = extractAccountFromHeaders(hdrsToObj(ctx.request.headers));
        if (account) {
            upsertAccount(ctx, account);
            ctx.notify({ title: SCRIPT_NAME, body: `已更新账号：${account.userName || account.userId}` });
        } else {
            ctx.notify({ title: SCRIPT_NAME, body: '未能从请求头提取账号凭证，请反馈抓包日志。' });
        }
        return;
    }

    installBridge(ctx);
    await runUpstreamScript(ctx);
}

export const __test__ = {
    createLoggerBridge,
    extractAccountFromHeaders,
};
