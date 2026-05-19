# SSH MCP Server 架构与技术文档

> ssh-mcp v1.5.0 | 作者: Tufan Tunc | [GitHub](https://github.com/tufantunc/ssh-mcp)

本文档涵盖 ssh-mcp 项目的整体架构、核心组件设计、数据流分析、SSH 连接稳定性问题诊断及改进建议。

---

## 目录

- [1. 项目概述](#1-项目概述)
- [2. 整体架构](#2-整体架构)
- [3. 核心组件详解](#3-核心组件详解)
- [4. 数据流详解](#4-数据流详解)
- [5. 测试架构](#5-测试架构)
- [6. SSH 连接稳定性分析](#6-ssh-连接稳定性分析)
- [7. 架构改进建议](#7-架构改进建议)
- [附录 A: ssh2 关键配置项](#附录-a-ssh2-关键配置项)

---

## 1. 项目概述

ssh-mcp 是一个基于 Model Context Protocol (MCP) 的服务器，将 SSH 远程命令执行能力暴露为标准化的 MCP 工具，使 LLM 客户端（Claude Desktop、Cursor、Claude Code 等）能够通过 AI 助手在远程服务器上执行 Shell 命令。

### 1.1 技术栈

| 类别 | 技术 | 版本/说明 |
|------|------|-----------|
| 运行时 | Node.js | >= 18, ES2022, ES Modules |
| 语言 | TypeScript | strict 模式, Node16 模块解析 |
| MCP SDK | `@modelcontextprotocol/sdk` | ^1.17.5 |
| SSH 客户端 | `ssh2` | ^1.17.0 |
| 参数校验 | `zod` | 3.23.8 (固定版本, MCP SDK 兼容性) |
| 测试框架 | Vitest | 集成测试 + Docker SSH 服务 |
| 传输协议 | stdio | JSON-RPC 2.0 over stdin/stdout |

### 1.2 代码结构

```
Z:\ssh-mcp\
├── src/
│   └── index.ts              ← 全部源码 (单文件, ~738 行)
├── test/
│   ├── description.test.ts    ← description 参数测试
│   ├── maxChars.test.ts       ← maxChars CLI 配置测试
│   ├── persistent-connection.test.ts ← 连接管理器集成测试
│   ├── smoke.ssh.test.ts      ← SSH 基础冒烟测试
│   ├── sudo-exec.test.ts      ← sudo/su 提权测试
│   └── zod.compat.test.ts     ← zod v3/v4 兼容性回归测试
├── package.json
├── tsconfig.json
├── docker-compose.yml         ← 测试用 SSH 服务器
└── README.md
```

### 1.3 运行模式

项目通过环境变量控制三种运行模式：

| 环境变量 | 模式 | 说明 |
|----------|------|------|
| (默认) | CLI 模式 | 验证 CLI 参数, 启动 MCP 服务器 |
| `SSH_MCP_TEST=1` | 测试模式 | 不阻塞于 su 提权, 自动启动服务器 |
| `SSH_MCP_DISABLE_MAIN=1` | 库模式 | 不自动启动服务器, 供单元测试导入 |

---

## 2. 整体架构

```
┌───────────────────┐
│    MCP Client      │  Claude Desktop / Cursor / Claude Code
│    (LLM)           │
└────────┬──────────┘
         │  JSON-RPC 2.0 over stdio
┌────────▼──────────┐
│    McpServer       │  @modelcontextprotocol/sdk
│  (Tool Registry)   │  注册 exec / sudo-exec 工具, Zod 参数校验
└────────┬──────────┘
         │
┌────────▼──────────┐
│ SSHConnection      │  持久连接管理, su 提权, 自动重连检测
│ Manager            │
└────────┬──────────┘
         │
┌────────▼──────────┐
│   ssh2 Client      │  SSH 协议实现, TCP 连接管理
└────────┬──────────┘
         │  SSH/TCP
┌────────▼──────────┐
│  Remote Server     │  Linux / Windows 目标服务器
└───────────────────┘
```

### 各层职责

| 层 | 职责 |
|----|------|
| **MCP Client** | 发送 tool call 请求, 接收执行结果 |
| **McpServer** | 工具注册, Zod schema 校验, 请求路由到处理函数 |
| **SSHConnectionManager** | 维护持久 SSH 连接, 管理连接生命周期, 处理 su 提权 |
| **ssh2 Client** | SSH 协议底层实现 (密钥交换, 加密, 通道复用) |
| **Remote Server** | 执行 Shell 命令, 返回输出 |

---

## 3. 核心组件详解

> 所有行号引用基于 `src/index.ts`

### 3.1 配置解析模块 (第 10-71 行)

CLI 参数解析函数 `parseArgv()` 将 `--key=value` 格式的命令行参数转换为配置对象:

| 参数 | 必需 | 默认值 | 说明 |
|------|------|--------|------|
| `--host` | 是 | - | SSH 服务器地址 |
| `--user` | 是 | - | SSH 用户名 |
| `--port` | 否 | 22 | SSH 端口 |
| `--password` | 否 | - | SSH 密码认证 |
| `--key` | 否 | - | SSH 私钥文件路径 |
| `--suPassword` | 否 | - | su 提权密码 |
| `--sudoPassword` | 否 | - | sudo 密码 (可与 suPassword 不同) |
| `--timeout` | 否 | 60000 | 命令执行超时 (毫秒) |
| `--maxChars` | 否 | 1000 | 命令最大字符数 (0/"none" 为无限制) |
| `--disableSudo` | 否 | false | 禁用 sudo-exec 工具 (flag 参数, 无值) |

`validateConfig()` 在 CLI 模式下验证 `host` 和 `user` 为必填项。

`MAX_CHARS` 解析逻辑 (第 47-57 行): 正整数 → 限制值; `0`/负数/`"none"` → `Infinity` (无限制); 默认 → 1000。

### 3.2 命令校验模块 (第 74-106 行)

**`sanitizeCommand(command)`** (第 74-93 行):
- 类型校验: 非字符串抛出 `InvalidParams`
- 空值检查: trim 后为空抛出异常
- 长度校验: 超过 `MAX_CHARS` 抛出异常
- 返回 trim 后的命令字符串

**`sanitizePassword(password)`** (第 95-100 行):
- 非字符串或空字符串返回 `undefined`

**`escapeCommandForShell(command)`** (第 103-106 行):
- 将单引号替换为 `'"'"'`, 用于 shell 上下文中的安全转义

### 3.3 SSH 连接管理器 (第 119-337 行)

`SSHConnectionManager` 是项目的核心组件, 管理持久 SSH 连接和 su 提权会话。

#### 类结构

```
SSHConnectionManager {
  - conn: Client | null           // ssh2 Client 实例
  - sshConfig: SSHConfig          // 连接配置
  - isConnecting: boolean         // 连接进行中标志
  - connectionPromise: Promise    // 并发连接去重
  - suShell: ClientChannel | null // su 提权交互式 shell
  - suPromise: Promise | null     // 并发提权去重
  - isElevated: boolean           // 是否已提权

  + connect(): Promise<void>               // 建立连接
  + isConnected(): boolean                 // 检查连接状态
  + ensureConnected(): Promise<void>       // 确保已连接 (自动重连)
  + getConnection(): Client                // 获取连接实例
  + close(): void                          // 关闭连接
  + getSudoPassword(): string | undefined  // 获取 sudo 密码
  + getSuPassword(): string | undefined    // 获取 su 密码
  + setSuPassword(pwd?: string): Promise<void> // 动态设置 su 密码
  - ensureElevated(): Promise<void>        // 执行 su 提权
}
```

#### 连接生命周期

```
                    connect() 调用
                         │
                    ┌────▼─────┐
                    │ new Client│
                    └────┬─────┘
                         │ conn.connect()
              ┌──────────┼──────────┐
              │          │          │
         ┌────▼───┐ ┌───▼────┐ ┌──▼───┐
         │ ready  │ │ error  │ │timeout│ (30s)
         └────┬───┘ └───┬────┘ └──┬───┘
              │          │         │
    ┌─────────▼──┐  reject   reject
    │ensureElevated│
    │(if suPassword)│
    └─────────┬──┘
              │
          resolve
```

**连接去重机制** (第 137-139 行): 通过 `isConnecting` 标志和 `connectionPromise` 确保并发调用 `connect()` 共享同一个连接尝试。

**`isConnected()` 检查** (第 201-203 行):
```typescript
isConnected(): boolean {
  return this.conn !== null
    && (this.conn as any)._sock
    && !(this.conn as any)._sock.destroyed;
}
```
访问 ssh2 Client 的内部 `_sock` 属性检查底层 TCP socket 状态。

### 3.4 su 提权机制 (第 231-311 行)

`ensureElevated()` 通过交互式 shell 执行 `su -` 提权:

```
conn.shell({ term: 'xterm', cols: 80, rows: 24 })
         │
    写入 "su -\n"
         │
    监听 data 事件
         │
   ┌─────▼──────┐
   │ buffer 累积 │
   └─────┬──────┘
         │
   匹配 /password[: ]/i ?
    ├── 是 → 写入密码, passwordSent = true
    └── 否 → 继续累积
         │
   (passwordSent 后)
   匹配 /#/ ?
    ├── 是 → 提权成功, 存储 shell
    └── 否 → 继续累积
         │
   匹配 /authentication failure|su: .*failed/i ?
    └── 是 → 提权失败, reject

   超时: 10 秒
```

**关键特性:**
- 交互式 PTY shell (xterm, 80x24)
- 密码提示检测: `/password[: ]/i`
- root 提示符检测: `/#/`
- 认证失败检测: `/authentication failure|incorrect password|su: .*failed|su: failure/i`
- 10 秒安全超时

### 3.5 MCP 工具注册

#### exec 工具 (第 350-418 行)

**参数:**
- `command` (z.string, 必需) — Shell 命令
- `description` (z.string, 可选) — 命令描述, 追加为注释

**处理流程:**
1. `sanitizeCommand()` 校验命令
2. 懒初始化 `connectionManager` (首次调用时创建)
3. `ensureConnected()` 确保连接活跃
4. 若配置了 `suPassword`, 等待 `ensureElevated()` (5 秒超时, 不阻塞主流程)
5. 拼接 description 注释
6. 调用 `execSshCommandWithConnection()` 执行

#### sudo-exec 工具 (第 420-497 行)

**参数:** 同 exec

**sudo 包装策略:**
- 无密码: `sudo -n sh -c 'command'` (需要 NOPASSWD sudoers 配置)
- 有密码: `printf '%s\n' 'pwd' | sudo -p "" -S sh -c 'command'`

### 3.6 命令执行引擎

#### execSshCommandWithConnection() (第 500-603 行)

使用持久连接执行命令, 有两条执行路径:

**路径 A — su Shell 模式** (第 517-551 行):
当 `manager.suShell` 存在时, 直接写入 su shell 执行:
```
shell.write(command + '\n')
    → 累积输出到 buffer
    → 等待 /#/ 匹配 (root 提示符)
    → 截取输出 (去掉首行 echo 和末行提示符)
    → resolve
```

**路径 B — 标准 exec 模式** (第 554-601 行):
使用 `conn.exec()` 创建干净的 exec 通道:
```
conn.exec(command, (err, stream) => {
    stream.on('data') → 累积 stdout
    stream.stderr.on('data') → 累积 stderr
    stream.on('close') → 有 stderr 则 reject, 否则 resolve
})
```

**超时控制:** `DEFAULT_TIMEOUT` 毫秒后 reject (默认 60 秒)。

#### execSshCommand() — 遗留函数 (第 606-693 行)

每次命令创建新连接 (非持久), 仅供测试使用。超时时尝试 `pkill` 终止远端进程。

### 3.7 服务器生命周期 (第 695-736 行)

```
main()
  │
  ├── new StdioServerTransport()
  ├── server.connect(transport)     ← 启动 MCP 服务
  │
  ├── process.on('SIGINT', cleanup)
  ├── process.on('SIGTERM', cleanup)
  └── process.on('exit', cleanup)   ← connectionManager.close()
```

优雅关闭: 关闭 su shell → 关闭 SSH 连接 → 置 null → exit(0)。

---

## 4. 数据流详解

### 4.1 exec 工具完整调用链

```
MCP Client
  │ POST tools/call { name: "exec", arguments: { command: "ls -la" } }
  ▼
McpServer
  │ Zod schema 校验参数
  ▼
exec handler (第 357-417 行)
  │
  ├── sanitizeCommand("ls -la") → "ls -la"
  │
  ├── (首次) 创建 SSHConnectionManager
  │     └── SSHConfig { host, port, username, password/privateKey }
  │
  ├── connectionManager.ensureConnected()
  │     ├── isConnected()? → true: 跳过
  │     └── isConnected()? → false: connect()
  │           ├── new Client()
  │           ├── conn.connect(sshConfig)
  │           └── on 'ready' → ensureElevated() (if suPassword)
  │
  ├── ensureElevated() (if suPassword, 5s 超时)
  │
  └── execSshCommandWithConnection(manager, "ls -la")
        ├── suShell 存在?
        │     └── 是: shell.write("ls -la\n") → 等待 # → 截取输出
        └── suShell 不存在
              └── conn.exec("ls -la") → 收集 stdout → resolve

  │
  ▼
McpServer → MCP Client
  { content: [{ type: "text", text: "total 32\ndrwxr-xr-x ..." }] }
```

### 4.2 sudo-exec 工具完整调用链

```
MCP Client
  │ POST tools/call { name: "sudo-exec", arguments: { command: "apt update" } }
  ▼
sudo-exec handler (第 429-496 行)
  │
  ├── sanitizeCommand("apt update")
  ├── ensureConnected()
  │
  ├── 构造 sudo 包装命令:
  │     无密码: "sudo -n sh -c 'apt update'"
  │     有密码: "printf '%s\n' 'pwd' | sudo -p '' -S sh -c 'apt update'"
  │
  └── execSshCommandWithConnection(manager, wrapper)
        └── conn.exec(wrapper) → 收集 stdout/stderr → resolve/reject
```

---

## 5. 测试架构

### 5.1 测试基础设施

- **框架:** Vitest
- **SSH 服务:** Docker 容器 (`lscr.io/linuxserver/openssh-server`), 端口 2222, 用户 `test`/密码 `secret`, sudo 权限
- **CI:** GitHub Actions (Ubuntu), 使用 services 启动 SSH Docker 容器

### 5.2 测试分类

| 测试文件 | 类型 | 覆盖范围 |
|----------|------|----------|
| `smoke.ssh.test.ts` | 集成 + 单元 | 基本 SSH echo 测试, `sanitizeCommand` 边界用例 |
| `persistent-connection.test.ts` | 集成 + 单元 | 连接生命周期, 重连, 并发, 顺序执行, 大输出, 特殊字符, 错误恢复 |
| `sudo-exec.test.ts` | 集成 | sudo 有/无密码, su 提权, 错误密码, root 验证 |
| `description.test.ts` | 集成 | description 参数功能 |
| `maxChars.test.ts` | 集成 | maxChars CLI 标志行为 (默认/自定义/none/0/非法值) |
| `zod.compat.test.ts` | 单元 | zod v3/v4 `_parse` 兼容性回归 (issue #10) |

### 5.3 测试模式机制

- `SSH_MCP_DISABLE_MAIN=1` — 阻止自动启动服务器, 允许单元测试导入模块
- `SSH_MCP_TEST=1` — 自动启动服务器, su 提权不阻塞连接建立

---

## 6. SSH 连接稳定性分析

> 本节诊断 SSH 连接频繁断开的根因, 按严重程度分级, 附带代码引用和修复建议。

### 6.1 致命问题

#### 问题 1: 无 SSH Keepalive 机制 (最关键)

**代码位置:** 第 195 行

```typescript
this.conn.connect(this.sshConfig);
```

`this.sshConfig` 只包含应用层字段 (`host`, `port`, `username`, `password`, `privateKey`), **从未配置** ssh2 的传输层 keepalive 选项。

**根因:** ssh2 库支持 `keepaliveInterval` 和 `keepaliveCountMax` 参数, 但 `SSHConfig` 接口 (第 109-117 行) 不包含这些字段, 也没有默认值。无 keepalive 意味着 SSH 连接在空闲期间不发任何数据包, 中间网络设备 (NAT 网关、有状态防火墙) 会在其空闲超时后 (通常 5-30 分钟) **静默丢弃** TCP 连接。

**影响:** 任何超过网络设备空闲超时的不活动期都会导致不可恢复的连接断开。这是 **最频繁的断连原因**。

**修复建议:**

```typescript
// 在 connect() 中为 ssh2 Client 传入 keepalive 配置
this.conn.connect({
  ...this.sshConfig,
  keepaliveInterval: 15000,  // 每 15 秒发送一次 keepalive
  keepaliveCountMax: 3,      // 连续 3 次无响应视为断连
});
```

同时扩展 `SSHConfig` 接口或硬编码默认值。

---

#### 问题 2: 无自动重连机制

**代码位置:** 第 181-193 行

```typescript
this.conn.on('end', () => {
  console.error('SSH connection ended');
  this.conn = null;
  this.isConnecting = false;
  this.connectionPromise = null;
});

this.conn.on('close', () => {
  console.error('SSH connection closed');
  this.conn = null;
  this.isConnecting = false;
  this.connectionPromise = null;
});
```

**根因:** `end` 和 `close` 事件处理器仅执行日志和状态清理, **没有任何重连逻辑**。连接断开后, 只在下一次工具调用触发 `ensureConnected()` 时才重新连接。

**影响:**
- 断连后的第一条命令必须等待完整的 TCP 连接 + SSH 握手 (可能 1-5 秒)
- 如果 su 提权配置了, 还要额外等待 su 密码交互 (又 1-3 秒)
- 用户体验上表现为"间歇性延迟"或"偶尔超时"

**修复建议:**

```typescript
private reconnectAttempts = 0;
private maxReconnectAttempts = 5;
private reconnectTimer: NodeJS.Timeout | null = null;

private handleDisconnect() {
  this.conn = null;
  this.isConnecting = false;
  this.connectionPromise = null;
  this.resetSuState();
  this.scheduleReconnect();
}

private scheduleReconnect() {
  if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
  const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
  this.reconnectTimer = setTimeout(() => {
    this.reconnectAttempts++;
    this.connect()
      .then(() => { this.reconnectAttempts = 0; })
      .catch(() => this.scheduleReconnect());
  }, delay);
}
```

---

#### 问题 3: 断连后 su Shell 状态未重置

**代码位置:** 第 181-193 行 vs 第 124-126 行

**根因:** `end`/`close` 事件处理器将 `conn` 置 `null`, 但 **未重置** `suShell`、`isElevated`、`suPromise`。su shell 是 SSH 连接的子通道 — TCP 连接断开后, shell 流对象虽然仍被引用, 但实际已失效。

**影响:** 重连后, `execSshCommandWithConnection()` (第 506 行) 检查 `const shell = (manager as any).suShell`。如果 `suShell` 非 null (因未被重置), 会尝试向已死的流写入命令, 导致:
- 命令静默丢失 (写入成功但无响应)
- 或抛出不可预测的 EPIPE / ENOTCONN 错误
- 表现为"命令挂起"或"无输出"

**修复建议:** 在 `end`/`close` 处理器中增加状态重置:

```typescript
private resetSuState() {
  if (this.suShell) {
    try { this.suShell.end(); } catch (e) { /* ignore */ }
  }
  this.suShell = null;
  this.isElevated = false;
  this.suPromise = null;
}

this.conn.on('close', () => {
  console.error('SSH connection closed');
  this.conn = null;
  this.isConnecting = false;
  this.connectionPromise = null;
  this.resetSuState();  // ← 关键: 重置 su 状态
});
```

---

#### 问题 4: su Shell 提示符检测不可靠

**代码位置:** 第 274 行 (ensureElevated) 和第 526 行 (execSshCommandWithConnection)

```typescript
if (/#/.test(buffer)) { ... }
```

**根因:** 正则 `/#/` 匹配缓冲区中 **任意位置** 的 `#` 字符, 包括:
- Shell 注释: `echo "hello" # comment`
- 配置文件内容: `# This is a config`
- 十六进制颜色码: `color: #ff0000`
- URL 锚点: `http://example.com/page#section`
- 命令行号工具输出

**影响:**
- **`ensureElevated()` 中**: su 密码输入后, 如果密码回显或错误信息包含 `#`, 会误判为提权成功, 导致后续命令以非 root 身份执行
- **`execSshCommandWithConnection()` 中**: 命令输出中的 `#` 被误判为命令结束提示符, 导致输出被截断

**修复建议:** 设置唯一的 PS1 提示符标记:

```typescript
// 提权成功后, 设置唯一提示符
stream.write('export PS1="SSH_MCP_READY# "\n');

// 用精确的正则匹配
if (/SSH_MCP_READY#/.test(buffer)) { ... }
```

---

### 6.2 中等问题

#### 问题 5: su Shell 并发竞态条件

**代码位置:** 第 131-170 行 (connect) 和第 389-403 行 (exec handler)

**分析:** 生产模式下, `connect()` 在 `ready` 事件中调用 `ensureElevated()` (第 163 行)。但如果多条命令在重连期间并发到达, `connectionPromise` 去重保证只有一个连接尝试, 但连接就绪后, 每个命令处理器独立调用 `ensureElevated()` (第 394 行)。虽然 `suPromise` 去重 (第 235 行) 防止并发提权, 但在连接就绪到提权完成之间, su shell 处于不确定状态。

**修复建议:** 将提权纳入连接 Promise 链, 或添加互斥锁保护 su shell 访问。

#### 问题 6: 无重试/退避策略

**代码位置:** 第 145-151 行 (连接超时)

**分析:** 连接失败直接 reject Promise, 无重试逻辑。对于瞬态网络故障 (DNS 解析延迟、服务器临时拒绝连接), 单次失败不应导致永久错误。

**修复建议:**

```typescript
async connectWithRetry(maxRetries = 3, baseDelay = 1000): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await this.connect();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, attempt)));
    }
  }
}
```

#### 问题 7: isConnected() 访问私有属性

**代码位置:** 第 201-203 行

```typescript
return this.conn !== null
  && (this.conn as any)._sock
  && !(this.conn as any)._sock.destroyed;
```

**分析:** `_sock` 是 ssh2 Client 的内部属性, 不属于公开 API, 可能在库升级中被重命名或移除。`as any` 转换绕过了 TypeScript 类型检查。

**修复建议:** 通过事件追踪连接状态:

```typescript
private connected = false;

// on 'ready' → this.connected = true
// on 'end'/'close' → this.connected = false

isConnected(): boolean {
  return this.conn !== null && this.connected;
}
```

#### 问题 8: sudo-exec 密码更新使用不安全的类型转换

**代码位置:** 第 469 行

```typescript
(connectionManager as any).sshConfig = {
  ...(connectionManager as any).sshConfig,
  sudoPassword: sanitizePassword(SUDOPASSWORD)
};
```

**分析:** 通过 `as any` 直接修改私有 `sshConfig`, 绕过封装。

**修复建议:** 为 `SSHConnectionManager` 添加 `setSudoPassword()` 方法, 类似已有的 `setSuPassword()` (第 213 行)。

---

### 6.3 断连问题影响链

当 SSH 连接断开时, 各问题的叠加效应:

```
网络空闲超时 / 服务端重启 / 防火墙规则变更
         │
    TCP 连接被丢弃
         │
    ┌────▼────────────────────────────┐
    │ SSH 连接断开                      │
    │ conn.on('close') 触发             │
    │ conn = null                       │
    │ 但 suShell 仍指向死流 (问题 3)     │
    └────┬────────────────────────────┘
         │
    下一条命令到达
         │
    ┌────▼────────────────────────────┐
    │ ensureConnected() 检测到断连     │
    │ 重新 connect() (无退避, 问题 6)  │
    │ 耗时: TCP + SSH 握手 + 认证       │
    └────┬────────────────────────────┘
         │
    ┌────▼────────────────────────────┐
    │ 连接就绪, 检查 suShell          │
    │ suShell !== null (未重置!)       │
    │ 向死流写入命令 → 无响应/错误     │
    │ 命令挂起或超时 (问题 3 叠加)     │
    └────┬────────────────────────────┘
         │
    ┌────▼────────────────────────────┐
    │ 即使修复问题 3, 仍需:            │
    │ 重新 su 提权 (问题 2)            │
    │ 密码交互 → 可能误判 (问题 4)     │
    └─────────────────────────────────┘
```

### 6.4 修复优先级

| 优先级 | 问题 | 修复难度 | 预期效果 |
|--------|------|----------|----------|
| **P0** | 无 keepalive (问题 1) | 低 (3 行代码) | 消除 80%+ 的空闲断连 |
| **P0** | su shell 状态未重置 (问题 3) | 低 (5 行代码) | 消除断连后的死流写入 |
| **P1** | 无自动重连 (问题 2) | 中 | 减少断连后的命令延迟 |
| **P1** | 提示符检测不可靠 (问题 4) | 中 | 消除输出截断和误判 |
| **P2** | 竞态条件 (问题 5) | 中 | 提高并发可靠性 |
| **P2** | 无重试退避 (问题 6) | 低 | 提高瞬态故障恢复能力 |
| **P3** | 私有属性访问 (问题 7) | 低 | 提高库升级兼容性 |
| **P3** | 不安全类型转换 (问题 8) | 低 | 提高代码健壮性 |

---

## 7. 架构改进建议

### 7.1 文件拆分

当前单文件架构 (~738 行) 在小型项目中可接受, 但随着功能增长建议拆分:

```
src/
├── config.ts          ← parseArgv(), validateConfig(), SSHConfig
├── ssh-manager.ts     ← SSHConnectionManager class
├── command-runner.ts  ← execSshCommandWithConnection(), execSshCommand()
├── utils.ts           ← sanitizeCommand(), escapeCommandForShell()
├── tools/
│   ├── exec.ts        ← exec 工具注册和 handler
│   └── sudo-exec.ts   ← sudo-exec 工具注册和 handler
└── server.ts          ← McpServer 初始化, main()
```

### 7.2 连接状态机

替换当前的 ad-hoc 布尔标志 (`isConnecting`, `isElevated`) 为显式状态机:

```
DISCONNECTED ──connect()──→ CONNECTING ──ready──→ CONNECTED
                                ↑                     │
                                │              ensureElevated()
                                │                     │
                                │                     ▼
                                │              ELEVATING ──success──→ ELEVATED
                                │                     │
                                └───── (error/close) ─┘
```

状态机保证状态转换的合法性和可预测性, 消除竞态条件。

### 7.3 结构化日志

将 `console.error` 替换为结构化日志 (如 `pino`), 支持日志级别配置:

```typescript
import pino from 'pino';
const logger = pino({ level: process.env.SSH_MCP_LOG_LEVEL || 'info' });

// 连接事件
logger.info({ host, port }, 'SSH connection established');
logger.warn({ err }, 'SSH connection lost, scheduling reconnect');
```

### 7.4 连接健康检查

添加定期健康检查, 主动检测连接存活性:

```typescript
private healthCheckInterval: NodeJS.Timeout | null = null;

startHealthCheck(intervalMs = 30000) {
  this.healthCheckInterval = setInterval(() => {
    if (!this.isConnected()) {
      this.handleDisconnect();
    }
  }, intervalMs);
}
```

---

## 附录 A: ssh2 关键配置项

以下 `ssh2.Client.connect()` 选项对本项目尤为重要:

| 选项 | 类型 | 说明 | 当前状态 |
|------|------|------|----------|
| `keepaliveInterval` | number | keepalive 请求间隔 (ms) | **未配置** |
| `keepaliveCountMax` | number | 最大连续失败 keepalive 次数 | **未配置** |
| `readyTimeout` | number | SSH 握手超时 (ms) | 默认 20000 |
| `algorithms` | object | 加密算法配置 | 默认 |
| `compress` | boolean | 启用压缩 | 默认 false |

**推荐配置:**

```typescript
{
  keepaliveInterval: 15000,   // 15 秒 keepalive
  keepaliveCountMax: 3,       // 3 次失败后断连
  readyTimeout: 30000,        // 30 秒握手超时 (与当前连接超时一致)
}
```
