import { AI } from "../AI/AI";
import { ConfigManager } from "../config/configManager";
import { logger } from "../logger";
import { getCtxAndMsg, getSessionCtxAndMsg } from "../utils/utils_seal";
import { CmdInfo, Tool, ToolManager } from "./tool";

function isBlacklisted(command: string, extension: string): boolean {
    const blacklist = ConfigManager.tool.commandBlacklist;
    for (const entry of blacklist) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        // ext:cmd format
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx > 0) {
            const [entryExt, entryCmd] = [trimmed.slice(0, colonIdx), trimmed.slice(colonIdx + 1)];
            if (entryExt.toLowerCase() === extension.toLowerCase() && entryCmd.toLowerCase() === command.toLowerCase()) {
                return true;
            }
        } else {
            // bare name: match any extension
            if (trimmed.toLowerCase() === command.toLowerCase()) {
                return true;
            }
        }
    }
    return false;
}

function normalizeArgs(raw: unknown): string[] {
    if (raw == null) return [];
    if (typeof raw === 'string') return raw.trim() ? raw.trim().split(/\s+/) : [];
    if (!Array.isArray(raw)) return [];
    return raw.filter(v => v != null).map(v => String(v));
}

function getAllowedExtensions(): string[] {
    return ConfigManager.tool.allowedExtensions
        .map(e => e.trim())
        .filter(e => e && !e.startsWith('#') && !e.startsWith('//'));
}

function buildDescription(): string {
    const allowedExts = getAllowedExtensions();
    const parts = ['调用SealDice扩展指令。当前可用扩展：'];

    if (!allowedExts || allowedExts.length === 0) {
        parts.push('(无，请在插件配置中添加)');
    }

    for (const extName of allowedExts) {
        const trimmedName = extName.trim();
        if (!trimmedName) continue;
        const ext = seal.ext.find(trimmedName);
        if (!ext) continue;

        const names = Object.keys(ext.cmdMap)
            .filter(n => !isBlacklisted(n, trimmedName))
            .sort();

        if (names.length === 0) continue;

        const sample = names.slice(0, 5).join('/');
        parts.push(`${trimmedName} (${sample}${names.length > 5 ? '/...' : ''}共${names.length}条)`);
    }

    parts.push('。\n\n提示：如需了解某指令的详细用法，先用 args=["help"] 获取帮助。\n使用示例：run_command(extension="coc7", command="ra", args=["力量","50"])');
    return parts.join('');
}

function getAvailableExtensionsList(): string {
    return getAllowedExtensions()
        .filter(e => seal.ext.find(e))
        .join(', ') || '(无)';
}

function getCommandsForExtension(extName: string): string {
    const ext = seal.ext.find(extName);
    if (!ext) return '';
    const names = Object.keys(ext.cmdMap)
        .filter(n => !isBlacklisted(n, extName))
        .sort();
    const list = names.join(', ');
    return list.length > 200 ? list.slice(0, 200) + '...' : list;
}

export function registerRunCommand() {
    const tool = new Tool({
        type: 'function',
        function: {
            name: 'run_command',
            description: buildDescription(),
            parameters: {
                type: 'object',
                properties: {
                    extension: {
                        type: 'string',
                        description: '扩展名称',
                    },
                    command: {
                        type: 'string',
                        description: '指令名称',
                    },
                    args: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '位置参数列表（可选）',
                    },
                },
                required: ['extension', 'command'],
            },
        },
    });

    // Override getInfo for dynamic description
    tool.getInfo = () => {
        return {
            type: 'function',
            function: {
                name: 'run_command',
                description: buildDescription(),
                parameters: {
                    type: 'object',
                    properties: {
                        extension: { type: 'string', description: '扩展名称' },
                        command: { type: 'string', description: '指令名称。若不确定用法，先用 args=["help"] 获取帮助' },
                        args: { type: 'array', items: { type: 'string' }, description: '位置参数列表。传 ["help"] 可查看该指令的详细用法' },
                    },
                    required: ['extension', 'command'],
                },
            },
        };
    };

    // Always from group or private
    tool.type = 'all';

    tool.solve = async (ctx, msg, ai, args) => {
        const extension = (args?.extension || '').trim();
        const command = (args?.command || '').trim().toLowerCase();
        const cmdArgs = normalizeArgs(args?.args);

        logger.info(`[run_command] uid=${ctx.player.userId} gid=${ctx.group?.groupId || ''} ext=${extension} cmd=${command} args=[${cmdArgs.join(',')}]`);

        // 1. Check extension is in allowed list
        const allowedExts = getAllowedExtensions();
        if (!allowedExts.includes(extension)) {
            logger.warning(`[run_command] 扩展 '${extension}' 未被允许`);
            return {
                content: `扩展 '${extension}' 未被允许调用。当前可用扩展：${getAvailableExtensionsList()}`,
                images: [],
            };
        }

        // 2. Find the extension
        const ext = seal.ext.find(extension);
        if (!ext) {
            logger.warning(`[run_command] 扩展 '${extension}' 未安装`);
            return {
                content: `扩展 '${extension}' 未安装。当前可用扩展：${getAvailableExtensionsList()}`,
                images: [],
            };
        }

        // 3. Check blacklist
        if (isBlacklisted(command, extension)) {
            logger.warning(`[run_command] 指令 '${command}' 在黑名单中`);
            return {
                content: `指令 '${command}' 禁止通用调用`,
                images: [],
            };
        }

        // 4. Check command exists
        if (!ext.cmdMap.hasOwnProperty(command)) {
            logger.warning(`[run_command] 扩展 '${extension}' 中未找到指令 '${command}'`);
            const available = getCommandsForExtension(extension);
            return {
                content: `扩展 '${extension}' 中未找到指令 '${command}'。该扩展可用指令：${available}。如需了解某指令用法，请使用 args=["help"] 获取帮助`,
                images: [],
            };
        }

        // 5. Check disabledInPrivate
        if (ext.cmdMap[command].disabledInPrivate && ctx.isPrivate) {
            logger.warning(`[run_command] 指令 '${command}' 不支持私聊`);
            return {
                content: `指令 '${command}' 不支持私聊`,
                images: [],
            };
        }

        // 6. Build CmdInfo and execute
        const cmdInfo: CmdInfo = {
            ext: extension,
            name: command,
            fixedArgs: [],
        };

        try {
            const [result, success] = await ToolManager.extensionSolve(ctx, msg, ai, cmdInfo, cmdArgs, [], []);
            logger.info(`[run_command] 结果: success=${success} result=${result?.slice(0, 100) || '(空)'}`);
            if (result) {
                return { content: result, images: [] };
            }
            // 超时或无输出：extensionSolve 10s 内未捕获到指令回复
            return {
                content: `指令 '${command}' 执行超时（10秒内未收到回复）。可能原因：该指令不支持 help 参数、help 信息过长、或使用了非标准输出方式。请尝试直接传入实际参数调用。`,
                images: [],
            };
        } catch (e) {
            logger.error(`[run_command] 调用失败: ${e?.message || e}`);
            return {
                content: '指令执行失败',
                images: [],
            };
        }
    };
}
