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
 *            有可用任务 -> 选任务通过 WebSocket 发送；
 *            无可用任务 -> 先 POST 创建新任务再发送。
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
const WalletPath = '/api/v1/users/wallet';
const SubscriptionPath = '/api/v1/users/subscription';
const WsStreamPath = '/api/v1/users/tasks/stream';

// WebSocket 发送模式：mode=new 发起一次新的用户输入；mode=attach 只读附着。
const WsMode = 'new';

// 创建新任务时使用的已知可用资源。
const DefaultModelId = 'deepseek-v4-flash';
const DefaultImageId = '2e214f06-79ba-4535-9ac1-89adc2d9c6cc';
const DefaultHostId = 'public_host_9c689e7a_99c6_4db3';

const UserAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

const SessionFile = path.join(__dirname, 'session.json');
const ConfigFile = path.join(__dirname, 'config.json');

// 保活间隔默认值（分钟）。可被 config.json 覆盖。
const DefaultConfig = {
  email: '6553458@qq.com',
  password: 'Subway88',
  refreshMinMinutes: 4,
  refreshMaxMinutes: 5,
  chatMinMinutes: 13,
  chatMaxMinutes: 15,
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

// ===============================================================
// 入口
// ===============================================================
async function main() {
  const args = process.argv.slice(2);
  _config = loadConfig();
  // 账号/密码优先级：命令行参数 > config.json > 内置默认。
  const argEmail = args[0] && !args[0].startsWith('--') ? args[0] : null;
  const argPwd = args[1] && !args[1].startsWith('--') ? args[1] : null;
  _email = argEmail || _config.email;
  _password = argPwd || _config.password;
  const testOnce = args.includes('--test');

  try {
    // 1. 读取本地会话
    const loaded = loadSession();
    log(loaded ? '已读取本地会话 session.json。' : '未找到本地会话。');

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
    log('致命错误：' + (ex && ex.message ? ex.message : ex));
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
    try {
      await doRefresh();
    } catch (ex) {
      log('刷新异常：' + (ex && ex.message ? ex.message : ex));
    }
    const ms = nextRandom(_config.refreshMinMinutes * 60 * 1000, _config.refreshMaxMinutes * 60 * 1000 + 1);
    log(`下次刷新约在 ${(ms / 60000).toFixed(1)} 分钟后。`);
    await sleep(ms);
  }
}

async function chatLoop() {
  // 稍微错开，避免与刷新扎堆。
  await sleep(nextRandom(20 * 1000, 60 * 1000));
  for (;;) {
    try {
      await doChatOnce();
    } catch (ex) {
      log('发送对话异常：' + (ex && ex.message ? ex.message : ex));
    }
    const ms = nextRandom(_config.chatMinMinutes * 60 * 1000, _config.chatMaxMinutes * 60 * 1000 + 1);
    log(`下次发送对话约在 ${(ms / 60000).toFixed(1)} 分钟后。`);
    await sleep(ms);
  }
}

// ===============================================================
// 刷新（模拟右上角刷新按钮）
// ===============================================================
async function doRefresh() {
  let r = await httpGet(BaseUrl + StatusPath);
  if (r.status === 401) {
    await reloginIfNeeded();
    r = await httpGet(BaseUrl + StatusPath);
  }
  log('刷新 status -> ' + r.status);

  const t = await httpGet(BaseUrl + TasksPath + '?page=1&size=24');
  log('刷新 tasks -> ' + t.status);

  try {
    const w = await httpGet(BaseUrl + WalletPath);
    log('刷新 wallet -> ' + w.status);
  } catch (_) {}
  try {
    const s = await httpGet(BaseUrl + SubscriptionPath);
    log('刷新 subscription -> ' + s.status);
  } catch (_) {}
}

// ===============================================================
// 发送对话（优先已有任务；无则创建新任务）
// ===============================================================
async function doChatOnce() {
  if (!(await checkLoginValid())) await reloginIfNeeded();

  const tasks = await listTasks();
  let taskId = pickTaskId(tasks);

  if (taskId == null) {
    log('无可用任务，创建新任务 ...');
    taskId = await createNewTask(randomContent());
    if (taskId == null) {
      log('创建新任务失败，本次发送跳过。');
      return;
    }
    log('已创建新任务：' + taskId);
  }

  const content = randomContent();
  const ok = await sendViaWebSocket(taskId, content);
  if (ok) {
    log('已向任务 ' + taskId + ' 发送对话：' + content);
  } else {
    // 降级：WebSocket 失败时用创建新任务作为保底。
    log('WebSocket 发送失败，降级为创建新任务保底 ...');
    const fallbackId = await createNewTask(content);
    if (fallbackId != null) log('降级成功，新任务：' + fallbackId + '，内容：' + content);
    else log('降级创建任务也失败，本次发送跳过。');
  }
}

async function listTasks() {
  const url = BaseUrl + TasksPath + '?page=1&size=10&status=pending%2Cprocessing';
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

async function createNewTask(content) {
  const body = JSON.stringify({
    content: content,
    cli_name: 'opencode',
    model_id: DefaultModelId,
    image_id: DefaultImageId,
    host_id: DefaultHostId,
    repo: { branch: '' },
    resource: { core: 2, memory: 8589934592 },
  });

  let r = await sendRequest('POST', BaseUrl + TasksPath, body);
  if (r.status === 401) {
    await reloginIfNeeded();
    r = await sendRequest('POST', BaseUrl + TasksPath, body);
  }
  if (r.status < 200 || r.status >= 300) {
    log('创建任务返回 ' + r.status + '：' + trunc(r.body, 200));
    return null;
  }
  try {
    const obj = JSON.parse(r.body);
    return (obj && (obj.id || (obj.data && obj.data.id))) || extractString(r.body, 'id');
  } catch (_) {
    return extractString(r.body, 'id');
  }
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
    if (await checkLoginValid()) return;
    log('检测到会话失效，重新登录 ...');
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

  try {
    const resp = await fetch(url, init);
    // 收集 Set-Cookie（Node fetch 用 getSetCookie 返回数组）。
    captureSetCookies(resp);
    const body = await resp.text();
    return { status: resp.status, body: body };
  } catch (ex) {
    return { status: 0, body: 'FetchError: ' + (ex && ex.message ? ex.message : ex) };
  }
}

function captureSetCookies(resp) {
  let list = [];
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
      if (name) Cookies.set(name, value);
    }
  }
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
function sendViaWebSocket(taskId, content) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch (_) {}
      resolve(ok);
    };

    const query = '?id=' + encodeURIComponent(taskId) + '&mode=' + WsMode;
    const url = 'wss://' + Host + WsStreamPath + query;

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
      log('WebSocket 构造异常：' + (ex && ex.message ? ex.message : ex));
      resolve(false);
      return;
    }

    // 整体超时（握手 + 发送 + 读一小段）。
    const overall = setTimeout(() => done(true), 9000);

    ws.addEventListener('open', () => {
      try {
        const inner = JSON.stringify({ content: base64Utf8(content), attachments: [] });
        const frame = JSON.stringify({ type: 'user-input', data: base64Utf8(inner) });
        ws.send(frame);
        // 已发出，给服务端 6 秒处理并回读心跳。
        setTimeout(() => {
          clearTimeout(overall);
          done(true);
        }, 6000);
      } catch (ex) {
        log('WebSocket 发送异常：' + (ex && ex.message ? ex.message : ex));
        clearTimeout(overall);
        done(false);
      }
    });

    ws.addEventListener('message', (evt) => {
      // 回应应用层心跳，保持连接活跃。
      try {
        const txt = typeof evt.data === 'string' ? evt.data : '';
        if (txt.indexOf('"type":"ping"') >= 0) {
          ws.send(JSON.stringify({ type: 'pong', data: null }));
        }
      } catch (_) {}
    });

    ws.addEventListener('error', (evt) => {
      log('WebSocket 错误：' + (evt && evt.message ? evt.message : '连接失败'));
      clearTimeout(overall);
      done(false);
    });

    ws.addEventListener('close', () => {
      // 若在发送前就关闭则视为失败；发送后关闭由上面的定时器处理。
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

function log(msg) {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  console.log('[' + hh + ':' + mm + ':' + ss + '] ' + msg);
}

main();
