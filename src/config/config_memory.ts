import { ConfigManager } from "./configManager";

export class MemoryConfig {
    static ext: seal.ExtInfo;

    static register() {
        MemoryConfig.ext = ConfigManager.getExt('aiplugin4_7:记忆');

        seal.ext.registerIntConfig(MemoryConfig.ext, "知识库记忆展示数量", 10, "");
        seal.ext.registerTemplateConfig(MemoryConfig.ext, "知识库记忆", [
            ``,
            `ID:测试
用户:用户1:114514,用户2:1919810
群聊:群聊1:114514,群聊2:1919810
关键词:关键词1,关键词2
图片:本地图片1的名字,本地图片2的名字
内容:这是内容
内容放在最后，可以换行
---
ID:上面是分割符
内容:用于多个知识词条的分割`
        ], "与角色设定一一对应");
        seal.ext.registerTemplateConfig(MemoryConfig.ext, "单条知识库记忆展示模板", [
            `   {{{序号}}}. 记忆ID:{{{记忆ID}}}
    相关用户:{{{用户列表}}}
    相关群聊:{{{群聊列表}}}
    关键词:{{{关键词}}}
    内容:{{{记忆内容}}}`
        ], "");
        seal.ext.registerBoolConfig(MemoryConfig.ext, "是否启用长期记忆", true, "");
        seal.ext.registerIntConfig(MemoryConfig.ext, "长期记忆上限", 50, "");
        seal.ext.registerIntConfig(MemoryConfig.ext, "长期记忆展示数量", 5, "");
        seal.ext.registerTemplateConfig(MemoryConfig.ext, "长期记忆展示模板", [
            `{{#if 私聊}}
### 关于用户<{{{用户名称}}}>{{#if 展示号码}}({{{用户号码}}}){{/if}}:
{{else}}
### 关于群聊<{{{群聊名称}}}>{{#if 展示号码}}({{{群聊号码}}}){{/if}}:
{{/if}}
    - 设定:{{{设定}}}
    - 记忆:
{{{记忆列表}}}`
        ], "");
        seal.ext.registerTemplateConfig(MemoryConfig.ext, "单条长期记忆展示模板", [
            `   {{{序号}}}. 记忆ID:{{{记忆ID}}}
    时间:{{{记忆时间}}}
{{#if 个人记忆}}
    来源:{{#if 私聊}}私聊{{else}}群聊<{{{群聊名称}}}>{{#if 展示号码}}({{{群聊号码}}}){{/if}}{{/if}}
{{/if}}
    相关用户:{{{相关用户}}}
    相关群聊:{{{相关群聊}}}
    关键词:{{{关键词}}}
    内容:{{{记忆内容}}}`
        ], "");
        // 印象层配置
        seal.ext.registerIntConfig(MemoryConfig.ext, "印象·最大观察消息数", 10, "连续收集多少条用户消息后自动生成印象");
        seal.ext.registerIntConfig(MemoryConfig.ext, "印象·最长天数", 3, "印象超过此天数未更新则触发刷新");
        seal.ext.registerIntConfig(MemoryConfig.ext, "印象·最大长度", 80, "印象文字最大字符数");
        seal.ext.registerIntConfig(MemoryConfig.ext, "印象·清理未活跃天数", 30, "超过此天数未发言的用户印象将被清理");

    }

    static get() {
        return {
            knowledgeMemoryShowNumber: seal.ext.getIntConfig(MemoryConfig.ext, "知识库记忆展示数量"),
            knowledgeMemoryStringList: seal.ext.getTemplateConfig(MemoryConfig.ext, "知识库记忆"),
            knowledgeMemorySingleShowTemplate: ConfigManager.getHandlebarsTemplateConfig(MemoryConfig.ext, "单条知识库记忆展示模板"),
            isMemory: seal.ext.getBoolConfig(MemoryConfig.ext, "是否启用长期记忆"),
            memoryLimit: seal.ext.getIntConfig(MemoryConfig.ext, "长期记忆上限"),
            memoryShowNumber: seal.ext.getIntConfig(MemoryConfig.ext, "长期记忆展示数量"),
            memoryShowTemplate: ConfigManager.getHandlebarsTemplateConfig(MemoryConfig.ext, "长期记忆展示模板"),
            memorySingleShowTemplate: ConfigManager.getHandlebarsTemplateConfig(MemoryConfig.ext, "单条长期记忆展示模板"),
            maxObservedMessages: seal.ext.getIntConfig(MemoryConfig.ext, "印象·最大观察消息数"),
            impressionMaxAge: seal.ext.getIntConfig(MemoryConfig.ext, "印象·最长天数"),
            impressionMaxLength: seal.ext.getIntConfig(MemoryConfig.ext, "印象·最大长度"),
            cleanupInactiveDays: seal.ext.getIntConfig(MemoryConfig.ext, "印象·清理未活跃天数"),
        }
    }
}