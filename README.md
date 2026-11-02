# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

## 项目说明

dsh-superagent 是一个面向**单个 GitHub 仓库**的主动式编码 agent，以 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 扩展包（bundle）的形式发布。它监听 GitHub，并可选接入飞书：当授权的人请它做事时，它会把请求变成一张工单（Ticket），在独立的 agent 会话和工作目录中完成工作，然后回到原对话交付结果，例如一个 pull request。Web 面板只显示需要人处理的事项。

它同时也是一种与 agent 协作的方式：**尽可能少占用人的注意力，尽可能多地交付价值**。agent 只在被人请求、或团队写下的规则允许时才行动；只在需要人决策、或结果可交付时才发言。详见[设计原则](docs/000-philosophy.md)。

### 工作流程

1. **Source** 从 GitHub（可选飞书）读取事件，产生 Trigger；
2. **Eval** 依据 Policy 判断这是不是一项工作，以及工作的范围；
3. 接受后创建 **Ticket**，并绑定一次 **Assignment**；
4. **Executor** 在独立会话与目录中执行；
5. **Channel** 把确认、结果或问题送回发起请求的对话。

### 主要特性

- **按授权行动**：允许名单、准入规则和 Mandate 共同决定 agent 可以做什么；
- **隔离执行**：每张工单拥有自己的 agent 会话和工作目录，可并行、可恢复；
- **克制沟通**：只在结果就绪、需要决策或无法完成时发言；
- **全程可审计**：从 Trigger、Eval 到 Ticket 和执行报告都有记录；
- **GitHub 与飞书**：支持 Issue、PR、CI 事件，可选接入飞书群聊和私信。

### 快速开始

让一个编码 agent 阅读 [SETUP.md](SETUP.md)，它会带你完成安装与配置；设计文档从[设计原则](docs/000-philosophy.md)开始，按顺序阅读即可。

## Overview

dsh-superagent is a proactive coding agent for one GitHub repository, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

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
