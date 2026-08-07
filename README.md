# MonkeyCode 登录保活守护程序（Node.js 版）

`monkeycode-ai.com` 自动登录 + 保活。与 `AutoLogin`（.NET 3.5 版）功能完全对齐，**零第三方依赖**，仅用 Node 内置模块（`fetch` / `WebSocket` / `crypto` / `fs`）。

## 环境要求
- Node.js **20+**（需内置 `fetch` 与全局 `WebSocket`；本机实测 v22 可用）。

## 运行

### 方式一：一键 bat（Windows，推荐）

双击 `start.bat` 即可用内置默认账号常驻运行；也可带参数：

```bat
start.bat                          :: 内置默认账号，常驻保活
start.bat 邮箱 密码                 :: 指定账号，常驻保活
start.bat 邮箱 密码 --test          :: 各执行一次刷新+发送后退出（验证用）
```

`start.bat` 会自动切到脚本目录、检查 Node 是否安装、并强制 UTF-8 输出（中文日志不乱码）。

### 方式二：命令行

```bash
# 常驻保活（推荐后台运行）
node index.js <email> <password>

# 各执行一次刷新 + 发送对话后退出（快速验证用）
node index.js <email> <password> --test
```

省略参数时使用内置默认账号。也可用 npm 脚本：

```bash
npm start                 # 常驻（用内置默认账号）
npm run test-once         # --test 模式
```

## 功能
1. **会话持久化**：登录成功后把会话 Cookie 以明文 JSON 写入 `session.json`（自动兼容 .NET 版写出的带 BOM 文件）。
2. **启动校验**：读取会话 → `GET /users/status` 校验 → 有效复用；过期则走完整登录（PoW 验证码 → redeem → password-login）后重新保存。
3. **两个随机定时保活循环**：
   - 每 **4~5 分钟**（随机）刷新一次：`status` / `tasks` / `wallet` / `subscription`。
   - 每 **13~15 分钟**（随机）向 AI 任务发送一次随机对话：优先向已有 `processing` 任务通过 WebSocket 发送；无可用任务则先创建新任务；WebSocket 失败降级为创建新任务。

## 发送内容
`randomContent()` 从「技术判断题」库随机组合（20 条真实技术命题 × 5 种问法），如「判断题：C# 中 struct 是值类型。请只回 1 或 0。」。要求对方只回 `1`（对）/`0`（错），把回复 token 压到最低以省积分；命题是正常的技术求证，口吻自然。天然不含违规词，避免触发 AI 端反滥用风控（含「保活」等字样会被拦截）。

## 登录协议（已抓包验证）
1. `POST /api/v1/public/captcha/challenge` → `{challenge:{c,s,d}, token}`
2. 本地暴力求解 cap.js 工作量证明（FNV-1a + xorshift32 生成 salt/target，SHA-256 搜 nonce）
3. `POST /api/v1/public/captcha/redeem` → 换取 captcha token
4. `POST /api/v1/users/password-login` → 携带 `email` / `password` / `captcha_token` 登录

## WebSocket 发送帧结构
- URL：`wss://monkeycode-ai.com/api/v1/users/tasks/stream?id={taskId}&mode=new`
- 帧：外层 `{"type":"user-input","data":BASE64(inner)}`，内层 `{"content":BASE64(utf8(text)),"attachments":[]}`
- 服务端应用层心跳 `{"type":"ping","data":null}` → 自动回 `{"type":"pong","data":null}`
