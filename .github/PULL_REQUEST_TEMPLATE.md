# PR Notice / 提交说明

> [!IMPORTANT]
>
> - Write a concise summary in your own words. Do not paste unreviewed generated output.
> - 请基于自己的理解提供简洁摘要，避免直接粘贴未经整理的 AI 输出。

## Change Summary / 变更描述

Describe the user problem, what changed, and why the change solves it.

简述用户问题、改动内容，以及该改动为何能解决问题。

## Type Of Change / 变更类型

- [ ] Bug fix - Link the related Issue or explain the internal incident or production context. Do not label an expected design trade-off or misunderstanding as a bug.
  - Bug 修复 - 请关联对应 Issue，或说明内部事件或生产问题背景；不要将预期设计取舍或理解偏差标记为 bug。
- [ ] New feature - Discuss substantial features in an Issue first.
  - 新功能 - 重大特性建议先通过 Issue 沟通。
- [ ] Performance improvement or refactor
  - 性能优化或重构
- [ ] Documentation update
  - 文档更新

## Related Issue / 关联任务

- Closes # (if applicable)
- Internal incident or task: (provide the context when no public Issue exists, or write N/A)
- 关联 Issue：#（如有）
- 内部事件或任务：（如无公开 Issue，请填写背景或 N/A）

## Artifact / 工件信息

- Type: `portable Skill / cross-platform Plugin / Claude Code Plugin / Codex Plugin / repository tooling`
- Name:
- Related artifact or directory:
- Supported clients and tested versions:
- 类型：`portable Skill / cross-platform Plugin / Claude Code Plugin / Codex Plugin / repository tooling`
- 名称：
- 相关工件或目录：
- 支持的客户端和已测试版本：

## Capability And Risk / 能力与风险

- [ ] No executable behavior
  - 无可执行行为
- [ ] Runs local scripts or binaries
  - 运行本地脚本或二进制文件
- [ ] Uses network access
  - 使用网络访问
- [ ] Uses authentication or user secrets
  - 使用身份验证或用户密钥
- [ ] Writes files or external state
  - 写入文件或外部状态
- [ ] Can perform destructive or externally visible actions
  - 执行破坏性或对外可见操作

Describe every checked capability, its minimum required permissions, confirmation
boundary, and rollback or recovery path.

请说明每项已勾选能力所需的最小权限、确认边界，以及回滚或恢复路径。

## Checklist / 提交前检查项

- [ ] I wrote and reviewed this description myself; it does not paste unprocessed AI output.
  - 我已亲自整理并撰写此描述，没有直接粘贴未经处理的 AI 输出。
- [ ] I searched the repository [Issues](https://github.com/aiman-labs/ergouzi-agent-skills/issues) and [PRs](https://github.com/aiman-labs/ergouzi-agent-skills/pulls) and confirmed this is not a duplicate.
  - 我已搜索当前仓库的 Issues 与 PRs，确认不是重复提交。
- [ ] For a bug fix, I linked a public Issue or documented the relevant internal incident or production context.
  - 若此 PR 为 Bug fix，我已关联公开 Issue，或说明对应的内部事件或生产问题背景。
- [ ] I understand the submitted behavior and its possible impact.
  - 我已理解这些更改的工作原理及可能影响。
- [ ] This PR contains no unrelated changes.
  - 本 PR 未包含任何与当前任务无关的代码改动。
- [ ] Artifact name, directory, manifests, and versions follow repository rules.
  - 工件名称、目录、清单和版本符合仓库规则。
- [ ] Plugin runtime content is self-contained and has no repository-external or private dependency.
  - 插件运行时不依赖仓库外文件、私有路径或私有仓库内容。
- [ ] English and Simplified Chinese user documentation are aligned where behavior changed.
  - 相关英文和简体中文用户文档已保持一致。
- [ ] I ran `npm run check` locally and recorded any focused tests or manual validation that a maintainer can reproduce.
  - 我已在本地运行 `npm run check`，并记录维护者可以据此复核的聚焦测试或手动验证。
- [ ] No credential, private endpoint, production data, or private local path is included.
  - 代码中不包含敏感凭据、私有端点、生产数据或私有本地路径。
- [ ] Third-party source and license information is recorded and permits redistribution.
  - 已记录第三方来源和许可证，且确认允许再分发。

## Proof Of Work / 运行证明

- Tests:
  - `...`
- Manual verification:
  - `...`
- Baseline without the artifact, when applicable:
  - `...`
- Result with the artifact:
  - `...`
- Not run and why:
  - `...`

## Deployment / 部署影响

- Deployment required: `yes / no`
- Target or handoff: `...`
- 是否需要部署：`yes / no`
- 目标或交接：`...`

## Risk And Rollback / 风险与回滚

- Risk: `...`
- Rollback: `...`
- 风险：`...`
- 回滚：`...`

## Provenance And License / 来源与许可证

- Third-party sources:
- Third-party licenses:
- 第三方来源：
- 第三方许可证：
