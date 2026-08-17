# Ergouzi Media MCP

[English](README.md)

这是一个本地 Codex 插件，将 Ergouzi 异步图片和视频 API 封装为 MCP 工具。Codex 负责
选择模型和组织模型参数；MCP Server 负责读取本机凭据、调用 HTTP API、查询任务、取消任务、
处理本地媒体文件和下载结果。

## 开始前

需要满足以下条件：

- Codex 支持本地 Plugin/MCP。
- 已安装 Node.js 22 或更高版本。
- 已创建一把支持目标图片/视频模型的独立媒体 API Key。它不是 Codex 用来调用 GPT/文本
  模型的 Key。

媒体 API Key 在本机保存，绝不发送到聊天、工具参数、源码或日志中。默认凭据文件是：

- macOS/Linux：`~/.config/ergouzi/credentials.json`
- Windows：`%APPDATA%\\ergouzi\\credentials.json`

```json
{
  "api_key": "YOUR_MEDIA_API_KEY",
  "base_url": "https://ergouzi.life"
}
```

也可以通过以下环境变量覆盖本地凭据：

- `ERGOUZI_MEDIA_API_KEY`
- `ERGOUZI_MEDIA_BASE_URL`
- `ERGOUZI_CONFIG_FILE`

## 安装

仓库公开后，先添加 marketplace，再安装插件：

```bash
codex plugin marketplace add aiman-labs/ergouzi-agent-skills
codex plugin add ergouzi-media-mcp@ergouzi-agent-skills
```

安装后新建一个 Codex 任务，让工具列表重新加载。插件会通过 `.mcp.json` 启动：

```bash
node scripts/server.mjs
```

## 第一次验证

在新任务中发送：

```text
调用 ergouzi-media-mcp 的 list_models，列出我的媒体 API Key 可用的图片和视频模型。
```

模型列表成功返回后，说明 MCP、凭据和 API 权限均已可用。

## 可用工具

| 工具                  | 作用                                      |
| --------------------- | ----------------------------------------- |
| `check_configuration` | 检查本地凭据、文件权限和 API 连通性。     |
| `list_models`         | 查询当前媒体 Key 可用的模型。             |
| `get_model_schema`    | 查询某个模型实时的输入和输出 Schema。     |
| `create_prediction`   | 创建一次图片或视频异步任务并返回任务 ID。 |
| `get_prediction`      | 查询任务状态，也可以进行有上限的等待。    |
| `cancel_prediction`   | 在用户明确确认后取消一个任务。            |
| `download_prediction` | 下载成功结果并写入本地回执。              |

首次使用时先执行：

```text
调用 ergouzi-media-mcp 的 check_configuration，检查配置但不要显示我的 API Key。
```

选择模型前可查询实时字段：

```text
调用 get_model_schema 查询 ergouzi/e-image 的输入 Schema。
```

通常只需告诉 Codex 目标，它会依次调用：

```text
create_prediction -> get_prediction -> download_prediction
```

创建计费任务或取消已有任务前，Codex 会要求用户明确确认。

## 图片和视频示例

生成图片：

```text
使用 ergouzi/e-image 生成一张雨夜上海街头图片，电影感摄影，无文字。
完成后下载到 ~/outputs。
```

生成视频：

```text
使用 ergouzi/e-video 生成 5 秒、16:9 的视频：清晨云海缓慢流过山谷，电影感航拍。
完成后下载到 ~/outputs。
```

编辑本地图片：

```text
使用 ergouzi/e-image-edit 编辑 ~/input/product.png，
保持产品不变，将背景改成白色摄影棚；完成后下载到 ~/outputs。
```

MCP 只会在已记录的媒体字段中将本地路径传递为 `$local_file`，不会把任意 JSON 字段当作
本地文件。较大的文件应使用 HTTPS URL。
本地路径可使用绝对路径或 `~/...` 形式。`hf_api_token` 等上游提供商令牌会在请求提交前被拒绝。

每个本地文件最大为 3 MiB；本地文件转换成 Base64 后，完整 JSON `input` 最大为 4 MiB；
每个下载结果最大为 2 GiB。`ergouzi/e-video` 支持本地 `image`、
`last_frame_image` 和 `audio`。

工具结果同时包含结构化 MCP 内容和可读 JSON 文本，任务 ID、状态、本地文件路径和回执路径都可
由 Codex 继续使用。

## 结果与故障排查

`download_prediction` 默认下载到 MCP 进程工作目录中的
`outputs/ergouzi-media-mcp`。建议在提示中明确指定 `output_dir` 或下载目录。结果文件不会
覆盖已有文件；下载完成后还会写入 `receipts/YYYY-MM-DD/` 回执。

- **找不到工具**：确认插件已安装，然后新建一个 Codex 任务。
- **401 或 403**：确认配置的是独立媒体 Key，且当前密钥分组支持目标模型。
- **任务未完成**：保留 `task_` 开头的任务 ID，使用 `get_prediction` 继续查询，不要重复创建。
- **下载失败**：指定一个可写入的本地目录；外部输出 URL 必须使用 HTTPS。

Server 使用官方 Model Context Protocol SDK。SDK 及其许可证已经打包进插件的
`server.mjs`，安装插件的用户不需要执行 `npm install`。

## 安全边界

- Server 使用 `stdio`，不会启动公开 HTTP 监听端口。
- Authorization 只发送给配置的 Ergouzi API 域名，不会发送给外部下载地址或跨域重定向。
- 每个下载域名及其重定向都会先解析 DNS；解析到私网、本机、保留地址或同时返回公网和私网
  地址时会拒绝下载。
- 下载超时为 120 秒，并且在整个流式写入期间持续生效；失败时会删除未完成的临时文件。
- 本地媒体必须是普通文件，并在转为 data URI 前进行签名检查。
- `$local_file` 只允许作为已记录媒体字段中的唯一对象值；其他位置出现该字段会在请求发送前报错。
- 参数校验错误会返回脱敏后的字段详情；`429` 会携带服务端的 `Retry-After` 提示。
- 远端 Ergouzi 任务记录是唯一事实来源，MCP 不维护本地计费队列或重复任务数据库。
