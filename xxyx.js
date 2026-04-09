/*
 * 晓晓优选 - Egern 适配版
 * 原作者：Sliverkiss | Egern 适配改写
 *
 * [egern - http_response]
 *   match: ^https://xxyx-client-api\.xiaoxiaoyouxuan\.com/my
 *   body_required: true
 *   触发：打开 App → 进入「我的」页面，自动抓取并保存 Token
 *
 * [egern - schedule]
 *   cron: "0 8 * * *"
 *   env:
 *     xxyx_data: '[{"userId":"xxx","token":"xxx","userName":"手机号"}]'
 *   触发：定时执行签到和任务
 *
 * [MITM]
 *   hostname: xxyx-client-api.xiaoxiaoyouxuan.com
 */

const SCRIPT_NAME = '晓晓优选';
const STORAGE_KEY  = 'xxyx_data';
const BASE_URL     = 'https://xxyx-client-api.xiaoxiaoyouxuan.com';

export default async function (ctx) {
    // ── 工具 ──────────────────────────────────────────────
    const log    = (...a) => console.log(`[${SCRIPT_NAME}]`, ...a);
    const notify = (body, title = SCRIPT_NAME) =>
        ctx.notify({ title, body: String(body) });

    /** 读账号列表：优先 env var（schedule 模式），其次 storage（http 模式存入） */
    const loadAccounts = () => {
        const raw = ctx.env?.[STORAGE_KEY] || ctx.storage.get(STORAGE_KEY);
        if (!raw) return [];
        try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
        catch { return []; }
    };

    const saveAccounts = (list) =>
        ctx.storage.set(STORAGE_KEY, JSON.stringify(list));

    /** 统一 HTTP 请求（自动拼接 BaseURL、携带鉴权 Header） */
    const api = async (token, path, method = 'GET', body = null) => {
        const url  = path.startsWith('http') ? path : `${BASE_URL}${path}`;
        const opts = {
            headers: {
                'xx-platform':  'ios',
                'Host':         'xxyx-client-api.xiaoxiaoyouxuan.com',
                'User-Agent':   'XiaoXiaoYouXuan/20127 CFNetwork/1331.0.7 Darwin/21.4.0',
                'xx-version':   '30221',
                'xx-token':     token,
                'content-type': 'application/json;charset=utf-8',
            },
            timeout: 30000,
        };
        if (body) opts.body = JSON.stringify(body);
        const fn   = method === 'POST' ? ctx.http.post : ctx.http.get;
        const resp = await fn.call(ctx.http, url, opts);
        return resp.json();
    };

    // ── 模式一：http_response 触发（抓取 Token 并保存）──────
    if (ctx.request && ctx.response) {
        try {
            const hdrs = {};
            ctx.request.headers.forEach((v, k) => { hdrs[k.toLowerCase()] = v; });
            const token = hdrs['xx-token'];

            const data = await ctx.response.json().catch(() => null);
            const info = data?.data;

            if (!token || !info?.mobile) {
                log('Token 抓取失败：参数缺失，请进入「我的」页面重试');
                return;
            }

            const account = {
                userId:   info.identityId,
                token,
                userName: info.mobile,
            };

            const list = loadAccounts();
            const idx  = list.findIndex(a => a.userId === account.userId);
            idx >= 0 ? (list[idx] = account) : list.push(account);
            saveAccounts(list);

            notify(`🎉 [${account.userName}] Token 更新成功！`);
            log('Token 更新成功：', account.userName);
        } catch (e) {
            log('抓取异常：', e.message);
        }
        return;
    }

    // ── 模式二：schedule 触发（签到 + 完成任务）────────────
    const accounts = loadAccounts();
    if (!accounts.length) {
        notify('⚠️ 无可用账号\n请先打开 App 进入「我的」页面获取 Token，或在 Egern 环境变量中设置 xxyx_data');
        return;
    }

    log(`检测到 ${accounts.length} 个账号，开始执行`);
    const msgs = [];
    let succCount = 0;

    for (const { token, userName } of accounts) {
        log(`──── 开始处理：${userName} ────`);
        try {
            // 验证登录态
            await api(token, '/client/user/bind/leader', 'POST',
                { signalId: 202, uid: 'XQIGUQVUAwxZClwM' });

            // 签到前能量
            const beforeRes  = await api(token, '/client/energy/mall/getUserEnergy?platform=ios');
            const ptBefore   = beforeRes?.data?.energy ?? 0;

            // 签到
            const signRes    = await api(token, '/client/energy/mall/signIn', 'POST', { platform: 'ios' });
            log(`签到结果：${signRes?.msg || '完成'}`);

            // 获取任务列表（过滤未完成）
            const taskRes    = await api(token, '/client/energy/mall/getTaskList');
            const pending    = (taskRes?.data || []).filter(t => t.isCompleted === 0);

            for (const task of pending) {
                for (let i = 0; i < (task.dailyCount || 1); i++) {
                    await api(token, `/client/energy/mall/completeTask/${task.taskId}`, 'POST',
                        { taskId: task.taskId, platform: 'ios' });
                    log(`${task.taskName}：调用成功`);
                }
            }

            // 签到后能量
            const afterRes   = await api(token, '/client/energy/mall/getUserEnergy?platform=ios');
            const ptAfter    = afterRes?.data?.energy ?? 0;

            // 用户昵称
            const userRes    = await api(token, '/my?platform=ios');
            const nick       = userRes?.data?.nick || userName;

            msgs.push(`✅ [${nick}] 能量：${ptAfter}（+${ptAfter - ptBefore}）`);
            succCount++;
        } catch (e) {
            log(`${userName} 执行失败：`, e.message);
            msgs.push(`❌ [${userName}] ${e.message}`);
        }
    }

    const summary = `共 ${accounts.length} 个账号，成功 ${succCount}，失败 ${accounts.length - succCount}`;
    notify(`${summary}\n${msgs.join('\n')}`);
    log('执行完毕：', summary);
}
