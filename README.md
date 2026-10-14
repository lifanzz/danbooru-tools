# Danbooru Tools

本地 Danbooru 标签管理器，以及两个配套的 ComfyUI 插件。

| 目录 | 工具 |
| --- | --- |
| `manager/` | 通用标签、角色提示词库、模型管理、图文笔记 |
| `comfyui/comfyui-danbooru-search/` | 本地danbooru搜索器 |
| `comfyui/comfyui-prompt-extractor/` | 图片提示词提取器（即时） |

## 管理器启动（Windows）

安装 Python 3.10 或以上，在 `manager/` 执行 `python -X utf8 serve.py`，或双击 `start-manager.cmd`。
浏览器打开 `http://127.0.0.1:9090/`。管理器使用 Python 标准库，无需 pip 安装依赖。
默认仅监听本机。`DANBOORU_OPEN_BROWSER=0` 可关闭自动打开浏览器。

首次启动将 `manager/seed-data/` 中的标签和角色库复制到 `manager/data/`。
模型管理与图文笔记首次启动为空；仓库不包含作者的模型记录、提示词图片组、模型图片、个人笔记或笔记图片。
后续启动保留已有数据，不覆盖用户修改。整个 `data/` 目录被 Git 忽略。

复制 `manager/config.local.json.example` 为 `manager/config.local.json` 可配置端口和模型扫描路径。例如 `model_scan_roots` 填写 `[["LoRA", "你的LoRA目录"], ["UNet", "你的UNet目录"], ["Checkpoints", "你的Checkpoint目录"]]`。
目录也可使用 Windows 环境变量。模型文件仍在原目录，扫描只建立清单；手动改名模型时会改动实际文件。
模型来源工具读取 SafeTensors 元数据；查找缺失网址时可能请求 Civitai 的哈希查询接口。

## ComfyUI 安装

分别将 `comfyui/` 下的两个插件目录复制到 `ComfyUI/custom_nodes/`，重启 ComfyUI。
搜索节点需按其 README 配置管理器路径和地址。提示词提取器可独立使用。

## 可选托盘程序

`manager/TrayLauncher/` 为 .NET 8 Windows Forms 托盘启动器源码。
执行 `dotnet publish manager/TrayLauncher/ -c Release -r win-x64 --self-contained false -o dist/tray`，将生成的 EXE 放入 `manager/`，安装 .NET 8 Desktop Runtime 后使用。
默认从 PATH 找 Python；可用 `DANBOORU_PYTHON` 指定 Python 程序。
默认端口 9090，可通过 `DANBOORU_PORT` 设置。托盘程序使用环境变量端口，不读取 `config.local.json`。

## 发布范围与检查

源码与标签种子数据在同一个仓库，运行数据始终位于被忽略的 `data/`。
详情见 [发布说明](docs/PUBLISHING.md)。
标签库包括中文说明与角色预设，按仓库数据使用；联网查询是否存在某个规范标签应以 Danbooru 官方信息为准。
