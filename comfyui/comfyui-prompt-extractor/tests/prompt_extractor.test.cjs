const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../web/js/prompt_extractor.js"), "utf8");
const context = { TextDecoder };
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf("function readUint32"), source.indexOf("function draggedImageUrl")), context);
const { formatPrompt, textEntries } = context;
const node = (class_type, inputs) => ({ class_type, inputs });
const graph = (encoder) => ({
    "1": encoder,
    "2": node("CLIPTextEncode", { text: "bad quality" }),
    "3": node("KSampler", { positive: ["1", 0], negative: ["2", 0] }),
    "4": node("VAEDecode", { samples: ["3", 0] }),
    "5": node("SaveImage", { images: ["4", 0] }),
});
let cases = 0;
function check(name, run) { run(); cases++; console.log(`PASS ${name}`); }

check("ordinary CLIP and disconnected old prompt", () => {
    const g = graph(node("CLIPTextEncode", { text: "a blonde girl" }));
    g["99"] = node("CLIPTextEncode", { text: "UNCONNECTED" });
    assert.equal(formatPrompt(JSON.stringify(g)), "正向提示词\na blonde girl\n负向提示词\nbad quality");
});
check("final image chain beats node numbering", () => {
    const g = graph(node("CLIPTextEncode", { text: "FINAL" }));
    g["100"] = node("KSampler", { positive: ["101", 0] });
    g["101"] = node("CLIPTextEncode", { text: "OLD" });
    g["3"].inputs.latent_image = ["100", 0];
    assert.equal(textEntries(g).samplerId, "3");
    assert.ok(!formatPrompt(JSON.stringify(g)).includes("OLD"));
});
check("segmented ULS respects active fields and disabled negative", () => {
    const g = graph(node("ULSCLIPTextEncode", {
        segments: 2, pos_1: "// notes\ngirl", pos_2: "red eyes\nwhite shirt", pos_3: "HIDDEN",
        use_negative: false, neg_1: "DISABLED", strip_comments: true, strip_newlines: true,
        separator: "comma", external_mode: "append", pos_external: "SFW",
    }));
    g["3"].inputs.negative = ["1", 1];
    assert.equal(formatPrompt(JSON.stringify(g)), "正向提示词\ngirl, red eyes white shirt, SFW");
});
check("ULS comments preserve URLs and separator replace", () => {
    const g = graph(node("ULSCLIPTextEncode", {
        segments: 1, pos_1: "https://example.com // comment\nred eyes", use_negative: true,
        neg_1: "bad", neg_external: "new negative", separator: "newline", strip_comments: true,
        strip_newlines: false, external_mode: "replace", comment_markers: "// #",
    }));
    g["3"].inputs.negative = ["1", 1];
    assert.equal(formatPrompt(JSON.stringify(g)), "正向提示词\nhttps://example.com\nred eyes\n负向提示词\nnew negative");
});
check("recursive VariableTextJoin", () => {
    const g = graph(node("CLIPTextEncode", { text: ["10", 0] }));
    g["10"] = node("VariableTextJoin", { input_count: 2, delimiter: "; ", text_1: ["11", 0], text_2: "eyes" });
    g["11"] = node("PrimitiveStringMultiline", { value: "girl" });
    assert.equal(textEntries(g).positive.join(""), "girl; eyes");
});
check("generic role fields separate dual outputs and mark inference", () => {
    const g = graph(node("FutureEncoder", { positive_prompt: "girl", negative_prompt: "bad", model_name: "IGNORE" }));
    g["3"].inputs.negative = ["1", 1];
    const result = formatPrompt(JSON.stringify(g));
    assert.ok(result.startsWith("正向提示词\ngirl\n负向提示词\nbad\n解析说明"));
    assert.ok(!result.includes("IGNORE"));
});
check("generic linked prompt text", () => {
    const g = graph(node("FutureEncoder", { positive_prompt: ["10", 0] }));
    g["10"] = node("PrimitiveString", { value: "linked girl" });
    assert.equal(textEntries(g).positive.join(""), "linked girl");
});
check("SDXL two encoders", () => {
    const g = graph(node("CLIPTextEncodeSDXL", { text_g: "global", text_l: "local" }));
    assert.equal(textEntries(g).positive.join(";"), "global;local");
});
check("ControlNet and conditioning branches", () => {
    const g = graph(node("ControlNetApplyAdvanced", { positive: ["10", 0], negative: ["2", 0], image: ["90", 0], strength: 0.8 }));
    g["10"] = node("ConditioningCombine", { conditioning_1: ["11", 0], conditioning_2: ["12", 0] });
    g["11"] = node("CLIPTextEncode", { text: "girl" });
    g["12"] = node("CLIPTextEncode", { text: "garden" });
    g["90"] = node("LoadImage", { image: "IGNORE.png" });
    assert.equal(textEntries(g).positive.join(";"), "girl;garden");
});
check("advanced sampler guider", () => {
    const g = graph(node("CLIPTextEncode", { text: "girl" }));
    g["3"] = node("SamplerCustomAdvanced", { guider: ["10", 0] });
    g["10"] = node("BasicGuider", { conditioning: ["1", 0] });
    assert.equal(textEntries(g).positive.join(""), "girl");
});
check("LLM template is not its output", () => {
    const g = graph(node("CLIPTextEncode", { text: ["10", 0] }));
    g["10"] = node("OllamaGenerate", { prompt: "SYSTEM TEMPLATE", system_prompt: "IGNORE", text: "IGNORE" });
    const result = formatPrompt(JSON.stringify(g));
    assert.ok(!result.includes("SYSTEM TEMPLATE") && !result.includes("IGNORE"));
    assert.ok(result.includes("无法完整还原"));
});
check("ShowText cache precedes LLM template", () => {
    const g = graph(node("CLIPTextEncode", { text: ["10", 0] }));
    g["10"] = node("ShowText|pysssss", { text: ["11", 0] });
    g["11"] = node("OllamaGenerate", { prompt: "IGNORE" });
    const workflow = { nodes: [{ id: 10, widgets_values: ["cached girl"] }] };
    assert.ok(formatPrompt(JSON.stringify(g), JSON.stringify(workflow)).startsWith("正向提示词\ncached girl"));
});
check("unknown text transformation is marked as an input candidate", () => {
    const g = graph(node("CLIPTextEncode", { text: ["10", 0] }));
    g["10"] = node("TranslateText", { text: "原始文本" });
    const result = formatPrompt(JSON.stringify(g));
    assert.ok(result.includes("保存的文本输入，运行时处理结果请核对"));
});
check("cycle terminates", () => {
    const g = graph(node("ConditioningSetArea", { conditioning: ["1", 0] }));
    assert.equal(textEntries(g).positive.length, 0);
});
check("synthetic PNG metadata fixture", () => {
    const zlib = require('node:zlib');
    const g = graph(node('CLIPTextEncode', { text: 'PUBLIC FIXTURE' }));
    function chunk(type, bytes) {
        const header = Buffer.alloc(8); header.writeUInt32BE(bytes.length); header.write(type, 4);
        return Buffer.concat([header, bytes, Buffer.alloc(4)]);
    }
    const raw = JSON.stringify(g);
    const chunks = [chunk('tEXt', Buffer.from('prompt\0' + raw)),
                    chunk('zTXt', Buffer.concat([Buffer.from('workflow\0\0'), zlib.deflateSync(Buffer.from('{}'))]))];
    // PNG chunk parsing is synchronous and only reads uncompressed prompt text.
    const buf = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunks[0], chunk('IEND', Buffer.alloc(0))]);
    const metadata = context.pngTextChunks(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    assert.equal(formatPrompt(metadata.prompt), '正向提示词\nPUBLIC FIXTURE\n负向提示词\nbad quality');
});
console.log(`${cases} cases passed`);
