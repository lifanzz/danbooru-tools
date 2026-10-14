# 本地danbooru搜索器

复制本目录到 `ComfyUI/custom_nodes/comfyui-danbooru-search`。
复制 `config.json.example` 为 `config.json`，填写 `manager_dir` 为管理器目录的绝对路径，`manager_url` 为管理器地址，然后重启 ComfyUI。后续修改配置也需要重启 ComfyUI。配置文件不会提交到 Git。
也可使用环境变量 `DANBOORU_MANAGER_DIR`、`DANBOORU_MANAGER_URL`；环境变量优先。

节点位于 `utils/lora/本地danbooru搜索器`。搜索通用标签、角色卡、模型提示词组；支持“匹配长说明”。点击结果复制；“打开管理器”在系统浏览器打开管理器并带上关键词。
管理器关闭时，可以读取已经初始化的 `data/` 进行备用搜索。第一次使用先启动一次管理器。
没有额外 pip 依赖，使用 ComfyUI 自带的 aiohttp。
保留节点 ID `DanbooruSearchHub`，可兼容原工作流；若已经安装注册同一 ID 的旧插件，请避免同时加载两个版本。
