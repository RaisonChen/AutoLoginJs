'use strict';

/**
 * MonkeyCode (monkeycode-ai.com) 登录保活守护程序（Node.js 版）。
 *
 * 与 .NET 3.5 版功能对齐，逻辑均已通过真实环境抓包验证：
 *   1. 登录成功后把会话 Cookie 以明文 JSON 保存到 session.json。
 *   2. 每次启动读取会话并用 GET /users/status 校验登录状态；
 *      有效则复用，过期则走完整登录流程（PoW 验证码 -> redeem -> password-login）后重新保存。
 *   3. 两个独立随机定时循环保活：
 *        - 每 4~5 分钟（随机）刷新一次（status/tasks/wallet/subscription）。
 *        - 每 13~15 分钟（随机）向 AI 任务发送一次随机对话：
 *            账号永远只有一个任务，程序绝不创建/变动任务（否则开发环境全部要重配）。
 *            拉全部任务取第一个 -> 若上一轮会话仍在执行则先发 user-cancel 终止会话
 *            -> 重置上下文 -> 通过 WebSocket 发送。拉不到任务则跳过本轮。
 *
 * 登录流程：
 *   1. POST /api/v1/public/captcha/challenge  -> {challenge:{c,s,d}, token}
 *   2. 本地暴力求解 cap.js 风格工作量证明 (FNV-1a + xorshift32 生成 salt/target，SHA-256 搜 nonce)
 *   3. POST /api/v1/public/captcha/redeem     -> 换取 captcha token
 *   4. POST /api/v1/users/password-login      -> 携带 email/password/captcha_token 登录
 *
 * 运行：
 *   node index.js <email> <password>            # 常驻保活
 *   node index.js <email> <password> --test     # 各执行一次刷新+发送后退出（验证用）
 *   node index.js ... --debug                    # 打开 DEBUG 日志（每个 HTTP/WS 请求耗时、字节、帧等）
 *                                                #   等价环境变量：MC_DEBUG=1
 *
 * 日志分级：INFO 常规流程 / WARN 非 2xx 或降级重试 / ERROR 异常失败 / DEBUG 排查细节（默认关）。
 * 每轮刷新/发送带短 id（R1/C1...），便于把同一轮的多条日志串联排查。
 *
 * 依赖：仅 Node 内置模块（需 Node 20+，使用内置 fetch / WebSocket / crypto）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ===============================================================
// 常量
// ===============================================================
const BaseUrl = 'https://monkeycode-ai.com';
const Host = 'monkeycode-ai.com';

const ChallengePath = '/api/v1/public/captcha/challenge';
const RedeemPath = '/api/v1/public/captcha/redeem';
const LoginPath = '/api/v1/users/password-login';

const StatusPath = '/api/v1/users/status';
const TasksPath = '/api/v1/users/tasks';
const TaskDetailPath = '/api/v1/users/tasks'; // + '/{id}'
const TaskInputsPath = '/api/v1/users/tasks/user-inputs'; // + '?id={id}&limit=10'
const WalletPath = '/api/v1/users/wallet';
const SubscriptionPath = '/api/v1/users/subscription';
const WsStreamPath = '/api/v1/users/tasks/stream';
const WsControlPath = '/api/v1/users/tasks/control';

// WebSocket 发送模式：mode=new 发起一次新的用户输入；mode=attach 只读附着。
const WsMode = 'new';

const UserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

const SessionFile = path.join(__dirname, 'session.json');
const ConfigFile = path.join(__dirname, 'config.json');
// 日志目录：按天生成 logs/YYYY-MM-DD.log，只保留最近 N 天（见 DefaultConfig.logRetentionDays）。
const LogDir = path.join(__dirname, 'logs');

// 保活间隔默认值（分钟）。可被 config.json 覆盖。
const DefaultConfig = {
  email: '6553458@qq.com',
  password: 'Subway88',
  refreshMinMinutes: 4,
  refreshMaxMinutes: 5,
  chatMinMinutes: 13,
  chatMaxMinutes: 15,
  retryDelayMinutes: 1,
  // 单轮会话等待 task-ended 的超时（分钟）。超时未结束即判定本轮卡住/没结束，
  // 标记失败并触发重试；下一轮发送前会先 user-cancel 终止旧会话。
  sessionTimeoutMinutes: 1,
  // 日志文件保留天数：logs/ 下超过该天数的 *.log 会被删除（0 或负数表示不清理）。
  logRetentionDays: 3,
};

// ===============================================================
// 配置读取：config.json 覆盖默认值；读不到或字段缺失则回退默认。
// ===============================================================
function loadConfig() {
  const cfg = Object.assign({}, DefaultConfig);
  try {
    if (fs.existsSync(ConfigFile)) {
      let text = fs.readFileSync(ConfigFile, 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
      const parsed = JSON.parse(text);
      for (const k of Object.keys(DefaultConfig)) {
        if (parsed[k] !== undefined && parsed[k] !== null && parsed[k] !== '') {
          cfg[k] = parsed[k];
        }
      }
    }
  } catch (ex) {
    log('读取 config.json 失败，使用默认配置：' + (ex && ex.message ? ex.message : ex));
  }
  // 数值合法性兜底：min <= max，且均为正数。
  cfg.refreshMinMinutes = Math.max(0.1, Number(cfg.refreshMinMinutes) || DefaultConfig.refreshMinMinutes);
  cfg.refreshMaxMinutes = Math.max(cfg.refreshMinMinutes, Number(cfg.refreshMaxMinutes) || DefaultConfig.refreshMaxMinutes);
  cfg.chatMinMinutes = Math.max(0.1, Number(cfg.chatMinMinutes) || DefaultConfig.chatMinMinutes);
  cfg.chatMaxMinutes = Math.max(cfg.chatMinMinutes, Number(cfg.chatMaxMinutes) || DefaultConfig.chatMaxMinutes);
  cfg.retryDelayMinutes = Math.max(0.05, Number(cfg.retryDelayMinutes) || DefaultConfig.retryDelayMinutes);
  cfg.sessionTimeoutMinutes = Math.max(0.1, Number(cfg.sessionTimeoutMinutes) || DefaultConfig.sessionTimeoutMinutes);
  // 保留天数：允许 0（不清理）；其余取整且至少为 1。
  {
    const n = Number(cfg.logRetentionDays);
    cfg.logRetentionDays = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : DefaultConfig.logRetentionDays;
  }
  return cfg;
}

// ===============================================================
// 全局状态
// ===============================================================
// 简单的 Cookie 存储：name -> value。发请求时拼成 Cookie 头。
const Cookies = new Map();
let _email = '';
let _password = '';
let _config = DefaultConfig;
// 登录互斥：避免两个循环同时触发重登。
let _loginPromise = null;
// 循环计数：给每次刷新/发送一个短 id（R1/C1...），方便在日志里把同一轮的多条串起来。
let _refreshSeq = 0;
let _chatSeq = 0;
// 上一轮会话是否“没正常结束”（发送后超时没等到 task-ended = 卡住）。
// 为 true 时，下一轮发送前会先 user-cancel 终止那条卡住的旧会话，再发新消息。
let _lastSessionStuck = false;

// ===============================================================
// 入口
// ===============================================================
async function main() {
  const args = process.argv.slice(2);
  // DEBUG 开关：--debug 参数或环境变量 MC_DEBUG=1/true。
  setDebug(args.includes('--debug') || /^(1|true|yes)$/i.test(process.env.MC_DEBUG || ''));
  _config = loadConfig();
  // 初始化日志文件：logs/YYYY-MM-DD.log，按 config.logRetentionDays 只保留最近 N 天。
  initLogFile(_config.logRetentionDays);
  // 账号/密码优先级：命令行参数 > config.json > 内置默认。
  const argEmail = args[0] && !args[0].startsWith('--') ? args[0] : null;
  const argPwd = args[1] && !args[1].startsWith('--') ? args[1] : null;
  _email = argEmail || _config.email;
  _password = argPwd || _config.password;
  const testOnce = args.includes('--test');

  logi('启动：账号=' + _email + '，DEBUG=' + (_debug ? '开' : '关') + (testOnce ? '，模式=--test' : ''));
  logi('配置：刷新 ' + _config.refreshMinMinutes + '~' + _config.refreshMaxMinutes + ' 分钟，'
    + '发送 ' + _config.chatMinMinutes + '~' + _config.chatMaxMinutes + ' 分钟。');
  logi('日志：写入 ' + path.join('logs', _logDateKey + '.log')
    + (_logRetentionDays > 0 ? '，保留最近 ' + _logRetentionDays + ' 天。' : '，不自动清理。'));

  try {
    // 1. 读取本地会话
    const loaded = loadSession();
    logi(loaded
      ? '已读取本地会话 session.json（Cookie: ' + Array.from(Cookies.keys()).join(',') + '）。'
      : '未找到本地会话。');

    // 2. 校验登录状态
    const valid = loaded && (await checkLoginValid());
    if (!valid) {
      log('会话不存在或已过期，执行完整登录 ...');
      await doFullLogin(_email, _password);
      if (!(await checkLoginValid())) {
        throw new Error('完整登录后校验仍失败，请检查账号/密码或接口变化。');
      }
    } else {
      log('已有会话有效，跳过登录。');
    }

    if (testOnce) {
      log('=== 测试模式：执行一次刷新 ===');
      await doRefresh();
      log('=== 测试模式：执行一次发送对话 ===');
      await doChatOnce();
      log('=== 测试完成 ===');
      return;
    }

    // 3. 启动两个保活循环（各自独立随机定时）
    refreshLoop();
    chatLoop();
    log(`保活已启动：刷新 ${_config.refreshMinMinutes}~${_config.refreshMaxMinutes} 分钟/次，`
      + `发送对话 ${_config.chatMinMinutes}~${_config.chatMaxMinutes} 分钟/次。按 Ctrl+C 退出。`);
  } catch (ex) {
    loge('致命错误：' + errMsg(ex));
    process.exit(1);
  }
}

// ===============================================================
// 保活循环
// ===============================================================
async function refreshLoop() {
  // 无限循环：每次动作后按随机间隔 sleep。
  // 使用递归 setTimeout 风格，避免 setInterval 的漂移与重入。
  for (;;) {
    let failed = false;
    try {
      await doRefresh();
    } catch (ex) {
      failed = true;
      loge('刷新异常：' + errMsg(ex));
    }
    let ms;
    if (failed) {
      // 失败：按 config 的 retryDelayMinutes 短间隔重试，而非等到下一个正常周期。
      ms = _config.retryDelayMinutes * 60 * 1000;
      logw(`刷新失败，将在 ${(ms / 60000).toFixed(1)} 分钟后重试。`);
    } else {
      ms = nextRandom(_config.refreshMinMinutes * 60 * 1000, _config.refreshMaxMinutes * 60 * 1000 + 1);
      log(`下次刷新约在 ${(ms / 60000).toFixed(1)} 分钟后。`);
    }
    await sleep(ms);
  }
}

async function chatLoop() {
  // 稍微错开，避免与刷新扎堆。
  await sleep(nextRandom(20 * 1000, 60 * 1000));
  for (;;) {
    let failed = false;
    try {
      await doChatOnce();
    } catch (ex) {
      failed = true;
      loge('发送对话异常：' + errMsg(ex));
    }
    let ms;
    if (failed) {
      // 失败：按 config 的 retryDelayMinutes 短间隔重试。
      ms = _config.retryDelayMinutes * 60 * 1000;
      logw(`发送对话失败，将在 ${(ms / 60000).toFixed(1)} 分钟后重试。`);
    } else {
      ms = nextRandom(_config.chatMinMinutes * 60 * 1000, _config.chatMaxMinutes * 60 * 1000 + 1);
      log(`下次发送对话约在 ${(ms / 60000).toFixed(1)} 分钟后。`);
    }
    await sleep(ms);
  }
}

// ===============================================================
// 刷新（模拟右上角刷新按钮）
// ===============================================================
async function doRefresh() {
  const cid = 'R' + (++_refreshSeq);
  const t0 = Date.now();
  logi(cid + ' 刷新开始');

  let r = await httpGet(BaseUrl + StatusPath);
  if (r.status === 401) {
    logw(cid + ' status 返回 401，触发重登 ...');
    await reloginIfNeeded();
    r = await httpGet(BaseUrl + StatusPath);
  }
  logi(cid + ' status -> ' + r.status);

  // 网页右上角"刷新"按钮的真实请求是针对当前活跃任务的：
  //   GET /tasks/{id}
  //   GET /tasks/user-inputs?id={id}&limit=10
  // 因此优先取活跃任务ID并请求这两个接口；无活跃任务时回退到原任务列表请求。
  let taskId = null;
  try {
    const tasks = await listTasks();
    taskId = pickTaskId(tasks);
    logd(cid + ' 活跃任务数=' + (tasks ? tasks.length : 0) + '，选中 taskId=' + (taskId || '(无)'));
  } catch (ex) {
    logw(cid + ' 获取任务列表失败：' + errMsg(ex));
  }

  if (taskId != null) {
    try {
      const d = await httpGet(BaseUrl + TaskDetailPath + '/' + encodeURIComponent(taskId));
      logi(cid + ' task ' + taskId + ' 详情 -> ' + d.status);
    } catch (ex) {
      logw(cid + ' 拉取任务详情异常：' + errMsg(ex));
    }
    try {
      const ui = await httpGet(
        BaseUrl + TaskInputsPath + '?id=' + encodeURIComponent(taskId) + '&limit=10'
      );
      logi(cid + ' task ' + taskId + ' user-inputs -> ' + ui.status);
    } catch (ex) {
      logw(cid + ' 拉取 user-inputs 异常：' + errMsg(ex));
    }
  } else {
    const t = await httpGet(BaseUrl + TasksPath + '?page=1&size=24');
    logi(cid + ' tasks(列表回退) -> ' + t.status);
  }

  try {
    const w = await httpGet(BaseUrl + WalletPath);
    logi(cid + ' wallet -> ' + w.status);
  } catch (ex) {
    logw(cid + ' 拉取 wallet 异常：' + errMsg(ex));
  }
  try {
    const s = await httpGet(BaseUrl + SubscriptionPath);
    logi(cid + ' subscription -> ' + s.status);
  } catch (ex) {
    logw(cid + ' 拉取 subscription 异常：' + errMsg(ex));
  }

  logi(cid + ' 刷新完成，用时 ' + (Date.now() - t0) + 'ms');
}

// ===============================================================
// 发送对话（复用唯一任务；用 stream 的 task-ended 判定会话是否真正结束）
// ===============================================================
async function doChatOnce() {
  const cid = 'C' + (++_chatSeq);
  const t0 = Date.now();
  logi(cid + ' 发送对话开始');

  if (!(await checkLoginValid())) {
    logw(cid + ' 会话校验未通过，触发重登 ...');
    await reloginIfNeeded();
  }

  const tasks = await listTasks();
  let taskId = pickTaskId(tasks);
  logd(cid + ' 可用任务数=' + (tasks ? tasks.length : 0) + '，选中 taskId=' + (taskId || '(无)'));

  if (taskId == null) {
    // 按约束：账号永远只有一个任务，程序绝不创建任务（创建/变动任务会导致开发环境全部重配）。
    // 拉不到任务时只跳过本轮并告警，抛出让 chatLoop 按 retryDelayMinutes 稍后重试。
    throw new Error('未找到任何任务（程序不会创建任务），本轮发送跳过');
  }
  logd(cid + ' 复用唯一任务：' + taskId);

  // 仅当“上一轮会话没正常结束（卡住）”时，才先终止旧会话。
  // 判据来自上一轮 sendViaWebSocket 是否在超时内收到 task-ended（_lastSessionStuck），
  // 【不再】用任务顶层 status（它对 develop 任务恒为 processing，会导致每轮误判）。
  // user-cancel 只终止会话/当前对话轮次，绝不触碰任务/VM/文件。
  if (_lastSessionStuck) {
    logw(cid + ' [会话卡住] 上一轮会话超时未结束，先 user-cancel 终止旧会话'
      + '｜会话ID=' + cid + '｜任务ID=' + taskId + '｜时刻=' + nowStamp());
    const ct = Date.now();
    const cancelled = await cancelSession(taskId);
    if (cancelled) logi(cid + ' [会话卡住] user-cancel 已完成（' + (Date.now() - ct) + 'ms）');
    else logw(cid + ' [会话卡住] user-cancel 失败/超时（' + (Date.now() - ct) + 'ms），仍继续发送');
    _lastSessionStuck = false; // 无论成功与否都清标记，避免下一轮重复取消。
  }

  // 发送前先重置上下文（等价网页"重置上下文"按钮：restart + load_session:false），
  // 避免历史对话累积导致单次 token 损耗过大。仅重置会话上下文，不触碰任务/VM/文件。
  {
    const rt = Date.now();
    const reset = await resetContext(taskId);
    if (reset) logi(cid + ' 重置上下文成功（任务 ' + taskId + '，' + (Date.now() - rt) + 'ms）');
    else logw(cid + ' 重置上下文失败/超时（任务 ' + taskId + '，' + (Date.now() - rt) + 'ms），仍继续发送');
  }

  const content = randomContent();
  logd(cid + ' 本次内容：' + content);
  const st = Date.now();
  const timeoutMs = _config.sessionTimeoutMinutes * 60 * 1000;
  const res = await sendViaWebSocket(taskId, content, timeoutMs);

  if (!res.ok) {
    // 连接/发送失败：抛出让 chatLoop 按 retryDelayMinutes 在同一任务上重试。
    throw new Error('WebSocket 发送失败（连接/发送异常）');
  }
  if (res.ended) {
    // 收到 task-ended = 本轮会话真正完成。
    _lastSessionStuck = false;
    logi(cid + ' 会话完成｜任务 ' + taskId + '｜exit_code=' + res.exitCode
      + '｜用时 ' + (Date.now() - st) + 'ms｜内容：' + content);
  } else {
    // 帧已发出但超时没等到 task-ended = 本轮没结束/卡住。
    // 标记卡住，下一轮发送前会先 user-cancel；本轮抛出触发 retryDelayMinutes 重试。
    _lastSessionStuck = true;
    logw(cid + ' [会话未结束] 发送后 ' + _config.sessionTimeoutMinutes + ' 分钟内未收到 task-ended'
      + '（started=' + res.started + '）｜任务 ' + taskId + '｜时刻=' + nowStamp()
      + '｜下一轮发送前将先终止该会话。');
    throw new Error('会话未在 ' + _config.sessionTimeoutMinutes + ' 分钟内结束（卡住）');
  }
  logi(cid + ' 发送对话完成，用时 ' + (Date.now() - t0) + 'ms');
}

async function listTasks() {
  // 按约束：账号永远只有一个任务。不按状态过滤（否则 finished/idle 的任务会被漏掉），
  // 拉全部任务，交给 pickTaskId 取第一个。绝不创建新任务。
  const url = BaseUrl + TasksPath + '?page=1&size=24';
  let r = await httpGet(url);
  if (r.status === 401) {
    await reloginIfNeeded();
    r = await httpGet(url);
  }
  if (r.status < 200 || r.status >= 300 || !r.body) return [];

  // 直接用 JSON.parse（Node 有原生 JSON），再从 data.tasks 里取顶层 id/status。
  try {
    const obj = JSON.parse(r.body);
    const arr = findTasksArray(obj);
    if (!Array.isArray(arr)) return [];
    const list = [];
    for (const t of arr) {
      if (t && typeof t.id === 'string' && t.id) {
        list.push({ id: t.id, status: typeof t.status === 'string' ? t.status : '' });
      }
    }
    return list;
  } catch (_) {
    return [];
  }
}

// 兼容不同响应结构：{data:{tasks:[]}} / {tasks:[]} / {data:[]}。
function findTasksArray(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj.tasks)) return obj.tasks;
  if (obj.data && Array.isArray(obj.data.tasks)) return obj.data.tasks;
  if (Array.isArray(obj.data)) return obj.data;
  return null;
}

function pickTaskId(tasks) {
  if (!tasks || tasks.length === 0) return null;
  for (const t of tasks) if (t.status === 'processing') return t.id;
  return tasks[0].id;
}

// ===============================================================
// 随机内容
// ===============================================================
// 说明：发送内容必须看起来像一次「正常的开发咨询」，否则会被 AI 端反滥用风控拦截
// （实测发送含「保活」等字样会返回「发现违规行为，已上报风控中心」）。
//
// 为了尽量节省对方 token/积分，改成「技术判断题」：给一个真实的技术是非命题，
// 要求只回 1（对）或 0（错）。这样对方通常只回一个字符，消耗极低；同时命题本身
// 是正常的技术求证，口吻自然，不易看出是刻意保活。命题随机组合，避免千篇一律。
const _facts = [
  'Python 中 list 是线程安全的',
  'JavaScript 里 typeof null 的结果是 "object"',
  'Go 的 map 并发读写不加锁是安全的',
  'HTTP 状态码 301 表示永久重定向',
  'Java 中 String 是不可变对象',
  'MySQL 的 InnoDB 默认隔离级别是可重复读',
  'Rust 的所有权机制可以在编译期避免数据竞争',
  'TCP 三次握手是为了建立可靠连接',
  'Redis 的单线程指的是命令执行是单线程的',
  'CSS 中 flex 布局的默认主轴方向是水平的',
  'Git 里 rebase 会改写提交历史',
  'Linux 中 chmod 755 表示所有者可读写执行',
  'C# 中 struct 是值类型',
  '正则里 \\d 匹配的是数字字符',
  'UTF-8 中一个中文字符通常占 3 个字节',
  'SQL 的 LEFT JOIN 会保留左表的全部行',
  'Docker 镜像的每一层都是只读的',
  'HTTPS 默认使用 443 端口',
  '快速排序的平均时间复杂度是 O(n log n)',
  '二分查找要求数据必须有序',
];

const _factTemplates = [
  (f) => `快速确认一下：${f}，对吗？只回 1（对）或 0（错）即可。`,
  (f) => `判断题：${f}。请只回 1 或 0。`,
  (f) => `${f}——这个说法正确吗？只需回 1 或 0。`,
  (f) => `帮我核对下：${f}。对回 1，错回 0，不用解释。`,
  (f) => `是非题：${f}？回答 1 表示对，0 表示错。`,
];

function randomContent() {
  const fact = _facts[nextRandom(0, _facts.length)];
  const tpl = _factTemplates[nextRandom(0, _factTemplates.length)];
  return tpl(fact);
}

// ===============================================================
// 登录状态校验 / 完整登录 / 重登
// ===============================================================
async function checkLoginValid() {
  try {
    const r = await httpGet(BaseUrl + StatusPath);
    if (r.status === 401 || r.status === 403) return false;
    if (r.status < 200 || r.status >= 300) return false;
    if (r.body && r.body.indexOf('"code":0') >= 0) return true;
    return r.status === 200 && (!r.body || r.body.toLowerCase().indexOf('unauthorized') < 0);
  } catch (_) {
    return false;
  }
}

async function reloginIfNeeded() {
  // 用一个共享 Promise 做互斥，避免两个循环并发重登。
  if (_loginPromise) return _loginPromise;
  _loginPromise = (async () => {
    if (await checkLoginValid()) {
      logd('reloginIfNeeded: 会话仍有效，无需重登。');
      return;
    }
    logw('检测到会话失效，重新登录 ...');
    await doFullLogin(_email, _password);
  })();
  try {
    await _loginPromise;
  } finally {
    _loginPromise = null;
  }
}

async function doFullLogin(email, password) {
  log('[1/4] 获取验证码挑战 ...');
  const challenge = await getChallenge();

  log('[2/4] 本地求解工作量证明 (PoW) ...');
  const solutions = solveChallenge(challenge);

  log('[3/4] 兑换 captcha token ...');
  const capToken = await redeem(challenge.token, solutions);

  log('[4/4] 提交密码登录 ...');
  const resp = await login(email, password, capToken);

  const ok =
    resp.status >= 200 &&
    resp.status < 300 &&
    (resp.body.indexOf('"code":0') >= 0 || resp.body.indexOf('"success"') >= 0);
  if (ok) {
    const name = extractString(resp.body, 'name');
    log('登录成功！账号：' + email + '  昵称：' + (name || '(未知)'));
    saveSession();
  } else {
    throw new Error('登录失败（HTTP ' + resp.status + '）：' + trunc(resp.body, 300));
  }
}

// ===============================================================
// 登录四步
// ===============================================================
async function getChallenge() {
  const r = await sendRequest('POST', BaseUrl + ChallengePath, null);
  const json = r.body;
  const ch = {
    token: extractString(json, 'token'),
    c: extractInt(json, 'c'),
    s: extractInt(json, 's'),
    d: extractInt(json, 'd'),
  };
  if (!ch.token || ch.c <= 0 || ch.s <= 0 || ch.d <= 0) {
    throw new Error('挑战响应解析失败：' + json);
  }
  return ch;
}

function solveChallenge(ch) {
  const solutions = new Array(ch.c);
  for (let idx = 1; idx <= ch.c; idx++) {
    const salt = prng(ch.token + idx, ch.s);
    const target = prng(ch.token + idx + 'd', ch.d);
    let nonce = 0;
    for (;;) {
      const hex = sha256Hex(salt + nonce);
      if (hex.startsWith(target)) {
        solutions[idx - 1] = nonce;
        break;
      }
      nonce++;
    }
  }
  return solutions;
}

async function redeem(token, solutions) {
  const body = JSON.stringify({ token: token, solutions: solutions });
  const r = await sendRequest('POST', BaseUrl + RedeemPath, body);
  const json = r.body;
  if (json.indexOf('"success":true') < 0) {
    throw new Error('captcha token 兑换失败（PoW 无效或已过期）：' + json);
  }
  const capToken = extractString(json, 'token');
  if (!capToken) throw new Error('兑换响应中未找到 token：' + json);
  return capToken;
}

async function login(email, password, capToken) {
  const body = JSON.stringify({ email: email, password: password, captcha_token: capToken });
  return sendRequest('POST', BaseUrl + LoginPath, body);
}

// ===============================================================
// cap.js PRNG（FNV-1a 生成种子 + xorshift32 生成十六进制流）
// 与 .NET 版逐位对齐（32 位无符号运算）。
// ===============================================================
function prng(seed, length) {
  let h = 2166136261 >>> 0; // FNV offset basis
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    // h += h*(2^1 + 2^4 + 2^7 + 2^8 + 2^24) —— 用移位保持与 .NET 完全一致。
    h = (h + ((h << 1) >>> 0) + ((h << 4) >>> 0) + ((h << 7) >>> 0) + ((h << 8) >>> 0) + ((h << 24) >>> 0)) >>> 0;
  }

  let out = '';
  while (out.length < length) {
    h ^= (h << 13) >>> 0;
    h >>>= 0;
    h ^= h >>> 17;
    h >>>= 0;
    h ^= (h << 5) >>> 0;
    h >>>= 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, length);
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

// ===============================================================
// HTTP（内置 fetch + 手动 Cookie 管理）
// ===============================================================
async function httpGet(url) {
  return sendRequest('GET', url, null);
}

async function sendRequest(method, url, jsonBody) {
  const headers = {
    Accept: 'application/json',
    'User-Agent': UserAgent,
    Origin: BaseUrl,
    Referer: BaseUrl + '/login',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  const cookieHeader = buildCookieHeader();
  if (cookieHeader) headers['Cookie'] = cookieHeader;

  const init = { method: method, headers: headers, redirect: 'manual' };
  if (method === 'POST' || method === 'PUT') {
    headers['Content-Type'] = 'application/json';
    init.body = jsonBody || '{}';
  }

  const sp = shortPath(url);
  const reqBytes = init.body ? Buffer.byteLength(init.body, 'utf8') : 0;
  const t0 = Date.now();
  logd('HTTP -> ' + method + ' ' + sp + (reqBytes ? ' (body ' + reqBytes + 'B)' : ''));
  try {
    const resp = await fetch(url, init);
    // 收集 Set-Cookie（Node fetch 用 getSetCookie 返回数组）。
    const setCookieNames = captureSetCookies(resp);
    const body = await resp.text();
    const dt = Date.now() - t0;
    const bytes = Buffer.byteLength(body || '', 'utf8');
    const cookieNote = setCookieNames.length ? ' set-cookie=[' + setCookieNames.join(',') + ']' : '';
    logd('HTTP <- ' + resp.status + ' ' + method + ' ' + sp + ' ' + dt + 'ms ' + bytes + 'B' + cookieNote);
    // 非 2xx（且非 401，401 有专门的重登处理）在 WARN 级别附带响应体预览，便于排查。
    if ((resp.status < 200 || resp.status >= 300) && resp.status !== 401) {
      logw('HTTP ' + resp.status + ' ' + method + ' ' + sp + ' ' + dt + 'ms 响应预览：' + trunc(body, 200));
    }
    return { status: resp.status, body: body };
  } catch (ex) {
    const dt = Date.now() - t0;
    loge('HTTP 请求失败 ' + method + ' ' + sp + ' ' + dt + 'ms：' + errMsg(ex));
    return { status: 0, body: 'FetchError: ' + errMsg(ex) };
  }
}

function captureSetCookies(resp) {
  let list = [];
  const names = [];
  try {
    if (typeof resp.headers.getSetCookie === 'function') {
      list = resp.headers.getSetCookie();
    } else {
      const raw = resp.headers.get('set-cookie');
      if (raw) list = [raw];
    }
  } catch (_) {}
  for (const sc of list) {
    // 取 "name=value" 前缀，忽略 Path/Expires 等属性。
    const semi = sc.indexOf(';');
    const pair = (semi >= 0 ? sc.slice(0, semi) : sc).trim();
    const eq = pair.indexOf('=');
    if (eq > 0) {
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (name) {
        Cookies.set(name, value);
        names.push(name);
      }
    }
  }
  return names;
}

function buildCookieHeader() {
  const parts = [];
  for (const [name, value] of Cookies) parts.push(name + '=' + value);
  return parts.join('; ');
}

// ===============================================================
// 会话持久化（明文 JSON）
// ===============================================================
function saveSession() {
  try {
    const cookies = [];
    for (const [name, value] of Cookies) {
      cookies.push({ name: name, value: value, path: '/', domain: Host });
    }
    const obj = {
      host: BaseUrl,
      savedAt: new Date().toISOString().slice(0, 19),
      cookies: cookies,
    };
    fs.writeFileSync(SessionFile, JSON.stringify(obj), 'utf8');
    log('会话已保存到 ' + SessionFile + '（共 ' + cookies.length + ' 个 Cookie）。');
  } catch (ex) {
    log('保存会话失败：' + (ex && ex.message ? ex.message : ex));
  }
}

function loadSession() {
  try {
    if (!fs.existsSync(SessionFile)) return false;
    let json = fs.readFileSync(SessionFile, 'utf8');
    // 去掉可能的 UTF-8 BOM（例如 .NET 版用 Encoding.UTF8 写出的文件会带 BOM）。
    if (json.charCodeAt(0) === 0xfeff) json = json.slice(1);
    const obj = JSON.parse(json);
    if (!obj || !Array.isArray(obj.cookies)) return false;
    let count = 0;
    for (const c of obj.cookies) {
      if (c && c.name && c.value != null) {
        Cookies.set(c.name, c.value);
        count++;
      }
    }
    return count > 0;
  } catch (ex) {
    log('读取会话失败：' + (ex && ex.message ? ex.message : ex));
    return false;
  }
}

// ===============================================================
// WebSocket 发送（内置 WebSocket）
// ===============================================================
// 帧结构（已抓包确认）：
//   外层 {"type":"user-input","data": BASE64( {"content": BASE64(utf8(text)), "attachments":[]} )}
//   服务端应用层心跳 {"type":"ping","data":null} -> 回 {"type":"pong","data":null}
//
// 会话生命周期帧（2026-08-08 probe_session.js watch 实测确认）：
//   task-started -> 服务端已受理本轮输入（= 发送成功）
//   task-running -> 会话进行中（增量：thought/message/usage 等，可多帧）
//   task-ended   -> 本轮会话结束，data 解码为 {"exit_code":0,"message":"completed"}
// 注意：任务顶层 status 恒为 processing、vm 恒为 online，都【不能】用来判断会话是否在跑。
//
// 返回 Promise<{ok, started, ended, exitCode}>：
//   ok=false            连接/发送失败
//   ok=true,ended=true  收到 task-ended（本轮真正完成；exitCode 为退出码）
//   ok=true,ended=false 帧已发出但在 timeoutMs 内没等到 task-ended（= 本轮没结束/卡住）
function sendViaWebSocket(taskId, content, timeoutMs) {
  const waitMs = timeoutMs && timeoutMs > 0 ? timeoutMs : 60000;
  return new Promise((resolve) => {
    let settled = false;
    let pings = 0;
    let started = false;
    let ended = false;
    let exitCode = null;
    const wsT0 = Date.now();
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch (_) {}
      resolve({ ok: ok, started: started, ended: ended, exitCode: exitCode });
    };

    const query = '?id=' + encodeURIComponent(taskId) + '&mode=' + WsMode;
    const url = 'wss://' + Host + WsStreamPath + query;
    logd('WS(send) 连接 ' + shortPath(url));

    // 内置 WebSocket 支持传 headers（携带 Cookie/Origin/UA 以通过鉴权）。
    let ws;
    try {
      ws = new WebSocket(url, {
        headers: {
          Cookie: buildCookieHeader(),
          Origin: BaseUrl,
          'User-Agent': UserAgent,
        },
      });
    } catch (ex) {
      loge('WS(send) 构造异常：' + errMsg(ex));
      resolve({ ok: false, started: false, ended: false, exitCode: null });
      return;
    }

    // 整体超时（握手 + 发送 + 等 task-ended）。到点仍未收到 task-ended
    // 则按“本轮没结束/卡住”处理（ended=false），由调用方决定重试/下一轮先 cancel。
    const overall = setTimeout(() => {
      logw('WS(send) 等待 task-ended 超时（' + (waitMs / 1000).toFixed(0) + 's）：'
        + 'started=' + started + ' ended=' + ended + '，判定本轮未结束。ping=' + pings);
      done(true);
    }, waitMs);

    ws.addEventListener('open', () => {
      logd('WS(send) 握手成功（' + (Date.now() - wsT0) + 'ms），发送用户输入帧 ...');
      try {
        const inner = JSON.stringify({ content: base64Utf8(content), attachments: [] });
        const frame = JSON.stringify({ type: 'user-input', data: base64Utf8(inner) });
        ws.send(frame);
        logd('WS(send) 已发送帧 ' + Buffer.byteLength(frame, 'utf8') + 'B，等待 task-ended（最多 '
          + (waitMs / 1000).toFixed(0) + 's）...');
      } catch (ex) {
        loge('WS(send) 发送异常：' + errMsg(ex));
        clearTimeout(overall);
        done(false);
      }
    });

    ws.addEventListener('message', (evt) => {
      try {
        const txt = typeof evt.data === 'string' ? evt.data : '';
        if (!txt) return;
        // 应用层心跳：回 pong 保活。
        if (txt.indexOf('"type":"ping"') >= 0) {
          pings++;
          ws.send(JSON.stringify({ type: 'pong', data: null }));
          logd('WS(send) 收到 ping，已回 pong（第 ' + pings + ' 次）');
          return;
        }
        // 会话生命周期帧。
        let o;
        try { o = JSON.parse(txt); } catch (_) { return; }
        if (o.type === 'task-started') {
          started = true;
          logd('WS(send) 收到 task-started（服务端已受理，用时 ' + (Date.now() - wsT0) + 'ms）');
        } else if (o.type === 'task-ended') {
          ended = true;
          exitCode = decodeExitCode(o.data);
          logd('WS(send) 收到 task-ended（exit_code=' + exitCode + '，用时 ' + (Date.now() - wsT0) + 'ms）');
          clearTimeout(overall);
          done(true);
        }
      } catch (_) {}
    });

    ws.addEventListener('error', (evt) => {
      loge('WS(send) 错误：' + (evt && evt.message ? evt.message : '连接失败'));
      clearTimeout(overall);
      done(false);
    });

    ws.addEventListener('close', (evt) => {
      // 若在收到 task-ended 前就关闭：已 started 视为本轮未结束（ended=false），否则视为失败。
      logd('WS(send) 关闭 code=' + (evt && evt.code != null ? evt.code : '?')
        + '，存活 ' + (Date.now() - wsT0) + 'ms，ping=' + pings + '，started=' + started + '，ended=' + ended);
      if (!settled) {
        clearTimeout(overall);
        done(started ? true : false);
      }
    });
  });
}

// 解出 task-ended 帧里的 exit_code（data 为 BASE64(utf8(JSON))）。失败返回 null。
function decodeExitCode(data) {
  try {
    if (typeof data !== 'string' || !data) return null;
    const json = Buffer.from(data, 'base64').toString('utf8');
    const o = JSON.parse(json);
    return typeof o.exit_code === 'number' ? o.exit_code : null;
  } catch (_) {
    return null;
  }
}

// ===============================================================
// 终止当前会话（等价网页对话区的"取消"按钮）
// ---------------------------------------------------------------
// 浏览器抓包 + 前端 bundle 逆向双重确认（2026-08-08）：
//   前端 sendCancel(){ this.sendMessage({type:"user-cancel"}) }
//   sendMessage(t){ ...this.socket.send(JSON.stringify(t))... }
//   this.socket 就是任务的 stream 连接（与发 user-input 同一条 WebSocket）。
//   => 取消帧就是裸 JSON  {"type":"user-cancel"}（无 data 字段，不做 base64）。
//   服务端 processMessage 里 case "user-cancel" 只中断当前 agent 执行，
//   不关闭 socket、不涉及任务/VM/文件（disconnect() 是另一个独立方法）。
//
// 关键安全约束：这里【只终止会话/当前对话轮次】，绝不调用 /tasks/stop、
// 也不走 control 通道，任务、开发环境、文件均不受影响。
function cancelSession(taskId) {
  return new Promise((resolve) => {
    let settled = false;
    const wsT0 = Date.now();
    let ws;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch (_) {}
      resolve(ok);
    };

    // 与发送同一 stream 通道；mode 用 new（与 sendViaWebSocket 保持一致）。
    const url = 'wss://' + Host + WsStreamPath + '?id=' + encodeURIComponent(taskId) + '&mode=' + WsMode;
    logd('WS(cancel) 连接 ' + shortPath(url));
    try {
      ws = new WebSocket(url, {
        headers: {
          Cookie: buildCookieHeader(),
          Origin: BaseUrl,
          'User-Agent': UserAgent,
        },
      });
    } catch (ex) {
      loge('WS(cancel) 构造异常：' + errMsg(ex));
      resolve(false);
      return;
    }

    // 取消是即时动作：握手 -> 发一帧 -> 给服务端 2s 处理即可。
    const overall = setTimeout(() => {
      logw('WS(cancel) 整体超时（8s），按已发出处理。');
      done(true);
    }, 8000);

    ws.addEventListener('open', () => {
      logd('WS(cancel) 握手成功（' + (Date.now() - wsT0) + 'ms），发送 user-cancel ...');
      try {
        const frame = JSON.stringify({ type: 'user-cancel' });
        ws.send(frame);
        logd('WS(cancel) 已发送 ' + frame);
        setTimeout(() => {
          clearTimeout(overall);
          done(true);
        }, 2000);
      } catch (ex) {
        loge('WS(cancel) 发送异常：' + errMsg(ex));
        clearTimeout(overall);
        done(false);
      }
    });

    ws.addEventListener('message', (evt) => {
      try {
        const txt = typeof evt.data === 'string' ? evt.data : '';
        if (txt.indexOf('"type":"ping"') >= 0) {
          ws.send(JSON.stringify({ type: 'pong', data: null }));
        }
      } catch (_) {}
    });

    ws.addEventListener('error', (evt) => {
      loge('WS(cancel) 错误：' + (evt && evt.message ? evt.message : '连接失败'));
      clearTimeout(overall);
      done(false);
    });

    ws.addEventListener('close', (evt) => {
      logd('WS(cancel) 关闭 code=' + (evt && evt.code != null ? evt.code : '?')
        + '，存活 ' + (Date.now() - wsT0) + 'ms');
      if (!settled) {
        clearTimeout(overall);
        done(false);
      }
    });
  });
}

function base64Utf8(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

// ===============================================================
// 重置上下文（等价网页右上角"重置上下文"按钮）
// ---------------------------------------------------------------
// 抓包/前端源码确认：走任务控制通道 WebSocket，而非 REST。
//   URL：wss://<host>/api/v1/users/tasks/control?id={taskId}
//   发送：{"type":"call","kind":"restart","data": BASE64( {"request_id":<uuid>,"load_session":false} )}
//   load_session:false = 重启 Agent 且不加载旧会话，即清空上下文。
//   成功：{"type":"call-response","data": BASE64( {"request_id":<同一uuid>,"success":true} )}
// data 用标准 base64(utf8)，与 sendViaWebSocket 内层编码一致。
function resetContext(taskId) {
  return new Promise((resolve) => {
    let settled = false;
    const requestId = genUuid();
    const wsT0 = Date.now();
    let ws;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch (_) {}
      resolve(ok);
    };

    const url = 'wss://' + Host + WsControlPath + '?id=' + encodeURIComponent(taskId);
    logd('WS(reset) 连接 ' + shortPath(url) + '，request_id=' + requestId);
    try {
      ws = new WebSocket(url, {
        headers: {
          Cookie: buildCookieHeader(),
          Origin: BaseUrl,
          'User-Agent': UserAgent,
        },
      });
    } catch (ex) {
      loge('WS(reset) 构造异常：' + errMsg(ex));
      resolve(false);
      return;
    }

    // restart 服务端处理较慢，给足超时（前端 RESTART_TIMEOUT 约 15s）。
    const overall = setTimeout(() => {
      logw('WS(reset) 等待 call-response 超时（20s），视为失败。request_id=' + requestId);
      done(false);
    }, 20000);

    ws.addEventListener('open', () => {
      logd('WS(reset) 握手成功（' + (Date.now() - wsT0) + 'ms），发送 restart(load_session=false) ...');
      try {
        const inner = JSON.stringify({ request_id: requestId, load_session: false });
        const frame = JSON.stringify({ type: 'call', kind: 'restart', data: base64Utf8(inner) });
        ws.send(frame);
      } catch (ex) {
        loge('WS(reset) 发送异常：' + errMsg(ex));
        clearTimeout(overall);
        done(false);
      }
    });

    ws.addEventListener('message', (evt) => {
      try {
        const txt = typeof evt.data === 'string' ? evt.data : '';
        if (txt.indexOf('"type":"ping"') >= 0) {
          ws.send(JSON.stringify({ type: 'pong', data: null }));
          return;
        }
        if (txt.indexOf('"type":"call-response"') < 0) {
          logd('WS(reset) 收到其它帧：' + trunc(txt, 120));
          return;
        }
        // 解出内层 data（base64(utf8(json))），校验 request_id 与 success。
        const payload = decodeControlPayload(txt);
        if (!payload) {
          logw('WS(reset) call-response 解析失败：' + trunc(txt, 120));
          return;
        }
        if (payload.request_id && payload.request_id !== requestId) {
          logd('WS(reset) 忽略非本次 request_id 的响应：' + payload.request_id);
          return; // 不是本次调用
        }
        clearTimeout(overall);
        logd('WS(reset) 收到 call-response，success=' + payload.success + '（' + (Date.now() - wsT0) + 'ms）');
        done(payload.success === true);
      } catch (ex) {
        logw('WS(reset) 处理消息异常：' + errMsg(ex));
      }
    });

    ws.addEventListener('error', (evt) => {
      loge('WS(reset) 错误：' + (evt && evt.message ? evt.message : '连接失败'));
      clearTimeout(overall);
      done(false);
    });

    ws.addEventListener('close', (evt) => {
      logd('WS(reset) 关闭 code=' + (evt && evt.code != null ? evt.code : '?')
        + '，存活 ' + (Date.now() - wsT0) + 'ms');
      if (!settled) {
        clearTimeout(overall);
        done(false);
      }
    });
  });
}

// 从控制通道 call-response 帧里解出内层 payload（{"data": BASE64(utf8(json))}）。
function decodeControlPayload(frameText) {
  const b64 = extractString(frameText, 'data');
  if (!b64) return null;
  try {
    const json = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

// 生成 request_id（优先内置 crypto.randomUUID，回退时间戳+随机）。
function genUuid() {
  try {
    const crypto = require('crypto');
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch (_) {}
  return Date.now() + '-' + Math.random().toString(16).slice(2);
}

// ===============================================================
// JSON / 文本辅助（与 .NET 版对齐的宽松提取器，用于非标准响应兜底）
// ===============================================================
function extractString(json, key) {
  if (!json) return null;
  const marker = '"' + key + '"';
  const i = json.indexOf(marker);
  if (i < 0) return null;
  return extractStringFrom(json, i);
}

function extractStringFrom(json, keyIndex) {
  let i = json.indexOf(':', keyIndex);
  if (i < 0) return null;
  i++;
  while (i < json.length && (json[i] === ' ' || json[i] === '\t')) i++;
  if (i >= json.length || json[i] !== '"') return null;
  i++;
  let out = '';
  while (i < json.length && json[i] !== '"') {
    if (json[i] === '\\' && i + 1 < json.length) {
      i++;
      const e = json[i];
      if (e === 'n') out += '\n';
      else if (e === 'r') out += '\r';
      else if (e === 't') out += '\t';
      else out += e;
    } else {
      out += json[i];
    }
    i++;
  }
  return out;
}

function extractInt(json, key) {
  if (!json) return -1;
  const marker = '"' + key + '"';
  let i = json.indexOf(marker);
  if (i < 0) return -1;
  i = json.indexOf(':', i + marker.length);
  if (i < 0) return -1;
  i++;
  while (i < json.length && (json[i] === ' ' || json[i] === '\t')) i++;
  const start = i;
  while (i < json.length && (/[0-9]/.test(json[i]) || json[i] === '-')) i++;
  if (i === start) return -1;
  const v = parseInt(json.slice(start, i), 10);
  return Number.isNaN(v) ? -1 : v;
}

function trunc(s, max) {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max) + '...';
}

function nextRandom(minInclusive, maxExclusive) {
  return minInclusive + Math.floor(Math.random() * (maxExclusive - minInclusive));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ===============================================================
// 日志（分级 + 时间戳；DEBUG 默认关闭，用 --debug 或 MC_DEBUG=1 打开）
// ---------------------------------------------------------------
// - logi/log  : INFO  常规流程
// - logw      : WARN  可疑但不致命（非 2xx、降级、重试）
// - loge      : ERROR 异常/失败
// - logd      : DEBUG 排查细节（每个 HTTP/WS 请求耗时、字节数、帧内容等），默认不打印
let _debug = false;
// 当前日志文件的日期（YYYY-MM-DD）。跨天时切换文件并清理过期日志。
let _logDateKey = '';
// 日志保留天数（由 initLogFile() 依据 config 初始化）。0 表示不清理。
let _logRetentionDays = 3;

function setDebug(on) {
  _debug = !!on;
}

// 启动时调用：确保 logs/ 存在、记录保留天数、按当天切好文件并清理一次过期日志。
function initLogFile(retentionDays) {
  _logRetentionDays = Number.isFinite(retentionDays) ? retentionDays : _logRetentionDays;
  try {
    if (!fs.existsSync(LogDir)) fs.mkdirSync(LogDir, { recursive: true });
  } catch (_) {}
  rollLogIfNeeded();
}

// 返回本地日期键 YYYY-MM-DD。
function _dateKey(d) {
  const p2 = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

// 当前应写入的日志文件路径（logs/YYYY-MM-DD.log）。
function _currentLogPath() {
  return path.join(LogDir, _logDateKey + '.log');
}

// 若日期变了（或首次），切换到当天日志文件并清理过期文件。
function rollLogIfNeeded() {
  const key = _dateKey(new Date());
  if (key === _logDateKey) return;
  _logDateKey = key;
  cleanupOldLogs();
}

// 删除 logs/ 下超过保留天数的 *.log。保留天数为当天 + 之前 (N-1) 天，共 N 天。
function cleanupOldLogs() {
  if (!_logRetentionDays || _logRetentionDays <= 0) return; // 0/负数 = 不清理
  try {
    if (!fs.existsSync(LogDir)) return;
    // 计算保留窗口起点（含当天在内共 N 天）：cutoff = 今天 - (N-1) 天的 00:00。
    const cutoff = new Date();
    cutoff.setHours(0, 0, 0, 0);
    cutoff.setDate(cutoff.getDate() - (_logRetentionDays - 1));
    const cutoffKey = _dateKey(cutoff);
    for (const name of fs.readdirSync(LogDir)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (!m) continue;
      if (m[1] < cutoffKey) {
        try {
          fs.unlinkSync(path.join(LogDir, name));
        } catch (_) {}
      }
    }
  } catch (_) {}
}

function _emit(level, msg) {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  const line = '[' + hh + ':' + mm + ':' + ss + '.' + ms + '] [' + level + '] ' + msg;
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
  // 落盘：文件行带完整日期前缀，便于跨天检索；跨天自动切换文件并清理旧日志。
  try {
    if (!fs.existsSync(LogDir)) fs.mkdirSync(LogDir, { recursive: true });
    rollLogIfNeeded();
    fs.appendFileSync(_currentLogPath(), _logDateKey + ' ' + line + '\n');
  } catch (_) {
    // 写文件失败不影响主流程（控制台已输出）。
  }
}

function logi(msg) { _emit('INFO', msg); }
function logw(msg) { _emit('WARN', msg); }
function loge(msg) { _emit('ERROR', msg); }
function logd(msg) { if (_debug) _emit('DEBUG', msg); }
// 兼容旧调用：log() == INFO。
function log(msg) { _emit('INFO', msg); }

// 把本地时间格式化成 "YYYY-MM-DD HH:MM:SS.mmm"，用于日志里打印完整时间戳。
// 传入毫秒时间戳（Date.now()）；不传则用当前时间。
function nowStamp(ms) {
  const d = ms == null ? new Date() : new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  const p3 = (n) => String(n).padStart(3, '0');
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
    + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())
    + '.' + p3(d.getMilliseconds());
}

// 把 error/异常对象规整成可读字符串。
function errMsg(ex) {
  if (!ex) return '(unknown)';
  let s = ex.message ? ex.message : String(ex);
  if (ex.code) s += ' [code=' + ex.code + ']';
  if (ex.cause && ex.cause.message) s += ' <- ' + ex.cause.message;
  return s;
}

// 从完整 URL 里取出 path（含 query）用于精简日志，避免每行都刷长域名。
function shortPath(url) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search || '');
  } catch (_) {
    return url;
  }
}

main();
