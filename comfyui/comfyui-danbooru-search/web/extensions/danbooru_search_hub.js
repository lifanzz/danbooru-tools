import { app } from "../../../scripts/app.js";
import { searchCatalogue } from "../lib/danbooru_catalogue.js";

const NODE_TYPE = "DanbooruSearchHub";
const NODE_TITLE = "本地danbooru搜索器";
const SEARCH_DEBOUNCE_MS = 140;
const WIDGET_HEIGHT = 423;
const NODE_CONTENT_OFFSET = 37;

function setStatus(status, message) {
    if (status) status.textContent = message;
}

function compactLabel(tag) {
    const rawEnglish = String(tag?.name || "").replaceAll("_", " ");
    const english = rawEnglish ? rawEnglish[0].toUpperCase() + rawEnglish.slice(1) : rawEnglish;
    const chinese = String(tag?.tag_cn || "");
    return chinese ? `${chinese} ${english}` : english;
}

function resizeLayout(node, setInitialSize = false) {
    if (setInitialSize) node.setSize([Math.max(node.size?.[0] || 0, 620), 460]);
    if (node._danbooruContainer) {
        node._danbooruContainer.style.height = `${Math.max(55, (node.size?.[1] || 460) - NODE_CONTENT_OFFSET)}px`;
    }
}

function syncDynamicWidth(node) {
    const width = Math.max(220, Math.floor((node.size?.[0] || 620) - 22));
    if (node._danbooruContainer) node._danbooruContainer.style.width = `${width}px`;
}

function bindDynamicResultHeight(node) {
    if (node._danbooruResizeBound) return;
    node._danbooruResizeBound = true;
    const previousOnResize = node.onResize;
    node.onResize = function (...args) {
        const result = previousOnResize?.apply(this, args);
        resizeLayout(this);
        syncDynamicWidth(this);
        this.setDirtyCanvas(true, true);
        return result;
    };
}

function scheduleSearch(node) {
    clearTimeout(node._danbooruSearchTimer);
    node._danbooruSearchRequest += 1;
    node._danbooruHasQuery = Boolean(String(node._danbooruSearchInput?.value || "").trim());
    node._danbooruLoading = node._danbooruHasQuery;
    node._danbooruResults = { tags: [], characters: [], models: [] };
    node._danbooruErrors = { tags: "", characters: "", models: "" };
    setStatus(node._danbooruStatus, node._danbooruHasQuery
        ? "正在搜索本地标签、角色提示词组和模型…"
        : "请输入标签、角色名、外观特征或模型关键词。");
    renderResults(node);
    node._danbooruSearchTimer = setTimeout(() => search(node), SEARCH_DEBOUNCE_MS);
}

function renderResults(node) {
    const panel = node._danbooruResultsPanel;
    if (!panel) return;
    panel.replaceChildren();
    const { tags, characters, models } = node._danbooruResults;
    if (!node._danbooruHasQuery || node._danbooruLoading) {
        const hint = document.createElement("div");
        hint.textContent = node._danbooruLoading ? "正在搜索本地标签、角色提示词组和模型…" : "输入关键词，同时搜索本地标签、角色提示词组和模型。";
        Object.assign(hint.style, {
            gridColumn: "1 / -1", color: "#98a2b8", textAlign: "center", padding: "20px 8px", fontSize: "12px",
        });
        panel.append(hint);
        node.setDirtyCanvas(true, true);
        return;
    }
    const addSection = (label, count) => {
        if (count === 0) return;
        const heading = document.createElement("div");
        heading.textContent = `${label} · ${count}`;
        Object.assign(heading.style, {
            gridColumn: "1 / -1", color: "#aebaff", fontWeight: "700", fontSize: "12px",
            padding: "7px 2px 4px", borderBottom: "1px solid #454b68",
        });
        panel.append(heading);
    };

    addSection("本地标签", tags.length);
    tags.forEach((tag) => {
        const card = document.createElement("button");
        card.type = "button";
        card.title = "点击复制标签";
        card.textContent = compactLabel(tag);
        Object.assign(card.style, {
            boxSizing: "border-box", width: "100%", minWidth: "0", height: "28px", overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left", cursor: "pointer",
            color: "#e9ecff", background: "#1b1f36", border: "1px solid #434c83", borderRadius: "6px",
            padding: "0 7px", fontSize: "11px",
        });
        card.addEventListener("mouseenter", () => { card.style.borderColor = "#8190ff"; card.style.background = "#232947"; });
        card.addEventListener("mouseleave", () => { card.style.borderColor = "#434c83"; card.style.background = "#1b1f36"; });
        card.addEventListener("click", () => copyResult(node, tag.copy_text || tag.name || "", `已复制：${compactLabel(tag)}`));
        panel.append(card);
    });

    addSection("角色提示词组", characters.length);
    characters.forEach((result) => {
        const card = document.createElement("button");
        card.type = "button";
        card.title = "点击复制完整角色提示词";
        Object.assign(card.style, {
            boxSizing: "border-box", gridColumn: "1 / -1", width: "100%", display: "block", textAlign: "left", cursor: "pointer",
            color: "#e9ecff", background: "#1b1f36", border: "1px solid #434c83", borderRadius: "7px",
            padding: "9px 10px", font: "inherit",
        });
        card.addEventListener("mouseenter", () => { card.style.borderColor = "#8190ff"; card.style.background = "#232947"; });
        card.addEventListener("mouseleave", () => { card.style.borderColor = "#434c83"; card.style.background = "#1b1f36"; });
        card.addEventListener("click", () => copyResult(node, result.copy_text || result.name || "", `已复制【${result.group_name}】${result.display_name}。`));

        const title = document.createElement("div");
        title.textContent = result.display_name || result.name || "未命名角色";
        Object.assign(title.style, { fontWeight: "700", fontSize: "14px", lineHeight: "1.25", color: "#f2f4ff" });
        const meta = document.createElement("div");
        meta.textContent = `${result.group_name || "角色组"} · ${result.has_full_prompt ? "完整提示词" : "角色触发词"}`;
        Object.assign(meta.style, { color: "#94a4ff", fontSize: "11px", marginTop: "3px" });
        const prompt = document.createElement("div");
        prompt.textContent = result.copy_text || result.name || "";
        Object.assign(prompt.style, {
            color: "#c6cce8", fontFamily: "Consolas, 'Microsoft YaHei', monospace", fontSize: "11px",
            lineHeight: "1.48", marginTop: "6px", wordBreak: "break-word", overflowWrap: "anywhere",
        });
        card.append(title, meta, prompt);
        panel.append(card);
    });
    addSection("模型", models.length);
    models.forEach((result) => {
        const card = document.createElement("article");
        card.className = "danbooru-model-card";
        Object.assign(card.style, {
            boxSizing: "border-box", gridColumn: "1 / -1", minWidth: "0",
            display: "flex", alignItems: "flex-start", gap: "12px",
            color: "#e9ecff", background: "#1b1f36", border: "1px solid #434c83",
            borderRadius: "7px", padding: "9px 10px",
        });
        const body = document.createElement("div");
        body.className = "danbooru-model-body";
        Object.assign(body.style, { flex: "1 1 auto", minWidth: "0" });
        const title = document.createElement("div");
        title.textContent = result.set_name || result.name || "未命名模型";
        Object.assign(title.style, { fontWeight: "700", fontSize: "14px", overflowWrap: "anywhere" });
        body.append(title);
        if (result.set_name) {
            const modelName = document.createElement("div");
            modelName.textContent = result.name || "未命名模型";
            Object.assign(modelName.style, { color: "#94a4ff", fontSize: "11px", marginTop: "3px", overflowWrap: "anywhere" });
            body.append(modelName);
        }
        card.append(body);
        const promptText = String(result.prompt || "").trim();
        if (promptText) {
            const prompt = document.createElement("button");
            prompt.type = "button";
            prompt.className = "danbooru-model-prompt";
            prompt.title = "点击复制常用提示词";
            prompt.textContent = promptText;
            Object.assign(prompt.style, {
                display: "block", width: "100%", marginTop: "6px", padding: "0", border: "0",
                background: "transparent", color: "#c6cce8", textAlign: "left", cursor: "pointer",
                fontFamily: "Consolas, 'Microsoft YaHei', monospace", fontSize: "11px",
                lineHeight: "1.48", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
            });
            prompt.addEventListener("click", () => copyResult(node, promptText, `已复制【${result.set_name || result.name}】常用提示词。`));
            body.append(prompt);
        }
        const imageURL = String(result.image_url || "").trim();
        if (imageURL && ["http:", "https:"].includes(new URL(imageURL, window.location.origin).protocol)) {
            const cover = document.createElement("img");
            cover.alt = `${result.set_name || result.name || "模型"} 封面`;
            Object.assign(cover.style, {
                display: "none", flexShrink: "0", maxWidth: "30%", maxHeight: "200px", width: "140px", height: "auto",
                borderRadius: "5px", objectFit: "contain",
            });
            cover.addEventListener("load", () => { cover.style.display = "block"; });
            cover.addEventListener("error", () => cover.remove());
            cover.src = imageURL;
            card.prepend(cover);
        }
        panel.append(card);
    });
    node.setDirtyCanvas(true, true);
}

async function search(node) {
    const query = String(node._danbooruSearchInput?.value || "").trim();
    const requestId = ++node._danbooruSearchRequest;
    node._danbooruHasQuery = Boolean(query);
    node._danbooruLoading = node._danbooruHasQuery;
    node._danbooruResults = { tags: [], characters: [], models: [] };
    node._danbooruErrors = { tags: "", characters: "", models: "" };
    if (!query) {
        setStatus(node._danbooruStatus, "请输入标签、角色名、外观特征或模型关键词。");
        renderResults(node);
        return;
    }

    setStatus(node._danbooruStatus, "正在搜索本地标签、角色提示词组和模型…");
    renderResults(node);
    const [tagResult, characterResult, modelResult] = await searchCatalogue(query, {
        matchLongDescription: node.properties.danbooruMatchLongDescription,
    });
    if (requestId !== node._danbooruSearchRequest) return;
    node._danbooruLoading = false;
    node._danbooruResults.tags = tagResult.status === "fulfilled" ? tagResult.value : [];
    node._danbooruResults.characters = characterResult.status === "fulfilled" ? characterResult.value : [];
    node._danbooruErrors.tags = tagResult.status === "rejected" ? String(tagResult.reason?.message || tagResult.reason) : "";
    node._danbooruErrors.characters = characterResult.status === "rejected" ? String(characterResult.reason?.message || characterResult.reason) : "";
    node._danbooruResults.models = modelResult.status === "fulfilled" ? modelResult.value : [];
    node._danbooruErrors.models = modelResult.status === "rejected" ? String(modelResult.reason?.message || modelResult.reason) : "";
    const summary = [
        tagsSummary(node._danbooruResults.tags.length, "标签", "条"),
        tagsSummary(node._danbooruResults.characters.length, "角色", "张"),
        tagsSummary(node._danbooruResults.models.length, "模型提示词组", "套"),
    ].filter(Boolean).join(" · ");
    const failures = [node._danbooruErrors.tags && "标签读取失败", node._danbooruErrors.characters && "角色读取失败", node._danbooruErrors.models && "模型读取失败"].filter(Boolean);
    setStatus(node._danbooruStatus, [summary, failures.join("、")].filter(Boolean).join(" · "));
    renderResults(node);
}

function tagsSummary(count, label, unit) {
    return count ? `${label} ${count} ${unit}` : "";
}

async function copyResult(node, text, successMessage) {
    const copyText = String(text || "");
    try {
        await navigator.clipboard.writeText(copyText);
        setStatus(node._danbooruStatus, successMessage);
    } catch {
        setStatus(node._danbooruStatus, `复制失败，请手动复制：${copyText}`);
    }
    node.setDirtyCanvas(true, true);
}

async function openManager(button, node) {
    button.disabled = true;
    setStatus(node._danbooruStatus, "正在检查并打开 Danbooru 标签管理器…");
    try {
        const endpoint = new URL("/danbooru_tools/open_danbooru", window.location.origin);
        const query = String(node._danbooruSearchInput?.value || "").trim();
        if (query) endpoint.searchParams.set("search", query);
        const response = await fetch(endpoint, { method: "POST" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
        setStatus(node._danbooruStatus, result.running ? "已打开 Danbooru 标签管理器。" : (result.message || "Danbooru 标签管理器正在启动…"));
    } catch (error) {
        setStatus(node._danbooruStatus, `打开失败：${error.message}`);
    } finally {
        button.disabled = false;
    }
}

function install(node, setInitialSize = false) {
    if (node._danbooruSearchHubInstalled) return;
    node._danbooruSearchHubInstalled = true;
    if (!node.title || node.title === "Danbooru 标签与角色提示词搜索") node.title = NODE_TITLE;
    node._danbooruResults = { tags: [], characters: [], models: [] };
    node._danbooruErrors = { tags: "", characters: "", models: "" };
    node._danbooruHasQuery = false;
    node._danbooruLoading = false;
    node._danbooruSearchRequest = 0;
    node.properties ||= {};
    node.properties.danbooruMatchLongDescription = node.properties.danbooruMatchLongDescription === true;

    const controls = document.createElement("div");
    Object.assign(controls.style, {
        boxSizing: "border-box", width: "100%", flex: "0 0 29px", display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 105px",
        gap: "5px", padding: "1px 0",
    });
    const styleControl = (element) => Object.assign(element.style, {
        boxSizing: "border-box", width: "100%", minWidth: "0", height: "27px", borderRadius: "5px",
        border: "1px solid #5a6077", background: "#24252d", color: "#e9ebf7", fontSize: "12px", padding: "0 7px",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
    });
    const styleButton = (button) => {
        styleControl(button);
        button.style.cursor = "pointer";
        button.addEventListener("mouseenter", () => { button.style.borderColor = "#919dff"; });
        button.addEventListener("mouseleave", () => { button.style.borderColor = "#5a6077"; });
    };

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    styleControl(searchInput);
    searchInput.placeholder = "搜索标签、角色提示词和模型";
    searchInput.title = "输入即同时搜索本地标签、角色提示词组与模型";
    node._danbooruSearchInput = searchInput;
    searchInput.addEventListener("input", () => scheduleSearch(node));
    searchInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            clearTimeout(node._danbooruSearchTimer);
            search(node);
        }
    });

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.textContent = "打开管理器";
    openButton.title = "打开 Danbooru 标签管理器";
    styleButton(openButton);
    openButton.addEventListener("click", () => openManager(openButton, node));
    controls.append(searchInput, openButton);

    const options = document.createElement("label");
    Object.assign(options.style, {
        flex: "0 0 25px", display: "flex", alignItems: "center", gap: "5px",
        color: "#c6cce8", fontSize: "12px", cursor: "pointer",
    });
    options.title = "开启后也匹配标签和角色提示词组的详细说明；随工作流保存";
    const matchLongDescription = document.createElement("input");
    matchLongDescription.type = "checkbox";
    matchLongDescription.checked = node.properties.danbooruMatchLongDescription;
    matchLongDescription.style.accentColor = "#8190ff";
    matchLongDescription.addEventListener("change", () => {
        node.properties.danbooruMatchLongDescription = matchLongDescription.checked;
        scheduleSearch(node);
    });
    options.append(matchLongDescription, document.createTextNode("匹配长说明"));
    const previousOnConfigure = node.onConfigure;
    node.onConfigure = function (...args) {
        const result = previousOnConfigure?.apply(this, args);
        if (!this.title || this.title === "Danbooru 标签与角色提示词搜索") this.title = NODE_TITLE;
        this.properties.danbooruMatchLongDescription = this.properties.danbooruMatchLongDescription === true;
        matchLongDescription.checked = this.properties.danbooruMatchLongDescription;
        scheduleSearch(this);
        return result;
    };

    const resultsPanel = document.createElement("div");
    Object.assign(resultsPanel.style, {
        boxSizing: "border-box", width: "100%", minHeight: "0", flex: "1 1 auto", display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gridAutoRows: "min-content", gap: "5px",
        alignContent: "start",
        overflowY: "auto", padding: "2px 1px 2px 0", scrollbarColor: "#5f6cc2 #16192a",
    });
    const status = document.createElement("div");
    Object.assign(status.style, {
        boxSizing: "border-box", width: "100%", flex: "0 0 26px", padding: "5px 8px", color: "#a9d6ff",
        fontSize: "11px", lineHeight: "14px", textAlign: "center", borderTop: "1px solid #454b68",
    });
    setStatus(status, "输入关键词，同时搜索本地标签、角色提示词组和模型。");
    const container = document.createElement("div");
    Object.assign(container.style, {
        boxSizing: "border-box", width: "100%", height: `${WIDGET_HEIGHT}px`,
        display: "flex", flexDirection: "column", minHeight: "0",
    });
    container.append(controls, options, resultsPanel, status);
    node._danbooruContainer = container;
    node._danbooruStatus = status;
    node._danbooruResultsPanel = resultsPanel;
    node._danbooruControls = controls;

    const widget = node.addDOMWidget("Danbooru 搜索", "danbooru-search", container, {
        serialize: false, hideOnZoom: true,
        getMinHeight: () => WIDGET_HEIGHT, getMaxHeight: () => WIDGET_HEIGHT,
    });
    widget.computeSize = (width) => [width, WIDGET_HEIGHT];

    bindDynamicResultHeight(node);
    resizeLayout(node, setInitialSize);
    syncDynamicWidth(node);
    renderResults(node);

    const previousOnRemoved = node.onRemoved;
    node.onRemoved = function (...args) {
        clearTimeout(this._danbooruSearchTimer);
        this._danbooruSearchRequest += 1;
        return previousOnRemoved?.apply(this, args);
    };
}

app.registerExtension({
    name: "DanbooruTools.SearchHub",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === NODE_TYPE) nodeData.display_name = NODE_TITLE;
    },
    nodeCreated(node) {
        if (node.constructor.type === NODE_TYPE) install(node, true);
    },
    loadedGraphNode(node) {
        if (node.type === NODE_TYPE) install(node, false);
    },
});
