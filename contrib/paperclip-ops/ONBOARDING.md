# Paperclip 试用上手指南（Luobu 内部版)

把 Jira 工单自动同步进本地 Paperclip，让 Cursor agent 接单干活。照做约 20 分钟可跑通。

## 前置条件

- macOS,Node.js ≥ 20(`node --version`),npm。
- 一个 `roblox.atlassian.net` 的 Jira 账号。
- Cursor CLI:`curl https://cursor.com/install -fsS | bash`,然后 `agent login` 登录你自己的 Cursor 账号。记下 `which agent` 的输出(通常是 `~/.local/bin/agent`)。

## 1. 安装 Paperclip 试用包

```bash
npm install -g https://github.com/TaoXieSZ/paperclip/releases/download/trial-2026.10.14-1/paperclipai-0.3.1.tgz
```

- npm 慢就在命令末尾加 `--registry=https://registry.npmmirror.com`。
- 如果第 3 步 `paperclipai run` 报 embedded postgres 初始化失败,先执行 `npm config set allow-scripts=@embedded-postgres/darwin-arm64 --location=user`,再重装一次。

## 2. 启动实例

```bash
paperclipai onboard --yes
paperclipai service install && paperclipai service start
```

预期输出 `paperclipai --version` 为 `0.3.1`,浏览器打开 `http://127.0.0.1:3100` 能看到界面。数据都在 `~/.paperclip/instances/default/`,删除该目录即完全卸载。

## 3. 建公司和 Cursor agent

1. 打开 `http://127.0.0.1:3100`,按向导建一家公司,记下工单前缀(如 `TAO`)。
2. 在 Agents 页雇一个 agent。Adapter 在 "more adapters" 里选 **Cursor CLI harness**(`adapterType: "cursor"`)。
3. Command 填 `which agent` 的绝对路径(例如 `/Users/<你>/.local/bin/agent`)。不要用裸 `agent`:launchd 服务的 PATH 里没有它。
4. Model 默认 `auto` 即可。没有配 `CURSOR_API_KEY` 时,agent 运行消耗你的 Cursor 订阅额度。

验证:给这个 agent 派一张小工单(如"回复你用的什么 harness 然后标 done"),看它能否完成。

## 4. 装 ops 套件(Jira 同步 + 界面按钮)

```bash
git clone --depth 1 -b luobu-trial https://github.com/TaoXieSZ/paperclip.git
cd paperclip/contrib/paperclip-ops
mkdir -p ~/scripts ~/bin
cp scripts/*.py ~/scripts/ && cp bin/pc-api ~/bin/ && chmod +x ~/bin/pc-api
```

### 4.1 放 Jira cookie

同步脚本读 `/Users/txie/roblox-ghc/CeLLM/tokens/atlassian/session.env`。你没有这个文件,自建一个(路径随意,然后改 `~/scripts/paperclip-jira-sync.py` 顶部的 `SESSION_ENV` 指向它):

```
ATLASSIAN_SESSION_COOKIE=<你的 cloud.session.token>
ATLASSIAN_SITE=https://roblox.atlassian.net
```

取 cookie:Chrome 登录 Jira 后,F12 → Application → Cookies → 复制 `cloud.session.token` 的值。过期后同步会报 401,重新取一次即可。

### 4.2 装界面按钮

先查两个 id:

```bash
~/bin/pc-api GET /api/companies            # 取公司 id
~/bin/pc-api GET /api/companies/<公司id>/agents   # 取 agent id
```

然后装 routine(就是 Routines 页那个可以点 Run 的"同步 Jira 工单"按钮):

```bash
PAPERCLIP_COMPANY_ID=<公司id> SYNC_AGENT_ID=<agent id> python3 ~/scripts/setup-jira-sync-routine.py
```

### 4.3 定时任务(可选)

编辑 `launchd/*.plist`:把 `/Users/txie` 换成你的 home,把 `PAPERCLIP_COMPANY_ID` 换成你的公司 id。然后:

```bash
cp launchd/*.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tao.paperclip-jira-sync.plist
```

三个任务分别是:15 分钟 Jira 同步、15 分钟 workspace reconcile、每天 09:30 摘要。不需要哪个就不装哪个。

## 5. 验证

1. 手动跑一次同步:`PAPERCLIP_COMPANY_ID=<公司id> /usr/bin/python3 ~/scripts/paperclip-jira-sync.py sync`,预期末尾输出 `sync done created=N closed=0 skipped=M`。
2. 打开 `http://127.0.0.1:3100/<前缀>/issues`,能看到 `[LUOB-xxxx]` 标题的工单。
3. 打开 `http://127.0.0.1:3100/<前缀>/routines`,点 **同步 Jira 工单** 的 **Run**,几分钟后对应的执行工单标 done,评论里有同步结果。

## 可选功能

- **Decisions desk**(待办聚合页,推荐开):`~/bin/pc-api PATCH /api/instance/settings/experimental '{"enableDecisions":true}'`,然后访问 `/<前缀>/decisions`。
- **每日摘要**:编辑 `~/.claude/flomo-config.json` 放入 flomo API URL(`{"api_url": "https://flomoapp.com/iwh/..."}`),digest 任务会把每天待办推到手机。
- **workspace-manager 集成**:如果你用 wm 的 Agent Workspace,`paperclip-workspace-sync.py` 会把每个 workspace 变成一个 paperclip project + 专属 agent。不需要可以忽略。

## 排障

| 症状 | 原因和处理 |
|---|---|
| `npm install` 卡死或极慢 | npmjs 直连问题,加 `--registry=https://registry.npmmirror.com` |
| 启动报 embedded postgres 失败 | postinstall 被拦,见第 1 步的 allow-scripts 处理 |
| 同步报 401 | cookie 过期,重新按 4.1 取一次 |
| agent 不执行,工单一直 todo | agent 的 command 不是绝对路径,或 `agent` 未登录;改 agent 配置后重派 |
| 评论发了但 agent 不响应 | 工单被 executionBlocker 卡住(取消过 run)。让有权限的人走 recovery-actions resolve,或把 issue 发给维护者处理 |
| 想彻底重来 | `paperclipai service stop`,删 `~/.paperclip`,从第 2 步重做 |

## 说明

- 试用包含一个我们修的 UI 恢复列表 bug(上游 PR [paperclipai/paperclip#16169](https://github.com/paperclipai/paperclip/pull/16169)),上游正式版发布后建议换回官方包。
- agent 每次运行消耗你的 Cursor 额度。15 分钟定时同步是免费脚本,不走 agent。
- 问题和报错直接丢给 txie。
