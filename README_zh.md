> 注意：中文文档目前不是完整翻译，当前以 [README.md](README.md)、[AGENTS.md](AGENTS.md)、[docs/README.md](docs/README.md) 和实际运行时代码为准。

<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

## 当前状态

NanoClaw 现在是一个以 OpenAI 为核心运行时的本地优先助手宿主：

- 每个群组在独立容器中运行
- 宿主机负责 SQLite、调度、IPC、凭据代理和本地 UI
- 主运行时使用 OpenAI Responses API
- 主记忆文件为 `AGENTS.md`
- 旧的 `CLAUDE.md` 仅作为兼容回退

## 当前主要界面

主要页面：

- `Today`
- `Inbox`
- `Work`
- `Review`

次要页面：

- `Calendar`
- `Reports`
- `History`
- `Connections`
- `Admin`

## 当前能力概览

- 容器隔离的群组运行时
- 本地调度任务
- 本地 Operator UI
- 本地 UAT channel
- Google / Microsoft / Jira / Slack 的 personal-ops 集成
- 个人工作流视图：Today、Inbox、Work、Review
- host-only personal-ops 存储与账户上下文学习

## 快速开始

```bash
git clone https://github.com/jetracks/nanoclaw.git
cd nanoclaw
cp .env.example .env
source "$HOME/.nvm/nvm.sh" && nvm use
npm ci
npm run build
./container/build.sh
npm start
```

至少需要设置：

```bash
OPENAI_API_KEY=...
```

## 推荐阅读

- [README.md](README.md)
- [docs/README.md](docs/README.md)
- [docs/SECURITY.md](docs/SECURITY.md)
- [docs/PERSONAL_OPS_ASSISTANT.md](docs/PERSONAL_OPS_ASSISTANT.md)

如果以后需要完整中文翻译，建议基于当前英文 README 重新翻译，而不是继续沿用旧的 Claude 时代文档。
