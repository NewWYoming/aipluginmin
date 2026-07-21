import { ConfigManager } from "./configManager";

export class ToolConfig {
    static ext: seal.ExtInfo;

    static register() {
        ToolConfig.ext = ConfigManager.getExt('aiplugin4_2:函数调用');

        seal.ext.registerBoolConfig(ToolConfig.ext, "是否开启调用函数功能", true, "");
        seal.ext.registerIntConfig(ToolConfig.ext, "允许连续调用函数次数", 5, "单次对话中允许连续调用函数的次数");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "不允许调用的函数", [
            'ban',
            'whole_ban',
            'get_ban_list'
        ], "修改后保存并重载js");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "默认关闭的函数", [
            'rename',
            'set_trigger_condition',
            'music_play',
            'run_command'
        ], "");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "提供给AI的牌堆名称", ["克苏鲁神话"], "没有的话建议把draw_deck这个函数加入不允许调用");
        seal.ext.registerOptionConfig(ToolConfig.ext, "ai语音使用的音色", '傲娇少女', [
            "小新",
            "猴哥",
            "四郎",
            "东北老妹儿",
            "广西大表哥",
            "妲己",
            "霸道总裁",
            "酥心御姐",
            "说书先生",
            "憨憨小弟",
            "憨厚老哥",
            "吕布",
            "元气少女",
            "文艺少女",
            "磁性大叔",
            "邻家小妹",
            "低沉男声",
            "傲娇少女",
            "爹系男友",
            "暖心姐姐",
            "温柔妹妹",
            "书香少女",
            "自定义"
        ], "该功能在选择预设音色时，需要安装http依赖插件，且需要可以调用ai语音api版本的napcat/lagrange等。选择自定义音色时，则需要aitts依赖插件和ffmpeg");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "本地语音路径", ['data/records/钢管落地.mp3'], "如不需要可以不填写，修改完需要重载js。发送语音需要配置ffmpeg到环境变量中");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "允许AI通用调用的扩展", [
            '# 在此添加扩展名，例如：coc7',
        ], "每行一个扩展名（如coc7、fun、story），修改后保存并重载js。留空或删除注释行禁用通用调用。\n⚠ 允许一个扩展将暴露其几乎所有指令给AI，请确保了解该扩展包含哪些指令后再添加。");
        seal.ext.registerTemplateConfig(ToolConfig.ext, "通用工具指令黑名单", [
            'ban',
            'unload',
            'master',
            'admin',
            'bot',
            'ext',
            'dismiss',
            'update',
            'backup',
            'conf',
            'sendto',
            'ai',
            'AI',
            'on',
            'off',
            'tool',
            'privilege',
            'shut',
        ], "每行一个指令名，禁止被通用调用。默认屏蔽高危指令和本插件自身指令。支持 ext:cmd 格式精确屏蔽（如coc7:st）。修改后保存并重载js。");
    }

    static get() {
        return {
            isTool: seal.ext.getBoolConfig(ToolConfig.ext, "是否开启调用函数功能"),
            maxCallCount: seal.ext.getIntConfig(ToolConfig.ext, "允许连续调用函数次数"),
            toolsNotAllow: seal.ext.getTemplateConfig(ToolConfig.ext, "不允许调用的函数"),
            toolsDefaultClosed: seal.ext.getTemplateConfig(ToolConfig.ext, "默认关闭的函数"),
            decks: seal.ext.getTemplateConfig(ToolConfig.ext, "提供给AI的牌堆名称"),
            allowedExtensions: seal.ext.getTemplateConfig(ToolConfig.ext, "允许AI通用调用的扩展"),
            commandBlacklist: seal.ext.getTemplateConfig(ToolConfig.ext, "通用工具指令黑名单"),
            character: seal.ext.getOptionConfig(ToolConfig.ext, "ai语音使用的音色"),
            recordPathMap: ConfigManager.getPathMapConfig(ToolConfig.ext, "本地语音路径"),
        }
    }
}