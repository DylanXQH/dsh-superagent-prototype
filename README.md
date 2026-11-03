# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

## 项目说明

dsh-superagent 是一个面向**单个 GitHub 仓库**的主动式编码 agent，以 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 扩展包（bundle）的形式发布。它监听 GitHub，并可选接入飞书：当授权的人请它做事时，它会把请求变成一张工单（Ticket），在独立的 agent 会话和工作目录中完成工作，然后回到原对话交付结果，例如一个 pull request。Web 面板只显示需要人处理的事项。

它同时也是一种与 agent 协作的方式：**尽可能少占用人的注意力，尽可能多地交付价值**。agent 只在被人请求、或团队写下的规则允许时才行动；只在需要人决策、或结果可交付时才发言。详见[设计原则](docs/000-philosophy.md)。

### 工作流程

一个请求从进入仓库到交付结果，按下面的顺序推进：

1. **Source 采集事件**：GitHub Source 通过 agent 账号的通知与已订阅的 issue/PR 获取评论、CI 变化、PR 合并或关闭等事件，并转成不可变的 Trigger；开启仓库观察后，新 issue、新 PR、评论和默认分支的 CI 也会进入。接入飞书后，群聊里的 @ 与私信也会成为 Trigger。每个 Source 记录自己的读取位置，重启后不会重放旧事件。
2. **Eval 评估**：主 Session（router）把同一对话线程（Thread）里的 Trigger、允许名单和已有工单放在一起判断，决定是否接单、以什么范围接单（只回答、只读排查、改代码或开 PR）。不在允许名单里的请求会被忽略，并留下记录。
3. **Ticket 与 Assignment**：接受后创建工单（Ticket），把授权范围、依据和交付要求固化为 Mandate，再通过 Assignment 交给 Executor。工单定义自己的状态，同一请求的后续讨论可以继续唤醒它。
4. **Executor 执行**：每张工单在独立的 `worker-<工单 id>` 会话和独立工作目录中执行：读上下文、改代码、跑测试，必要时推送分支并开 PR；遇到需要人决策的问题会停下来提问，而不是自行猜测。
5. **Channel 交付**：结果、阻塞原因或待确认问题通过 Channel 回到发起请求的对话；Web 面板的 **Overview** 会优先列出需要人处理的工单，其余过程不打扰人。

在原来的对话里继续说话即可补充需求或叫停，不需要重新 @ agent。

### 主要特性

- **按授权行动**：允许名单、准入规则和 Mandate 共同决定 agent 可以做什么；
- **隔离执行**：每张工单拥有自己的 agent 会话和工作目录，可并行、可恢复；
- **克制沟通**：只在结果就绪、需要决策或无法完成时发言；
- **全程可审计**：从 Trigger、Eval 到 Ticket 和执行报告都有记录；
- **GitHub 与飞书**：支持 Issue、PR、CI 事件，可选接入飞书群聊和私信。

### 快速开始

从零到跑起来分为六步。每步的细节以 [SETUP.md](SETUP.md) 和 [006 部署](docs/006-deployment.md) 为准。

1. **检查依赖**。需要 Node.js 22.19+ 或 24+、pnpm、git 2.32+、tmux、Python 3.8+、GitHub CLI 2.48+，以及版本满足 `package.json` 中 `engines.dsh` 的 DeepSeek Harness：

   ```sh
   node -v; pnpm -v; git --version; tmux -V; python3 --version; gh --version | head -1; dsh --version
   ```

2. **获取代码并构建**：

   ```sh
   npm install -g @deepseek-ai/dsh@0.2.1-rc.3
   git clone https://github.com/DylanXQH/dsh-superagent-prototype.git dsh-superagent
   cd dsh-superagent && pnpm install && pnpm build
   ```

3. **创建独立 profile 并安装本包**。profile 名为 `superagent`，与日常使用的 profile 分开，升级或重启 agent 时不会关掉你自己的会话：

   ```sh
   dsh superagent --from-default-profile web --dump-config > /dev/null
   dsh plugin --profile superagent add "link:$PWD"
   ```

   第一条命令只用于首次安装；profile 已存在时执行它会覆盖 `cordis.patch.yml`（见下一步），升级时跳过。

4. **写机器配置**。把示例配置复制为 profile 的机器配置，至少填写 `stateDir` 的绝对路径，并确认端口（示例为 `3082`）：

   ```sh
   cp examples/profile.cordis.patch.yml ~/.dsh/profiles/superagent/cordis.patch.yml
   ```

5. **启动并确认**：

   ```sh
   scripts/dsh-superagent start
   scripts/dsh-superagent status   # 退出码 0 表示运行正常
   ```

   打开启动日志里打印的面板地址，在侧栏选择 **Superagent**。

6. **完成授权配置并试用**。在面板的 **Settings** 中按 [SETUP.md](SETUP.md) 的问题顺序配置：**Sources**（GitHub 仓库与 agent 的 CLI）、**Policy**（允许名单）、**Execution**（仓库克隆位置与 prepare 命令）和 **Prompts**（提交身份、是否开启 auto-merge）。然后用一个在允许名单内的账号，在目标仓库的 issue 下评论 `@<agent 登录名> <请求>`；大约一分钟后面板上会出现对应的工单，执行结果会回到同一对话。

也可以让编码 agent 按 [SETUP.md](SETUP.md) 带你完成：它每次只问一个问题，先给出完整计划，确认后再安装配置。

## Overview

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows. The steps are:

1. **Check prerequisites.** Node.js 22.19+ or 24+, pnpm, git 2.32+, tmux, Python 3.8+, GitHub CLI 2.48+, and a DSH version within `engines.dsh`.
2. **Get and build the code.** `npm install -g @deepseek-ai/dsh@0.2.1-rc.3`; clone the repository; then `pnpm install && pnpm build`.
3. **Create the profile and add the bundle.** `dsh superagent --from-default-profile web --dump-config > /dev/null`, then `dsh plugin --profile superagent add "link:$PWD"`. Run the first command only for a new installation.
4. **Configure.** Copy `examples/profile.cordis.patch.yml` to `~/.dsh/profiles/superagent/cordis.patch.yml`, fill in `stateDir` and the placeholders, then set Sources, Policy, Execution and Prompts (commit author and the auto-merge condition) in **Settings**.
5. **Start and verify.** `scripts/dsh-superagent start`, then `scripts/dsh-superagent status` (exit 0 means healthy). Open the printed URL, choose **Superagent**, then comment `@<agent login> <request>` on an issue from an account on the allowed list.

Each step is explained in [SETUP.md](SETUP.md) and [006 Deployment](docs/006-deployment.md).

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
