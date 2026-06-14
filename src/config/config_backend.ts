import { ConfigManager } from "./configManager";

export class BackendConfig {
    static ext: seal.ExtInfo;

    static register() {
        BackendConfig.ext = ConfigManager.getExt('aiplugin4_6:后端');

        seal.ext.registerStringConfig(BackendConfig.ext, "图片转base64", "https://urltobase64.fishwhite.top", '可自行搭建');
        seal.ext.registerStringConfig(BackendConfig.ext, "联网搜索", "https://searxng.fishwhite.top", '可自行搭建');
        seal.ext.registerStringConfig(BackendConfig.ext, "网页读取", "https://r.jina.ai", '可自行搭建');
        seal.ext.registerStringConfig(BackendConfig.ext, "用量图表", "http://usagechart.error2913.com", '可自行搭建');
        seal.ext.registerStringConfig(BackendConfig.ext, "md和html图片渲染", "https://md.fishwhite.top", '可自行搭建');
        seal.ext.registerStringConfig(BackendConfig.ext, "Jina API Key", "", "Jina AI 搜索和网页读取的 API Key。留空时搜索使用 SearXNG，网页读取使用 Jina Reader 20 RPM 免费额度");
    }

    static get() {
        return {
            imageTobase64Url: seal.ext.getStringConfig(BackendConfig.ext, "图片转base64"),
            webSearchUrl: seal.ext.getStringConfig(BackendConfig.ext, "联网搜索"),
            webReadUrl: seal.ext.getStringConfig(BackendConfig.ext, "网页读取"),
            usageChartUrl: seal.ext.getStringConfig(BackendConfig.ext, "用量图表"),
            renderUrl: seal.ext.getStringConfig(BackendConfig.ext, "md和html图片渲染"),
            jinaApiKey: seal.ext.getStringConfig(BackendConfig.ext, "Jina API Key")
        }
    }
}
