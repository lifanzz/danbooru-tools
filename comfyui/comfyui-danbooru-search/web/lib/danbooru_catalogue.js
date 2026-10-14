// Read the manager's canonical snapshot and matching rules; never write its data.
const MANAGER_URL = (await readJSON("/danbooru_tools/config")).manager_url;
let enginePromise;

async function readJSON(url) {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    return payload;
}

async function searchEngine() {
    if (!enginePromise) {
        enginePromise = import(`${MANAGER_URL}assets/search-engine.js`).then(() => {
            if (!window.DanbooruSearch) throw new Error("管理器搜索规则未加载");
            return window.DanbooruSearch;
        }).catch((error) => { enginePromise = null; throw error; });
    }
    return enginePromise;
}

function characterURL(group) {
    if (!group.content_file) throw new Error(`角色分组 ${group.name_cn || group.id} 缺少 content_file`);
    const url = new URL(group.content_file, MANAGER_URL);
    if (url.origin !== new URL(MANAGER_URL).origin || !url.pathname.startsWith("/data/translated/")) {
        throw new Error(`角色分组 ${group.name_cn || group.id} 的 content_file 无效`);
    }
    return url;
}

async function backendResults(path, query, matchLongDescription) {
    const url = new URL(path, window.location.origin);
    url.searchParams.set("query", query);
    url.searchParams.set("match_long_description", String(matchLongDescription));
    const payload = await readJSON(url);
    return Array.isArray(payload.results) ? payload.results : [];
}

async function modelResults(query) {
    try {
        const [models, engine] = await Promise.all([
            readJSON(`${MANAGER_URL}data/models.json`), searchEngine(),
        ]);
        return models.flatMap(model => {
            const sets = Array.isArray(model.prompt_sets) && model.prompt_sets.length
                ? model.prompt_sets : [{ name: "", prompt: model.prompt, image_url: model.image_url }];
            return sets.filter(set => engine.matchesModel({ ...model, prompt: set.prompt, prompt_sets: [set] }, query))
                .map(set => ({
                    name: model.name, set_name: String(set.name || "").trim(),
                    prompt: String(set.prompt || "").trim(), image_url: modelCoverURL(set.image_url),
                }));
        });
    } catch {
        return backendResults("/danbooru_tools/search_models", query, false);
    }
}

function modelCoverURL(value) {
    const path = String(value || "").trim().replaceAll("\\", "/");
    if (/^\/?data\/model_images\/[a-f0-9]{32}\.(png|jpe?g|webp|gif)$/i.test(path)) {
        return new URL(path, MANAGER_URL).href;
    }
    try {
        const url = new URL(path);
        return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch {
        return "";
    }
}

export async function searchCatalogue(query, { matchLongDescription = false } = {}) {
    const models = Promise.allSettled([modelResults(query)]);
    let catalogue, engine;
    try {
        [catalogue, engine] = await Promise.all([
            readJSON(`${MANAGER_URL}api/catalogue`), searchEngine(),
        ]);
        if (!Array.isArray(catalogue.tags) || !Array.isArray(catalogue.groups)) {
            throw new Error("管理器标签库结构无效");
        }
    } catch (error) {
        // The on-disk backend also works when the tray service is closed.
        const results = await Promise.allSettled([
            backendResults("/danbooru_tools/search_danbooru", query, matchLongDescription),
            backendResults("/danbooru_tools/search_character_prompts", query, matchLongDescription),
        ]);
        return [...results, ...await models];
    }
    const { tags, groups } = catalogue;
    const terms = engine.terms(query);
    const options = { excludeCharacters: true };
    const ordinary = tags.filter(tag => engine.visible(tag, groups, options) && engine.matches(tag, terms, { matchLongDescription }))
        .map(tag => ({ ...tag, copy_text: tag.name, description: tag.tag_cn_long || "", kind: "tag" }))
        .sort((a, b) => Number(b.pinned || false) - Number(a.pinned || false) || a.name.localeCompare(b.name));
    const characters = async () => {
        const lists = await Promise.all(groups.filter(engine.isCharacterGroup).map(async group => {
            const data = await readJSON(characterURL(group));
            return (data.tags || []).filter(tag => engine.matches(tag, terms, { characterLibrary: true, matchLongDescription }))
                .map(tag => ({
                    group_id: group.id, group_name: group.name_cn || group.id,
                    display_name: tag.tag_cn || tag.name, name: tag.name,
                    copy_text: tag.prompt || tag.name, description: tag.tag_cn_long || "",
                    has_full_prompt: Boolean(tag.prompt), kind: tag.prompt ? "preset" : "character",
                }));
        }));
        return lists.flat().sort((a, b) => Number(b.has_full_prompt) - Number(a.has_full_prompt)
            || a.display_name.localeCompare(b.display_name));
    };
    const results = await Promise.allSettled([Promise.resolve(ordinary), characters()]);
    return [...results, ...await models];
}
