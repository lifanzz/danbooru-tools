// This file is served at /extensions/comfyui-prompt-extractor/.
// Use a relative core import, matching ComfyUI's other custom-node extensions.
import { app } from "../../../scripts/app.js";

const TYPES = new Set(["ImagePromptExtractor", "ImagePromptExtractorImageInput"]);
const OPEN_FOLDER_PATH_KEY = "jerry_image_prompt_extractor_open_folder_path";
const SHOW_IMAGE_KEY = "jerry_image_prompt_extractor_show_image";
const FONT_SIZE_KEY = "jerry_image_prompt_extractor_font_size";
const DEFAULT_OPEN_FOLDER_PATH = "";

function rememberOpenFolderPath(node, path) {
    const value = String(path || "").trim();
    node.properties ??= {};
    node.properties[OPEN_FOLDER_PATH_KEY] = value;
}

function readUint32(bytes, offset) {
    return (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
}

function pngTextChunks(buffer) {
    const bytes = new Uint8Array(buffer);
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (signature.some((value, i) => bytes[i] !== value)) throw new Error("请选择 PNG 图片");
    const decoder = new TextDecoder("utf-8");
    const texts = {};
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const length = readUint32(bytes, offset) >>> 0;
        const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > bytes.length) break;
        if (type === "tEXt") {
            const data = bytes.slice(dataStart, dataEnd);
            const zero = data.indexOf(0);
            if (zero > 0) texts[decoder.decode(data.slice(0, zero))] = decoder.decode(data.slice(zero + 1));
        } else if (type === "iTXt") {
            const data = bytes.slice(dataStart, dataEnd);
            const firstZero = data.indexOf(0);
            if (firstZero > 0 && data[firstZero + 1] === 0) {
                let p = firstZero + 3; // compression flag, method, empty language tag
                while (p < data.length && data[p++] !== 0) {}
                while (p < data.length && data[p++] !== 0) {}
                texts[decoder.decode(data.slice(0, firstZero))] = decoder.decode(data.slice(p));
            }
        }
        offset = dataEnd + 4;
        if (type === "IEND") break;
    }
    return texts;
}

function nodeIdFromReference(value) {
    return Array.isArray(value) && (typeof value[0] === "string" || typeof value[0] === "number")
        ? String(value[0])
        : null;
}

function isInstructionNode(node) {
    return /gemini|openai|chatgpt|claude|ollama|llm/i.test(node?.class_type || "");
}

function resolveStringValue(prompt, value, seen = new Set(), workflow = null, warnings = null) {
    if (typeof value === "string") return value;
    const id = nodeIdFromReference(value);
    if (!id || seen.has(id)) return "";
    seen.add(id);

    const node = prompt?.[id];
    const inputs = node?.inputs || {};
    const type = node?.class_type || "";

    // Runtime LLM results are recoverable only when metadata contains a cache.
    if (isInstructionNode(node)) return "";
    if (/ShowText/i.test(type)) {
        const cached = inputs.text_0 ?? workflow?.nodes?.find((item) => String(item.id) === id)?.widgets_values?.[0];
        if (typeof cached === "string") return cached;
    }

    // Jerry's variable join node: keep its input order and delimiter exactly.
    if (type === "VariableTextJoin") {
        const count = Math.max(2, Math.min(10, Number(inputs.input_count || 2)));
        const delimiter = typeof inputs.delimiter === "string" ? inputs.delimiter : ", ";
        const parts = [];
        for (let index = 1; index <= count; index++) {
            const part = resolveStringValue(prompt, inputs[`text_${index}`], new Set(seen), workflow, warnings).trim();
            if (part) parts.push(part);
        }
        return parts.join(delimiter);
    }

    // PrimitiveStringMultiline and ordinary text-producing nodes commonly use
    // one of these fields. This also keeps direct CLIP Text Encode prompts working.
    for (const key of ["text", "value", "string", "prompt", "positive_prompt", "negative_prompt"]) {
        const resolved = resolveStringValue(prompt, inputs[key], new Set(seen), workflow, warnings);
        if (resolved.trim()) {
            if (!/^PrimitiveString|^CLIPTextEncode/.test(type)) {
                warnings?.add(`节点 #${id}（${type}）：读取的是保存的文本输入，运行时处理结果请核对。`);
            }
            return resolved;
        }
    }
    return "";
}

function resolveConditioningText(prompt, reference, branch, seen = new Set(), workflow = null, warnings = new Set()) {
    const id = nodeIdFromReference(reference);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const node = prompt?.[id];
    const inputs = node?.inputs || {};
    const type = node?.class_type || "";
    if (isInstructionNode(node)) {
        warnings.add(`节点 #${id} 的生成文本未保存在元数据中。`);
        return [];
    }

    if (type === "ULSCLIPTextEncode") {
        if (branch === "negative" && !inputs.use_negative) return [];
        const markers = String(inputs.comment_markers ?? "//").trim().split(/\s+/).filter(Boolean);
        const clean = (value) => {
            let text = resolveStringValue(prompt, value, new Set(), workflow, warnings);
            if (nodeIdFromReference(value) && !text) warnings.add(`节点 #${id} 的上游文本无法完整还原。`);
            if (inputs.strip_comments) text = text.split("\n").map((line) => {
                for (let i = 0; i < line.length; i++) {
                    if ((i === 0 || /\s/.test(line[i - 1])) && markers.some((marker) => line.startsWith(marker, i))) {
                        return line.slice(0, i > 0 ? i - 1 : i);
                    }
                }
                return line;
            }).filter((line) => line.trim()).join("\n");
            if (inputs.strip_newlines) text = text.split("\n").join(" ");
            return text.replace(/[ \t]+/g, " ").trim();
        };
        const parts = branch === "negative"
            ? [clean(inputs.neg_1)]
            : Array.from({ length: Math.max(1, Math.min(6, Number(inputs.segments) || 4)) }, (_, i) => clean(inputs[`pos_${i + 1}`]));
        const external = clean(inputs[branch === "negative" ? "neg_external" : "pos_external"]);
        if (external) {
            if (inputs.external_mode === "replace") parts.splice(0, parts.length, external);
            else if (inputs.external_mode === "prepend") parts.unshift(external);
            else parts.push(external);
        }
        const separator = { comma: ", ", newline: "\n", space: " ", none: "" }[inputs.separator] ?? ", ";
        const text = parts.filter(Boolean).join(separator);
        return text ? [text] : [];
    }

    const prefix = branch === "negative" ? "(?:neg|negative)" : "(?:pos|positive)";
    const branchFields = Object.keys(inputs).filter((key) =>
        new RegExp(`^${prefix}(?:_prompt|_text|_\\d+)?$`, "i").test(key)
    ).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const textFields = branchFields.length ? branchFields : ["text", "text_g", "text_l", "prompt"];
    const texts = textFields.filter((key) => !nodeIdFromReference(inputs[key]) || !branchFields.includes(key) || /_(?:prompt|text|\d+)$/.test(key))
        .map((key) => resolveStringValue(prompt, inputs[key], new Set(), workflow, warnings).trim()).filter(Boolean);
    if (texts.length) {
        if (!/^CLIPTextEncode(?:SDXL|SDXLRefiner)?$/.test(type)) {
            warnings.add(`节点 #${id}：按${branch === "negative" ? "负向" : "正向"}链路及字段名识别，请核对。`);
        }
        return [...new Set(texts)];
    }

    // Nodes such as ControlNetApply pass positive/negative conditioning through.
    // Follow only the matching branch, never every text widget in the workflow.
    if (nodeIdFromReference(inputs.text) || nodeIdFromReference(inputs.prompt)) {
        warnings.add(`节点 #${id} 的上游文本无法完整还原。`);
    }
    const preferred = [...branchFields, "conditioning", "conditioning_to", "conditioning_from",
        ...Object.keys(inputs).filter((key) => /^conditioning_\d+$/.test(key))];
    const references = preferred.map((name) => inputs[name]).filter(nodeIdFromReference);
    if (!references.length && !texts.length) warnings.add(`节点 #${id}（${type}）没有可还原的${branch === "negative" ? "负向" : "正向"}文本。`);
    return [...new Set(references.flatMap((source) =>
        resolveConditioningText(prompt, source, branch, new Set(seen), workflow, warnings)
    ))];
}

function textEntries(prompt, workflow = null) {
    const warnings = new Set();
    const samplers = Object.entries(prompt || {})
        .filter(([, node]) => /KSampler|SamplerCustom/i.test(node?.class_type || ""))
        .sort(([a], [b]) => Number(b) - Number(a));
    const samplerIds = new Set(samplers.map(([id]) => id));
    const outputs = Object.entries(prompt || {}).filter(([, node]) => /SaveImage|PreviewImage/i.test(node?.class_type || ""));
    const queue = outputs.sort(([, a], [, b]) => Number(/SaveImage/i.test(b.class_type)) - Number(/SaveImage/i.test(a.class_type)))
        .flatMap(([, node]) => [node.inputs?.images]).filter(nodeIdFromReference);
    const seen = new Set();
    const connected = [];
    while (queue.length) {
        const id = nodeIdFromReference(queue.shift());
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if (samplerIds.has(id)) { connected.push(id); continue; }
        const inputs = prompt[id]?.inputs || {};
        for (const key of ["images", "image", "samples", "latent", "latent_image"]) {
            if (nodeIdFromReference(inputs[key])) queue.push(inputs[key]);
        }
    }
    const samplerId = connected[0] ?? samplers[0]?.[0];
    const sampler = prompt?.[samplerId];
    if (!sampler) return { positive: [], negative: [], samplerId: null, warnings };
    if (!connected.length && samplers.length > 1) warnings.add("无法确定最终图像链路，暂用编号最大的采样器，请核对。");
    if (connected.length > 1) warnings.add(`图片含多条采样链路，当前读取采样器 #${samplerId}，请核对。`);
    const inputs = sampler.inputs || {};
    const guider = prompt[nodeIdFromReference(inputs.guider)]?.inputs || {};
    return {
        positive: resolveConditioningText(prompt, inputs.positive ?? guider.positive ?? guider.conditioning, "positive", new Set(), workflow, warnings),
        negative: resolveConditioningText(prompt, inputs.negative ?? guider.negative, "negative", new Set(), workflow, warnings),
        samplerId,
        warnings,
    };
}

function formatPrompt(raw, rawWorkflow = null) {
    if (!raw) return "未找到 ComfyUI prompt 元数据。";
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return raw; }
    let workflow = null;
    if (rawWorkflow) { try { workflow = JSON.parse(rawWorkflow); } catch {} }
    const { positive, negative, warnings } = textEntries(parsed, workflow);
    const lines = [];
    if (positive.length) lines.push(`正向提示词\n${positive.join("\n")}`);
    if (negative.length) lines.push(`负向提示词\n${negative.join("\n")}`);
    if (!positive.length && !negative.length) {
        lines.push("未能从实际采样器的 positive/negative 链路中找到文本提示词。");
    }
    if (warnings.size) lines.push(`解析说明\n${[...warnings].join("\n")}`);
    return lines.join("\n");
}

function draggedImageUrl(dataTransfer) {
    const uriList = String(dataTransfer?.getData("text/uri-list") || "")
        .split(/\r?\n/)
        .find((line) => line && !line.startsWith("#"));
    if (uriList) return uriList.trim();
    const html = String(dataTransfer?.getData("text/html") || "");
    const source = html.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1];
    if (source) return source;
    const plainText = String(dataTransfer?.getData("text/plain") || "").trim();
    return /^(?:https?:|blob:|data:image\/)/i.test(plainText) ? plainText : "";
}

app.registerExtension({
    name: "jerry.image_prompt_extractor",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!TYPES.has(nodeData.name)) return;
        const original = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            original?.apply(this, arguments);
            const promptWidget = this.widgets?.find((widget) => widget.name === "prompt_text");
            // The backend STRING widget owns a native textarea. Merely changing
            // its type leaves that DOM textarea on the canvas, which can grow
            // past the node bounds. Fully collapse it; our panel owns the UI.
            if (promptWidget) {
                promptWidget.type = "hidden";
                promptWidget.computeSize = () => [0, -4];
                for (const element of [promptWidget.inputEl, promptWidget.element]) {
                    if (element) element.style.setProperty("display", "none", "important");
                }
            }

            const container = document.createElement("div");
            container.style.cssText = "box-sizing:border-box;display:flex;flex-direction:row;gap:8px;padding:2px;width:100%;height:0;overflow:hidden";
            const picker = document.createElement("input");
            picker.type = "file";
            picker.accept = "image/png";
            picker.style.display = "none";
            const dropZone = document.createElement("button");
            dropZone.type = "button";
            dropZone.textContent = "点击选择 PNG，或将图片拖到这里";
            dropZone.style.cssText = "box-sizing:border-box;position:relative;flex:0 0 0;width:0;height:100%;overflow:hidden;border:1px dashed #6b7b91;border-radius:5px;background:#15191e;color:#b9c7d8;font-size:12px;cursor:pointer";
            const preview = document.createElement("img");
            preview.alt = "所选图片预览";
            preview.style.cssText = "display:none;position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#090b0e";
            dropZone.append(preview);
            const status = document.createElement("div");
            status.textContent = nodeData.name === "ImagePromptExtractorImageInput"
                ? "可连接 Load Image 的图像输入，或拖入 PNG；提示词会即时提取，无需运行。"
                : "选择或拖入 PNG；提示词会即时提取，无需运行。";
            status.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:#bbb";
            this.properties ??= {};
            const isImageInputNode = nodeData.name === "ImagePromptExtractorImageInput";
            const imageVisibilityButton = document.createElement("button");
            imageVisibilityButton.type = "button";
            imageVisibilityButton.style.cssText = "flex:0 0 auto;height:26px;background:#3d4d3c;color:#fff;border:1px solid #789d71;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px";
            const setImageVisibility = (show) => {
                const visible = show !== false;
                this.properties[SHOW_IMAGE_KEY] = visible;
                dropZone.style.display = visible ? "" : "none";
                container.style.gap = visible ? "8px" : "0";
                imageVisibilityButton.textContent = `是否显示图片：${visible ? "是" : "否"}`;
                this.setDirtyCanvas(true, true);
            };
            if (isImageInputNode) {
                imageVisibilityButton.addEventListener("click", () => setImageVisibility(this.properties[SHOW_IMAGE_KEY] === false));
                setImageVisibility(this.properties[SHOW_IMAGE_KEY] !== false);
            }
            const folderControls = document.createElement("div");
            folderControls.style.cssText = "display:flex;gap:6px;min-width:0";
            const folderPath = document.createElement("input");
            folderPath.type = "text";
            // Folder choice belongs to this node's workflow only. Never read a
            // browser-global value here: different workflows may use different folders.
            folderPath.value = this.properties[OPEN_FOLDER_PATH_KEY] || DEFAULT_OPEN_FOLDER_PATH;
            folderPath.placeholder = "要打开的文件夹路径";
            folderPath.style.cssText = "box-sizing:border-box;flex:1 1 auto;min-width:0;height:26px;background:#171717;color:#e8e8e8;border:1px solid #555;border-radius:4px;padding:4px 7px;font:11px monospace";
            const openFolderButton = document.createElement("button");
            openFolderButton.type = "button";
            openFolderButton.textContent = "📂 打开文件夹";
            openFolderButton.style.cssText = "flex:0 0 auto;height:26px;background:#2f5f8f;color:#fff;border:1px solid #629bd0;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px";
            folderPath.addEventListener("input", () => {
                rememberOpenFolderPath(this, folderPath.value);
                this.setDirtyCanvas(true, true);
            });
            const chooseFolderButton = document.createElement("button");
            chooseFolderButton.type = "button";
            chooseFolderButton.textContent = "选择文件夹";
            chooseFolderButton.title = "选择后会记住该文件夹，并在下次新建节点或刷新页面时恢复";
            chooseFolderButton.style.cssText = "flex:0 0 auto;height:26px;background:#3d4d3c;color:#fff;border:1px solid #789d71;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px";
            chooseFolderButton.addEventListener("click", async () => {
                status.textContent = "正在打开系统文件夹选择框…";
                try {
                    const response = await fetch("/image-prompt-extractor/choose-folder", { method: "POST" });
                    const rawResult = await response.text();
                    let result;
                    try {
                        result = JSON.parse(rawResult);
                    } catch {
                        throw new Error(
                            response.status === 404 || response.status === 405
                                ? "ComfyUI 尚未重启，选择文件夹接口还未加载。"
                                : `服务返回异常（HTTP ${response.status}）：${rawResult.slice(0, 120)}`
                        );
                    }
                    if (!response.ok || !result.success) {
                        if (result.error) throw new Error(result.error);
                        status.textContent = "未更改文件夹。";
                        return;
                    }
                    folderPath.value = result.path;
                    rememberOpenFolderPath(this, result.path);
                    status.textContent = `已记住文件夹：${result.path}`;
                    this.setDirtyCanvas(true, true);
                } catch (error) {
                    status.textContent = `选择文件夹失败：${error.message || error}`;
                }
            });
            openFolderButton.addEventListener("click", async () => {
                const path = folderPath.value.trim();
                try {
                    const response = await fetch("/image-prompt-extractor/open-folder", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ path }),
                    });
                    const rawResult = await response.text();
                    let result;
                    try {
                        result = JSON.parse(rawResult);
                    } catch {
                        throw new Error(
                            response.status === 405
                                ? "ComfyUI 尚未重启，打开文件夹接口还未加载。"
                                : `服务返回异常（HTTP ${response.status}）：${rawResult.slice(0, 120)}`
                        );
                    }
                    if (!response.ok || !result.success) throw new Error(result.error || "无法打开文件夹。");
                } catch (error) {
                    status.textContent = `打开文件夹失败：${error.message || error}`;
                }
            });
            folderControls.append(folderPath, chooseFolderButton, openFolderButton);
            // A workflow may configure properties after this DOM widget is created.
            // Explicitly apply its saved value once configuration arrives, so loading
            // workflow A cannot inherit workflow B's folder.
            const previousOnConfigure = this.onConfigure;
            this.onConfigure = function (info) {
                const result = previousOnConfigure?.apply(this, arguments);
                output.value = promptWidget?.value || "";
                if (output.value) status.textContent = "已恢复提示词；重新选择 PNG 可更新。";
                const savedPath = info?.properties?.[OPEN_FOLDER_PATH_KEY] ?? this.properties?.[OPEN_FOLDER_PATH_KEY];
                if (typeof savedPath === "string") folderPath.value = savedPath;
                if (isImageInputNode) {
                    const showImage = info?.properties?.[SHOW_IMAGE_KEY] ?? this.properties?.[SHOW_IMAGE_KEY];
                    setImageVisibility(showImage !== false);
                    const fontSize = info?.properties?.[FONT_SIZE_KEY] ?? this.properties?.[FONT_SIZE_KEY];
                    setOutputFontSize(fontSize || 12);
                }
                return result;
            };
            const previousOnSerialize = this.onSerialize;
            this.onSerialize = function (info) {
                const result = previousOnSerialize?.apply(this, arguments);
                if (info) {
                    info.properties ??= {};
                    info.properties[OPEN_FOLDER_PATH_KEY] = this.properties?.[OPEN_FOLDER_PATH_KEY] || "";
                    if (isImageInputNode) info.properties[SHOW_IMAGE_KEY] = this.properties?.[SHOW_IMAGE_KEY] !== false;
                    if (isImageInputNode) info.properties[FONT_SIZE_KEY] = this.properties?.[FONT_SIZE_KEY] || 12;
                }
                return result;
            };
            const textPanel = document.createElement("div");
            textPanel.style.cssText = "display:flex;flex:1 1 auto;flex-direction:column;gap:6px;min-width:0;height:100%";
            const output = document.createElement("textarea");
            output.readOnly = true;
            output.placeholder = "提示词会显示在这里";
            output.style.cssText = "box-sizing:border-box;flex:1 1 auto;min-height:0;width:100%;resize:none;background:#171717;color:#e8e8e8;border:1px solid #555;border-radius:4px;padding:7px;font:12px monospace;white-space:pre-wrap;overflow:auto";
            const fontSizeLabel = document.createElement("span");
            fontSizeLabel.style.cssText = "flex:0 0 auto;color:#b9c7d8;font-size:11px;white-space:nowrap";
            const makeFontButton = (label) => {
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = label;
                button.style.cssText = "flex:0 0 auto;height:26px;background:#37465b;color:#fff;border:1px solid #6b8caf;border-radius:4px;padding:3px 7px;cursor:pointer;font-size:11px";
                return button;
            };
            const decreaseFontButton = makeFontButton("字体 −");
            const increaseFontButton = makeFontButton("字体 +");
            const setOutputFontSize = (value) => {
                const size = Math.max(9, Math.min(22, Number(value) || 12));
                this.properties[FONT_SIZE_KEY] = size;
                output.style.fontSize = `${size}px`;
                fontSizeLabel.textContent = `${size}px`;
                this.setDirtyCanvas(true, true);
            };
            if (isImageInputNode) {
                decreaseFontButton.addEventListener("click", () => setOutputFontSize((this.properties[FONT_SIZE_KEY] || 12) - 1));
                increaseFontButton.addEventListener("click", () => setOutputFontSize((this.properties[FONT_SIZE_KEY] || 12) + 1));
                setOutputFontSize(this.properties[FONT_SIZE_KEY] || 12);
            }
            const headerControls = document.createElement("div");
            headerControls.style.cssText = "display:flex;gap:6px;align-items:center;min-width:0";
            headerControls.append(status);
            if (isImageInputNode) headerControls.append(decreaseFontButton, fontSizeLabel, increaseFontButton, imageVisibilityButton);
            textPanel.append(headerControls, folderControls, output);
            container.append(picker, dropZone, textPanel);
            const layoutHeight = () => Math.max(0, Math.floor((this.size?.[1] || 0) - 42));
            const resizeLayout = () => {
                const height = layoutHeight();
                const innerWidth = Math.max(0, Math.floor((this.size?.[0] || 0) - 18));
                const imageWidth = this.properties[SHOW_IMAGE_KEY] === false
                    ? 0
                    : Math.max(0, Math.min(height, Math.floor(innerWidth * 0.38)));
                container.style.height = `${height}px`;
                dropZone.style.flexBasis = `${imageWidth}px`;
                dropZone.style.width = `${imageWidth}px`;
            };
            const imageWidget = this.addDOMWidget("image_file", "customtext", container, {
                getValue: () => promptWidget?.value || "",
                setValue: () => {},
                // This is deliberately fixed from LiteGraph's perspective.
                // The DOM itself still follows node.size in resizeLayout(), but
                // reporting node height here makes LiteGraph enlarge the node.
                getMinHeight: () => 308,
                getMaxHeight: () => 308,
            });
            imageWidget.computeSize = (width) => [width, 308];
            const previousOnResize = this.onResize;
            this.onResize = function (...args) {
                const result = previousOnResize?.apply(this, args);
                resizeLayout();
                return result;
            };
            let previewUrl = null;
            const applyPngBlob = async (blob, label) => {
                if (!blob) return;
                if (blob.type && blob.type !== "image/png" && !String(label).toLowerCase().includes(".png")) {
                    status.textContent = "请选择 PNG 图片。";
                    return;
                }
                status.textContent = `正在读取：${label}`;
                try {
                    if (previewUrl) URL.revokeObjectURL(previewUrl);
                    previewUrl = URL.createObjectURL(blob);
                    preview.src = previewUrl;
                    preview.style.display = "block";
                    dropZone.style.borderStyle = "solid";
                    dropZone.textContent = "";
                    dropZone.append(preview);
                    const metadata = pngTextChunks(await blob.arrayBuffer());
                    const value = formatPrompt(metadata.prompt, metadata.workflow);
                    output.value = value;
                    if (promptWidget) promptWidget.value = value;
                    status.textContent = metadata.prompt ? `已读取：${label}（未运行）` : `已读取：${label}，但没有 prompt 元数据`;
                    this.setDirtyCanvas(true, true);
                } catch (error) {
                    output.value = "";
                    if (promptWidget) promptWidget.value = "";
                    status.textContent = `读取失败：${error.message || error}`;
                }
            };
            const loadFile = (file) => applyPngBlob(file, file?.name || "本地图片");
            const loadImageUrl = async (url, label = "浏览器图片") => {
                if (!url) return;
                status.textContent = `正在读取：${label}`;
                try {
                    const response = await fetch(url, { cache: "no-store" });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    await applyPngBlob(await response.blob(), label);
                } catch (error) {
                    status.textContent = `无法读取浏览器图片：${error.message || error}。请拖入原始 PNG 文件。`;
                }
            };
            const readLinkedLoadImage = async () => {
                if (nodeData.name !== "ImagePromptExtractorImageInput") return;
                const source = this.getInputNode?.(0);
                const imageName = source?.widgets?.find((widget) => widget.name === "image")?.value;
                if (!imageName || !/LoadImage/i.test(source?.type || source?.constructor?.type || "")) return;
                const url = new URL("/view", window.location.origin);
                url.searchParams.set("filename", imageName);
                url.searchParams.set("type", "input");
                await loadImageUrl(url, `图像输入：${imageName}`);
            };
            picker.addEventListener("change", () => loadFile(picker.files?.[0]));
            dropZone.addEventListener("click", () => picker.click());
            for (const eventName of ["dragenter", "dragover", "dragleave", "drop"]) {
                container.addEventListener(eventName, (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                });
            }
            container.addEventListener("dragenter", () => {
                dropZone.style.borderColor = "#55a7ff";
                dropZone.style.background = "#172535";
            });
            container.addEventListener("dragleave", () => {
                dropZone.style.borderColor = "#6b7b91";
                dropZone.style.background = "#15191e";
            });
            container.addEventListener("drop", (event) => {
                dropZone.style.borderColor = "#6b7b91";
                dropZone.style.background = "#15191e";
                const file = event.dataTransfer?.files?.[0];
                if (file) loadFile(file);
                else loadImageUrl(draggedImageUrl(event.dataTransfer));
            });
            if (nodeData.name === "ImagePromptExtractorImageInput") {
                const previousOnConnectionsChange = this.onConnectionsChange;
                this.onConnectionsChange = function () {
                    const result = previousOnConnectionsChange?.apply(this, arguments);
                    setTimeout(() => readLinkedLoadImage(), 0);
                    return result;
                };
                const previousOnConfigureInput = this.onConfigure;
                this.onConfigure = function () {
                    const result = previousOnConfigureInput?.apply(this, arguments);
                    setTimeout(() => readLinkedLoadImage(), 0);
                    return result;
                };
            }
            const previousOnRemoved = this.onRemoved;
            this.onRemoved = function () {
                if (previewUrl) URL.revokeObjectURL(previewUrl);
                return previousOnRemoved?.apply(this, arguments);
            };
            this.setSize([720, 350]);
            resizeLayout();
        };
    },
});
