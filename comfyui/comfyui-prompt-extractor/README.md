# 图片提示词提取器（即时）

复制本目录到 `ComfyUI/custom_nodes/comfyui-prompt-extractor`，重启 ComfyUI。
节点位于 `image/metadata`，包含“图片提示词提取器（即时）”与“图片提示词提取器（图像输入·即时）”。

选择或拖入原始 ComfyUI PNG，无需执行队列即可读取正向、负向提示词。图像输入版也可以连接 Load Image。
支持采样链路追踪、连接的字符串、分段 ULS 编码器、SDXL、多采样链路提示，以及保存工作流后恢复提取结果。
未知文本转换节点会显示解析说明，需要用户核对。

这是元数据读取器，不能从没有 prompt 元数据的图片还原原始提示词。当前不包含看图反推，也不宣称支持 A1111/NovelAI 的全部元数据格式。
Windows 文件夹按钮可选择并打开本地文件夹。提取核心在浏览器执行，不上传图片到外部服务。
无需下载模型，也没有额外 pip 依赖。

检查：`node tests/prompt_extractor.test.cjs`，测试使用合成数据，不附带个人图片。
