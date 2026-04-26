# Session Replay

English version: see [README.md](./README.md)

Session Replay 是一个 Hermes Dashboard 插件，用来把原始 agent session 整理成更易读、可回放、可分享的执行轨迹视图。

这个仓库面向 Hermes Dashboard 内部接入场景：插件由同一个 Hermes Dashboard 实例加载，直接使用宿主环境里的 session 数据和插件路由，不讨论外部部署、跨宿主代理或远程连接场景。

## 插件作用

Session Replay 主要用于：

- 复盘一次 agent session 从请求到最终回答的完整过程
- 查看工具调用、重试、错误、长耗时步骤等关键信息
- 用比原始日志更容易理解的方式回放一次任务执行过程
- 导出独立 HTML replay，便于分享与审阅
- 帮助团队理解 Hermes 在 Dashboard 中是如何完成真实任务的

## 功能亮点

- Hermes Dashboard 内置 `Session Replay` 标签页
- Session 选择器支持搜索和手动输入 session id
- Timeline 过滤支持 errors、tool calls、file changes、retries、long-running
- 将 session messages 解析为结构化 replay timeline
- 每一步都可查看详情和原始 JSON
- 支持 Play / Pause 回放
- 支持导出 JSON replay
- 支持导出独立 HTML replay

## 界面截图

主回放视图：

![Session Replay 主视图](./screenshots/replay.png)

图谱视图：

![Session Replay 图谱视图](./screenshots/replay-graph.png)

## 内部接入方式

Session Replay 的默认使用方式就是运行在同一个 Hermes Dashboard 环境中。

常规接入方式：

1. 将本仓库放到 `~/.hermes/plugins/session-replay/`
2. 启动 Hermes Dashboard
3. 由 Dashboard 自动加载插件
4. 在 Dashboard 中打开 `Session Replay` 标签页

插件通过宿主 Dashboard 下的 `/api/plugins/session-replay/...` 路由工作，所需 session 数据也来自同一个 Hermes 运行环境。

## 仓库结构

```text
plugin.yaml
README.md
README.zh-CN.md
dashboard/
  __init__.py
  manifest.json
  parser.py
  plugin_api.py
  dist/
    index.js
    style.css
```

## Dashboard 加载位置

Hermes Dashboard 应从以下目录加载插件：

```text
~/.hermes/plugins/session-replay/
```

插件运行所需文件：

- `plugin.yaml`
- `dashboard/manifest.json`
- `dashboard/plugin_api.py`
- `dashboard/dist/index.js`
- `dashboard/dist/style.css`

## 仓库定位

这个仓库聚焦于 Session Replay 插件本身：

- 插件清单与打包结构
- replay 解析与导出逻辑
- 面向 Dashboard 的前端 UI bundle
- 面向 Hermes session 的 replay 展示层

它不替代 Hermes 主体能力；它的职责是把现有 session 数据变成更易于查看、回放和分享的 Dashboard 体验。

## 开源协议

本项目采用 MIT License，详见 [LICENSE](./LICENSE)。
