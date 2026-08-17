# Ergouzi Agent Skills

[English](README.md) | [简体中文](README.zh-CN.md)

面向大众、由社区共同维护的 Agent Skills 与 Claude Code / Codex Plugins，主要服务于
New API 及其他可复用工作流。

本仓库是直接维护的公开事实源，不从二狗私有运维 Skills 中镜像或发布内容。

## 仓库内容

| 路径                               | 用途                                  |
| ---------------------------------- | ------------------------------------- |
| `skills/`                          | 遵循 Agent Skills 规范的可移植 Skills |
| `plugins/`                         | 自包含的跨平台或平台专属 Plugins      |
| `templates/`                       | 仓库 scaffold 命令使用的模板          |
| `docs/`                            | 开发、治理、安全与设计文档            |
| `.claude-plugin/marketplace.json`  | Claude Code marketplace 目录          |
| `.agents/plugins/marketplace.json` | Codex marketplace 目录                |

当前提供以下 portable Skills：

- `ergouzi-image-gen`：提交和管理 Ergouzi 图片生成、编辑、虚拟试衣与放大任务。
- `ergouzi-video-gen`：提交和管理 Ergouzi 视频生成、动画、数字人与人物替换任务。

两个 Skill 都需要 Python 3.10+、访问 `https://ergouzi.life` 的网络能力，以及在本地
配置好的 Ergouzi API Key。

## 安装

以下远程命令将在仓库正式发布后可用。

### Portable Skills

```bash
npx skills add aiman-labs/ergouzi-agent-skills --list
npx skills add aiman-labs/ergouzi-agent-skills --skill <skill-name>
```

### Claude Code Plugins

```text
/plugin marketplace add aiman-labs/ergouzi-agent-skills
/plugin install <plugin-name>@ergouzi-agent-skills
```

### Codex Plugins

```bash
codex plugin marketplace add aiman-labs/ergouzi-agent-skills
codex plugin add <plugin-name>@ergouzi-agent-skills
```

只安装你信任的 Skill 与 Plugin。公开产物可能包含可执行脚本或工具集成，启用前请检查
manifest、操作指令和源代码。

## Ergouzi Media MCP 快速开始

`ergouzi-media-mcp` 是一个本地 Codex 插件，将 Ergouzi 异步图片和视频 API 封装为配置诊断、
模型查询与 Schema 查询、创建任务、查询状态、取消任务和下载结果工具。

1. 使用上面的 Codex marketplace 命令安装插件：

   ```bash
   codex plugin add ergouzi-media-mcp@ergouzi-agent-skills
   ```

2. 安装 Node.js 22 或更高版本，并配置一把独立的媒体 API Key。该 Key 必须有目标图片/视频
   模型的权限，它不是 Codex 使用的 GPT/文本模型 Key。在 macOS/Linux 中将它保存到
   `~/.config/ergouzi/credentials.json`，Windows 中保存到
   `%APPDATA%\\ergouzi\\credentials.json`：

   ```json
   {
     "api_key": "YOUR_MEDIA_API_KEY",
     "base_url": "https://ergouzi.life"
   }
   ```

3. 新建一个 Codex 任务，并验证连接：

   ```text
   调用 ergouzi-media-mcp 的 check_configuration，检查配置但不要显示我的媒体 API Key。
   ```

4. 明确指定保存位置，再让 Codex 生成并下载媒体：

   ```text
   使用 ergouzi/e-image 生成一张雨夜上海街头图片，完成后下载到 ~/outputs。
   ```

MCP 会处理任务提交、轮询和下载；Codex 负责选择模型并组织模型参数。关于本地文件输入、
工具参数、输出行为和故障排查，请阅读[完整插件指南](plugins/ergouzi-media-mcp/README.zh-CN.md)。

## 参与贡献

提交前请阅读 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。新 Skill 或 Plugin 必须
说明用户问题、触发示例、安全与依赖、第三方来源，并提供可复现验证。

常用命令：

```bash
npm install
npm run create:skill -- <name> --description "..."
npm run create:plugin -- <name> --target cross-platform --description "..."
npm run catalog
npm run check
```

## 规范

- [Skill 开发规范](docs/authoring/skill-standard.md)
- [Plugin 开发规范](docs/authoring/plugin-standard.md)
- [版本策略](docs/governance/versioning.md)
- [安全审查清单](docs/security/review-checklist.md)

## 开源协议

MIT。引入的第三方内容仍受原许可证约束，重新分发前必须记录来源与许可证。
