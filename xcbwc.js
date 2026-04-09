/*
 * 小蚕霸王餐 - Egern 兼容包装层
 * 原作者：Sliverkiss | Egern 适配包装
 *
 * 原脚本使用 Surge/QX/Loon 专有 API（$httpClient/$persistentStore/$notification）
 * 本包装层注入 Surge 兼容全局对象，使原脚本可在 Egern 的 ctx 上运行。
 *
 * [egern - http_response]
 *   match: ^https://gw\.xiaocantech\.com/rpc
 *   body_required: true
 *   触发：打开 App，脚本从响应中自动捕获凭证后及时关闭 App
 *
 * [egern - schedule]（可选：配合环境变量定时执行）
 *   cron: "0 9 * * *"
 *   env:
 *     xcbwc_data: '[{"userId":"x-vayne值","teemo":"x-teemo值","token":"x-sivir值","userName":"备注"}]'
 *
 * 凭证字段说明（对应 App 请求头）：
 *   userId → x-vayne 头
 *   teemo  → x-teemo 头
 *   token  → x-sivir 头
 *
 * [MITM]
 *   hostname: gw.xiaocantech.com
 */

const SCRIPT_NAME       = '小蚕霸王餐';
const ENV_VAR_NAME      = 'xcbwc_data';
const ORIGINAL_SCRIPT   = 'https://gist.githubusercontent.com/Sliverkiss/250a02315f0a2c99f42da3b3573375c8/raw/xcbwc.js';
const UPSTREAM_TIMEOUT_MS = 175000;

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
        // 保持原始数据，交由原脚本继续处理
    }
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

    // ── 2. 注入 Surge 全局对象 ───────────────────────────────

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

    // ── 3. 注入响应上下文（http_response 触发时）────────────
    let originalResponseBody = '';
    if (ctx.request) {
        // 请求 body 只在 body_required: true 时可用，否则跳过
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
    if (ctx.response) {
        originalResponseBody = await ctx.response.text().catch(() => '');
        globalThis.$response = {
            status:  ctx.response.status,
            headers: hdrsToObj(ctx.response.headers),
            body:    originalResponseBody,
        };
    }

    // ── 4. 动态加载原始脚本并在 Surge 兼容环境中执行 ────────
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
        const timer = setTimeout(() => finish(), UPSTREAM_TIMEOUT_MS);

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

    // http_response 模式：透传原始响应体（不修改 App 的响应）
    if (ctx.response) {
        return {
            status:  ctx.response.status,
            headers: hdrsToObj(ctx.response.headers),
            body:    originalResponseBody,
        };
    }
}
