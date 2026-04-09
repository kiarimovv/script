/*
 * 歪麦霸王餐 - Egern 兼容包装层
 * 原作者：Sliverkiss | Egern 适配包装
 *
 * 原脚本使用 Surge/QX/Loon 专有 API（$httpClient/$persistentStore/$notification）
 * 本包装层注入 Surge 兼容全局对象，使原脚本可在 Egern 的 ctx 上运行。
 *
 * [egern - http_request]
 *   match: ^https://wmapp-api\.waimaimingtang\.com/api/api/v2/user/api_user_info_one
 *   body_required: false
 *   触发：打开 App → 进入「我的」页面（自动抓取凭证并执行任务）
 *
 * [egern - schedule]（可选：配合环境变量定时执行）
 *   cron: "0 8 * * *"
 *   env:
 *     wmbwc_data: '[{"userId":"xxx","token":"xxx","userName":"备注"}]'
 *
 * [MITM]
 *   hostname: wmapp-api.waimaimingtang.com
 */

const SCRIPT_NAME       = '歪麦霸王餐';
const ENV_VAR_NAME      = 'wmbwc_data';
const ORIGINAL_SCRIPT   = 'https://gist.githubusercontent.com/Sliverkiss/49a9ffb2169a2becc33bf4fdbf6eb99a/raw/wmbwc.js';

function normalizeHeaders(headers) {
    return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [String(key).toLowerCase(), value]));
}

function parseBodyObject(body) {
    if (!body || typeof body !== 'string') {
        return {};
    }

    try {
        const parsed = JSON.parse(body);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        const params = new URLSearchParams(body);
        const entries = Object.fromEntries(params.entries());
        return entries && typeof entries === 'object' ? entries : {};
    }
}

function pickFirstString(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return '';
}

function parseBearerToken(value) {
    if (typeof value !== 'string') {
        return '';
    }
    return value.replace(/^Bearer\s+/i, '').trim();
}

function isPlaceholderValue(value) {
    if (typeof value !== 'string') {
        return false;
    }
    return value.includes('填入') || value === '备注';
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
            const { userId, token, userName } = account;
            if (!userId || !token) {
                return false;
            }
            return ![userId, token, userName].some(isPlaceholderValue);
        });

        if (validAccounts.length !== accounts.length) {
            ctx.storage.set(ENV_VAR_NAME, JSON.stringify(validAccounts));
        }
    } catch {
        // 保持原始数据，交由原脚本继续处理
    }
}

function loadStoredAccounts(ctx) {
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

function saveStoredAccounts(ctx, accounts) {
    ctx.storage.set(ENV_VAR_NAME, JSON.stringify(accounts));
}

function extractAccountFromRequest({ headers = {}, body = '' }) {
    const normalizedHeaders = normalizeHeaders(headers);
    const parsedBody = parseBodyObject(body);

    const token = pickFirstString(
        parseBearerToken(normalizedHeaders.authorization),
        normalizedHeaders.token,
        normalizedHeaders['x-token'],
        normalizedHeaders['access-token'],
        parsedBody.token,
        parsedBody.accessToken,
    );

    const userId = pickFirstString(
        normalizedHeaders['x-user-id'],
        normalizedHeaders.userid,
        normalizedHeaders['user-id'],
        parsedBody.userId,
        parsedBody.user_id,
        parsedBody.uid,
        parsedBody.id,
    );

    const userName = pickFirstString(
        parsedBody.userName,
        parsedBody.username,
        parsedBody.nickName,
        parsedBody.nickname,
        normalizedHeaders['x-user-name'],
        userId,
    );

    if (!userId || !token) {
        return null;
    }

    return { userId, token, userName };
}

function upsertAccount(ctx, account) {
    const accounts = loadStoredAccounts(ctx);
    const index = accounts.findIndex((item) => item?.userId === account.userId);
    if (index >= 0) {
        accounts[index] = { ...accounts[index], ...account };
    } else {
        accounts.push(account);
    }
    saveStoredAccounts(ctx, accounts);
}

/**
 * Egern Headers 只支持 get()/has() 等方法，不支持 forEach/entries()
 * 但支持 bracket 访问（headers['key']），因此 Object.entries() 可以枚举所有 header
 */
function hdrsToObj(h) {
    try { return Object.fromEntries(Object.entries(h)); } catch { return {}; }
}

export default async function (ctx) {
    sanitizeStoredAccounts(ctx);

    // ── 1. 将 Egern 环境变量预写入持久化存储（供原脚本读取）──
    const envVal = ctx.env?.[ENV_VAR_NAME];
    if (envVal) {
        ctx.storage.set(ENV_VAR_NAME, envVal);
    }

    // ── 2. http_request 初始化阶段直接抓取账号，避免原始脚本拦截时报错 ──
    if (ctx.request && !ctx.response) {
        const body = typeof ctx.request.text === 'function'
            ? await ctx.request.text().catch(() => '')
            : '';
        const account = extractAccountFromRequest({
            headers: hdrsToObj(ctx.request.headers),
            body,
        });

        if (account) {
            upsertAccount(ctx, account);
            ctx.notify({
                title: SCRIPT_NAME,
                body: `已更新账号：${account.userName || account.userId}`,
            });
        } else {
            ctx.notify({
                title: SCRIPT_NAME,
                body: '未能从本次请求中提取 userId/token，请反馈抓包请求头与请求体。',
            });
        }
        return;
    }

    // ── 3. 注入 Surge 全局对象 ───────────────────────────────

    // 让 Env.getEnv() 识别为 Surge，走 Surge 的 API 分支
    globalThis.$environment = { 'surge-version': '1000' };

    // 持久化存储（$persistentStore）
    globalThis.$persistentStore = {
        read:  (key)        => ctx.storage.get(key),
        write: (value, key) => { ctx.storage.set(key, value); return true; },
    };

    // 系统通知（$notification）
    globalThis.$notification = {
        post: (title, subtitle, body) => ctx.notify({
            title:    String(title    ?? SCRIPT_NAME),
            subtitle: String(subtitle ?? ''),
            body:     String(body     ?? ''),
        }),
    };

    // HTTP 客户端（$httpClient）— callback 风格，内部用 ctx.http Promise 适配
    const makeMethod = (method) => (opts, callback) => {
        if (typeof opts === 'string') opts = { url: opts };
        const { url, headers = {}, body, timeout } = opts;
        const httpOpts = {
            headers,
            timeout: timeout ? (timeout < 1000 ? timeout * 1000 : timeout) : 30000,
        };
        if (body) httpOpts.body = body;

        ctx.http[method](url, httpOpts)
            .then(async (resp) => {
                const text = await resp.text();
                const hdrs = {};
                Object.assign(hdrs, hdrsToObj(resp.headers));
                callback(null,
                    { status: resp.status, statusCode: resp.status, headers: hdrs, body: text },
                    text);
            })
            .catch(err => callback(String(err)));
    };
    globalThis.$httpClient = {
        get:    makeMethod('get'),
        post:   makeMethod('post'),
        put:    makeMethod('put'),
        delete: makeMethod('delete'),
        head:   makeMethod('head'),
        patch:  makeMethod('patch'),
    };

    // ── 4. 注入请求上下文（schedule 内部请求时也可能使用） ────
    if (ctx.request) {
        // body_required: false 时 ctx.request.text 可能不存在
        const body = typeof ctx.request.text === 'function'
            ? await ctx.request.text().catch(() => '')
            : '';
        globalThis.$request = {
            url:     ctx.request.url,
            method:  ctx.request.method,
            headers: hdrsToObj(ctx.request.headers),
            body,
        };
    }
    // 注意：http_request 模式下不存在 $response

    // ── 5. 动态加载原始脚本并在 Surge 兼容环境中执行 ────────
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

        // $done() 拦截：脚本完成时放行
        globalThis.$done = () => finish();
        // 安全超时（55 秒），防止脚本卡住
        const timer = setTimeout(() => finish(), 55000);

        ctx.http.get(ORIGINAL_SCRIPT)
            .then(r => r.text())
            .then(code => {
                try {
                    // eval 在 globalThis 所在作用域执行，$persistentStore 等全局可见
                    // eslint-disable-next-line no-eval
                    eval(code);
                } catch (e) {
                    ctx.notify({ title: SCRIPT_NAME, body: `脚本执行错误: ${e.message}` });
                    finish();
                }
            })
            .catch(e => {
                ctx.notify({ title: SCRIPT_NAME, body: `脚本加载失败: ${e.message}` });
                finish();
            });
    });

    // http_request 模式：返回 undefined = 放行原始请求（不修改）
}

export const __test__ = {
    extractAccountFromRequest,
};
