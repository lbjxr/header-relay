# Header Relay

为 9router upstreams 提供安全的 HTTP Header 转发与兼容层服务。

## 功能

- **认证转发**：通过 `/forward/{token}` 提供带认证的请求转发，基于 `targets.json` 中的规则分发到多个上游中转站。
- **Legacy 路由**：支持基于配置的路由前缀直接转发，兼容现有接入方式。
- **客户端兼容**：内置 Codex / Claude 的 Header 兼容层，可自动标准化请求头与请求体。
- **健康检查**：提供 `/health` 和 `/ready` 接口，便于服务发现和就绪探测。
- **9router 同步**：通过 Python 同步脚本读取 9router 数据库，自动生成/更新 `targets.json` 与绑定关系。
- **可观测性**：结构化 JSON 日志，输出请求 ID、目标规则、状态码与耗时。

## 系统要求

- Node.js >= 18（使用 `node:http`、`AbortSignal`、`crypto` 等内置模块）
- Python 3.10+（仅用于同步脚本）
- Linux systemd（生产部署推荐）

## 快速开始

### 1. 克隆仓库

```bash
git clone git@github-lbjxr:lbjxr/header-relay.git
cd header-relay
```

### 2. 配置

复制样例配置并填写实际值：

```bash
cp config.example.json config.json
```

关键配置项说明：

| 字段 | 说明 |
|------|------|
| `listen.host` / `listen.port` | 服务监听地址，默认 `127.0.0.1:20130` |
| `forward.enabled` | 是否启用 `/forward` 认证转发 |
| `forward.pathPrefix` | 转发路径前缀，默认 `/forward` |
| `forward.tokenFile` | 存放有效 token 的文件路径 |
| `forward.targetsFile` | 上游目标规则文件路径，默认 `/var/lib/header-relay/targets.json` |
| `forward.profilesDir` | Header 兼容模板目录 |
| `forward.maxBufferedRequests` | 缓冲并发请求数上限 |
| `forward.maxBufferedBytes` | 缓冲总字节数上限 |
| `forward.upstreamHeaderTimeoutMs` | 上游响应头超时时间 |
| `forward.streamIdleTimeoutMs` | 流空闲超时时间 |
| `sync.dbPath` | 9router SQLite 数据库路径 |
| `sync.managedProxyPoolId` | 9router 托管的代理池 ID |
| `sync.intervalSeconds` | 自动同步间隔（秒） |
| `routes` | Legacy 路由规则列表，支持 `name`、`prefix`、`target`、`setHeaders`、`removeHeaders`、`codexCompat` |

### 3. 准备 token 文件

```bash
echo "your-secure-token" > /var/lib/header-relay/token
chmod 600 /var/lib/header-relay/token
```

### 4. 启动服务

**直接运行（开发环境）：**

```bash
node server.mjs
```

**使用 systemd（生产环境）：**

```bash
cp etc/systemd/system/header-relay.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now header-relay.service
```

## 请求方式

### 认证转发（推荐）

```bash
curl -X POST https://relay-host/forward/your-secure-token/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}'
```

### Legacy 路由

根据 `config.json` 中的 `routes` 配置直接访问对应前缀：

```bash
curl -X POST http://127.0.0.1:20130/hybgzs/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}'
```

### 健康检查

```bash
curl http://127.0.0.1:20130/health
curl http://127.0.0.1:20130/ready
```

## 与 9router 同步

### 应用同步

```bash
python3 scripts/sync-9router-relay.py --config /opt/header-relay/config.json --apply
```

### 仅验证

```bash
python3 scripts/sync-9router-relay.py --config /opt/header-relay/config.json
```

### 回滚 managed 绑定

```bash
python3 scripts/sync-9router-relay.py --config /opt/header-relay/config.json --rollback-managed
```

### 指定连接 ID 同步

```bash
python3 scripts/sync-9router-relay.py --config /opt/header-relay/config.json --apply --only-connection-id <connection-id>
```

## Profiles

`profiles/` 目录下预置了以下 Header 兼容模板：

| Profile ID | 客户端 | 模式 |
|------------|--------|------|
| `claude-headers-v1` | Claude CLI | passthrough-buffered |
| `claude-safe-v1` | Claude CLI | passthrough-stream |
| `codex-full-v1` | Codex CLI | codex-responses |
| `codex-headers-v1` | Codex CLI | passthrough-buffered |

在 `routes` 中可通过 `codexCompat` 启用 Codex 自动标准化。

## 目录结构

```
header-relay/
  server.mjs                # 入口：HTTP 服务器与路由分发
  codex-compat.mjs          # Codex 请求标准化
  config.example.json       # 脱敏样例配置
  package.json              # 项目元信息
  codex-instructions.txt    # Codex 指令文件
  lib/
    body-buffer.mjs          # 请求体缓冲与限制
    config-snapshot.mjs      # 配置热加载
    errors.mjs               # 错误定义
    forward-handler.mjs      # /forward 认证转发处理
    header-utils.mjs         # Header 工具函数
    profile-registry.mjs     # Profiles 注册与匹配
    streaming.mjs            # 流式转发
    target-registry.mjs      # 目标规则校验与解析
  profiles/                  # Header 兼容模板
  scripts/                   # 9router 同步与迁移脚本
```

## 日志

systemd 部署下日志默认输出到：

```bash
journalctl -u header-relay.service -f
```

或直接查看日志文件：

```bash
tail -f /var/log/header-relay/header-relay.log
```

## 安全注意事项

- `config.json` 包含敏感路径与 token，请勿提交到版本库。
- 生产环境建议将 `listen.host` 绑定到内网地址或前级反向代理。
- `tokenFile` 应设置为权限 `600` 的文件。
- 如无需 Legacy 路由，可在 `config.json` 中移除以减少攻击面。

## License

MIT
