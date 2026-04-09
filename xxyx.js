/*
 * 晓晓优选 - Egern 适配版
 * 原作者：Sliverkiss | Egern 适配改写
 *
 * ── 使用说明 ──────────────────────────────────────────────
 *
 * [步骤一] http_request 触发（捕获 Token）
 *   类型：http_request
 *   匹配：^https://xxyx-client-api\.xiaoxiaoyouxuan\.com/my
 *   触发：打开 App → 进入「我的」页面
 *   效果：从请求头中读取 xx-token，暂存到本地存储
 *
 * [步骤二] schedule 触发（补全账号信息 + 执行签到）
 *   cron: "0 8 * * *"
 *   效果：读取暂存 token，调 /my 接口补全手机号，然后执行签到和任务
 *
 * 也可手动指定账号跳过 http_request 步骤（env 变量）：
 *   xxyx_data: '[{"userId":"xxx","token":"xxx","userName":"手机号"}]'
 *
 * [MITM]
 *   hostname: xxyx-client-api.xiaoxiaoyouxuan.com
 *
 * 注意：Egern 的 http_response 脚本 ctx.request.headers 不含 App 自定义头，
 *       因此改用 http_request 类型捕获 xx-token。
 */

const SCRIPT_NAME    = '晓晓优选';
const STORAGE_KEY    = 'xxyx_data';
const TEMP_TOKEN_KEY = 'xxyx_temp_token';
const BASE_URL       = 'https://xxyx-client-api.xiaoxiaoyouxuan.com';

export default async function (ctx) {
    const log    = (...a) => console.log(`[${SCRIPT_NAME}]`, ...a);
    const notify = (body, title = SCRIPT_NAME) =>
        ctx.notify({ title, body: String(body) });

    const loadAccounts = () => {
        const raw = ctx.env?.[STORAGE_KEY] || ctx.storage.get(STORAGE_KEY);
        if (!raw) return [];
        try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
        catch { return []; }
    };

    const saveAccounts = (list) =>
        ctx.storage.set(STORAGE_KEY, JSON.stringify(list));

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

    // ── 模式一：http_request 触发（从请求头捕获 Token）────────
    // Egern 的 http_request 脚本 ctx.request.headers 包含完整请求头
    // http_response 不含 App 自定义头，所以必须用 http_request
    if (ctx.request && !ctx.response) {
        try {
            const token = ctx.request.headers.get('xx-token');
            if (!token) {
                log('请求头中无 xx-token，跳过');
                return; // 放行请求
            }

            // 暂存 token（下次 cron 补全账号信息）
            ctx.storage.set(TEMP_TOKEN_KEY, token);
            log('Token 暂存成功，等待 schedule 任务补全账号信息');
            notify('🔑 Token 已捕获，将在下次定时任务时自动补全账号信息并执行签到');
        } catch (e) {
            log('捕获异常：', e.message);
        }
        return; // 放行请求，不修改
    }

    // ── 模式二：schedule 触发（签到 + 完成任务）────────────────

    // 2a. 如果有待处理的临时 token，先补全为完整账号
    const tempToken = ctx.storage.get(TEMP_TOKEN_KEY);
    if (tempToken) {
        ctx.storage.set(TEMP_TOKEN_KEY, ''); // 清除临时 token
        try {
            const res  = await api(tempToken, '/my?platform=ios');
            const info = res?.data;
            if (info?.mobile) {
                const account = {
                    userId:   info.identityId || info.mobile,
                    token:    tempToken,
                    userName: info.mobile,
                };
                const list = loadAccounts();
                const idx  = list.findIndex(a => a.userId === account.userId);
                idx >= 0 ? (list[idx] = account) : list.push(account);
                saveAccounts(list);
                notify(`🎉 [${account.userName}] 账号已添加，开始签到`);
                log('账号补全成功：', account.userName);
            } else {
                log('Token 无效或已过期，请重新打开 App 进入「我的」页面');
                notify('⚠️ Token 无效或已过期，请重新打开 App 进入「我的」页面');
            }
        } catch (e) {
            log('账号补全失败：', e.message);
        }
    }

    // 2b. 执行所有账号的签到任务
    const accounts = loadAccounts();
    if (!accounts.length) {
        notify('⚠️ 无可用账号\n请打开 App 进入「我的」页面捕获 Token，或在 Egern 环境变量中设置 xxyx_data');
        return;
    }

    log(`检测到 ${accounts.length} 个账号，开始执行`);
    const msgs = [];
    let succCount = 0;

    for (const { token, userName } of accounts) {
        log(`──── 开始处理：${userName} ────`);
        try {
            await api(token, '/client/user/bind/leader', 'POST',
                { signalId: 202, uid: 'XQIGUQVUAwxZClwM' });

            const beforeRes = await api(token, '/client/energy/mall/getUserEnergy?platform=ios');
            const ptBefore  = beforeRes?.data?.energy ?? 0;

            const signRes   = await api(token, '/client/energy/mall/signIn', 'POST', { platform: 'ios' });
            log(`签到结果：${signRes?.msg || '完成'}`);

            const taskRes   = await api(token, '/client/energy/mall/getTaskList');
            const pending   = (taskRes?.data || []).filter(t => t.isCompleted === 0);

            for (const task of pending) {
                for (let i = 0; i < (task.dailyCount || 1); i++) {
                    await api(token, `/client/energy/mall/completeTask/${task.taskId}`, 'POST',
                        { taskId: task.taskId, platform: 'ios' });
                    log(`${task.taskName}：调用成功`);
                }
            }

            const afterRes  = await api(token, '/client/energy/mall/getUserEnergy?platform=ios');
            const ptAfter   = afterRes?.data?.energy ?? 0;

            const userRes   = await api(token, '/my?platform=ios');
            const nick      = userRes?.data?.nick || userName;

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
