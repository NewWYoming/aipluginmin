import { ConfigManager } from "./configManager";

export class BackendConfig {
    static ext: seal.ExtInfo;

    static register() {
        BackendConfig.ext = ConfigManager.getExt('aiplugin4_6:后端');

        seal.ext.registerStringConfig(BackendConfig.ext, "图片转base64", "https://urltobase64.fishwhite.top", '可自行搭建');
        seal.ext.registerStringConfig(BackendConfig.ext, "联网搜索", "https://searxng.fishwhite.top", '可自行搭建');
        seal.ext.registerStringConfig(BackendConfig.ext, "网页读取", "https://r.jinaai.cn", "Jina Reader（国内镜像），可自行搭建");
        seal.ext.registerStringConfig(BackendConfig.ext, "用量图表", "http://usagechart.error2913.com", '可自行搭建');
        seal.ext.registerStringConfig(BackendConfig.ext, "md和html图片渲染", "https://md.fishwhite.top", '可自行搭建');
        seal.ext.registerStringConfig(BackendConfig.ext, "Jina API Key", "", "Jina AI 搜索和网页读取的 API Key。留空时搜索使用 SearXNG，网页读取使用 Jina Reader 20 RPM 免费额度（国内镜像 jinaai.cn）");

        // TTS
        seal.ext.registerBoolConfig(BackendConfig.ext, "启用 TTS", false,
            "开启后，配置了 API Key 时 AI 可使用 text_to_sound 工具");
        seal.ext.registerOptionConfig(BackendConfig.ext, "TTS 服务商",
            "阿里云 DashScope", ["阿里云 DashScope"], "");
        seal.ext.registerStringConfig(BackendConfig.ext, "TTS API Key", "",
            "DashScope API Key（sk-开头）");
        seal.ext.registerStringConfig(BackendConfig.ext, "TTS 音色", "longanyang",
            "发音人。DashScope 推荐: longanyang, longchen, Cherry");
        seal.ext.registerTemplateConfig(BackendConfig.ext, "TTS 额外参数", [''],
            "JSON 参数，合并到请求的 input 字段。例如: {\"rate\": 1.2}");
    }

    static get() {
        return {
            imageTobase64Url: seal.ext.getStringConfig(BackendConfig.ext, "图片转base64"),
            webSearchUrl: seal.ext.getStringConfig(BackendConfig.ext, "联网搜索"),
            webReadUrl: seal.ext.getStringConfig(BackendConfig.ext, "网页读取"),
            usageChartUrl: seal.ext.getStringConfig(BackendConfig.ext, "用量图表"),
            renderUrl: seal.ext.getStringConfig(BackendConfig.ext, "md和html图片渲染"),
            jinaApiKey: seal.ext.getStringConfig(BackendConfig.ext, "Jina API Key"),
            ttsEnabled: (seal.ext.getBoolConfig(BackendConfig.ext, "启用 TTS")) || false,
            ttsProvider: seal.ext.getOptionConfig(BackendConfig.ext, "TTS 服务商"),
            ttsApiKey: seal.ext.getStringConfig(BackendConfig.ext, "TTS API Key"),
            ttsVoice: seal.ext.getStringConfig(BackendConfig.ext, "TTS 音色"),
            ttsExtraBody: seal.ext.getTemplateConfig(BackendConfig.ext, "TTS 额外参数") || '',
        }
    }
}
