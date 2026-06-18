import { ConfigManager } from "../config/configManager";
import { TimerManager } from "../timer";
import { fmtDate } from "../utils/utils_string";
import { Tool } from "./tool";

export function registerTime() {
    const toolGet = new Tool({
        type: "function",
        function: {
            name: "get_time",
            description: `获取当前时间`,
            parameters: {
                type: "object",
                properties: {
                },
                required: []
            }
        }
    });
    toolGet.solve = async (_, __, ___, ____) => {
        return { content: fmtDate(Math.floor(Date.now() / 1000), ConfigManager.message.utcOffset), images: [] };
    }

    const toolSet = new Tool({
        type: 'function',
        function: {
            name: 'set_timer',
            description: '设置一个定时器，在指定时间后触发',
            parameters: {
                type: 'object',
                properties: {
                    types: {
                        type: 'string',
                        description: '定时器类型。target: 在指定时间触发（搭配datetime或seconds使用）。interval: 每隔指定时长重复触发。',
                        enum: ['target', 'interval']
                    },
                    years: {
                        type: 'integer',
                        description: '年数（已弃用，建议用datetime或seconds代替）'
                    },
                    months: {
                        type: 'integer',
                        description: '月数（已弃用，建议用datetime或seconds代替）'
                    },
                    days: {
                        type: 'integer',
                        description: '天数（已弃用，建议用datetime或seconds代替）'
                    },
                    hours: {
                        type: 'integer',
                        description: '小时数（已弃用，建议用datetime或seconds代替）'
                    },
                    minutes: {
                        type: 'integer',
                        description: '分钟数（已弃用，建议用datetime或seconds代替）'
                    },
                    datetime: {
                        type: 'string',
                        description: '截止日期时间，格式 YYYY-MM-DD 或 YYYY-MM-DD HH:MM。优先级高于 years/months/days/hours/minutes'
                    },
                    seconds: {
                        type: 'integer',
                        description: '相对秒数，如 3600=1小时后。优先级高于 years/months/days/hours/minutes'
                    },
                    count: {
                        type: 'integer',
                        description: '触发次数，-1为无限次'
                    },
                    content: {
                        type: 'string',
                        description: '触发时给自己的的提示词'
                    }
                },
                required: ['types', 'content']
            }
        }
    });
    toolSet.solve = async (ctx, _, ai, args) => {
        const { types, datetime, seconds, years = 0, months = 0, days = 0, hours = 0, minutes, count = 1, content } = args;
        let y = parseInt(years), m = parseInt(months), d = parseInt(days), h = parseInt(hours), min = parseInt(minutes);
        let c = parseInt(count);

        // datetime 优先级最高
        if (datetime) {
            const match = datetime.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
            if (match) {
                y = parseInt(match[1]); m = parseInt(match[2]); d = parseInt(match[3]);
                h = match[4] ? parseInt(match[4]) : 0; min = match[5] ? parseInt(match[5]) : 0;
            } else {
                return { content: 'datetime 格式错误，应为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM', images: [] };
            }
        } else if (seconds) {
            y = 0; m = 0; d = 0; h = 0; min = Math.ceil(seconds / 60);
        }

        // 检查是否提供了时间参数（datetime/seconds/minutes 至少一个）
        if (!datetime && !seconds && minutes === undefined) {
            return { content: '请指定时间：用 datetime（如"2025-06-25 08:00"）表示具体时刻，或用 seconds（如 3600）表示多少秒后', images: [] };
        }

        if (isNaN(y)) return { content: '年数应为数字', images: [] };
        if (isNaN(m)) return { content: '月数应为数字', images: [] };
        if (isNaN(d)) return { content: '天数应为数字', images: [] };
        if (isNaN(h)) return { content: '小时数应为数字', images: [] };
        if (isNaN(min)) return { content: '分钟数应为数字', images: [] };
        if (isNaN(c)) return { content: '触发次数应为数字', images: [] };

        switch (types) {
            case 'target': {
                // 将用户输入的时间视为用户时区（如北京时间），转为 UTC 时间戳
                const userTimeMs = Date.UTC(y, m - 1, d, h, min);
                const t = userTimeMs - ConfigManager.message.utcOffset * 3600 * 1000;
                const now = Date.now();
                if (isNaN(t)) {
                    return { content: '时间设置错误', images: [] };
                }
                if (t < now) {
                    return { content: '目标时间不能早于当前时间', images: [] };
                }
                if (t - now > 365 * 24 * 60 * 60 * 1000) {
                    return { content: '目标时间不能超过1年', images: [] };
                }
                TimerManager.addTargetTimer(ctx, ai, Math.floor(t / 1000), content);
                break;
            }
            case 'interval': {
                const mins = y * 365 * 24 * 60 + m * 30 * 24 * 60 + d * 24 * 60 + h * 60 + min;
                if (mins <= 0) {
                    return { content: '间隔时间必须大于0', images: [] };
                }
                if (mins > 365 * 24 * 60) {
                    return { content: '间隔时间不能大于1年', images: [] };
                }
                if (c < -1 || c === 0) {
                    return { content: '触发次数不能小于-1或等于0', images: [] };
                }
                if (c === -1 && mins < 12 * 60) {
                    return { content: '无限次触发间隔时间不能小于12小时', images: [] };
                }
                if (c > 30) {
                    return { content: '触发次数不能大于30次', images: [] };
                }
                TimerManager.addIntervalTimer(ctx, ai, mins * 60, c, content);
                break;
            } default: {
                return { content: '定时器类型错误', images: [] };
            }
        }

        let confirmMsg: string;
        switch (types) {
            case 'target': {
                const t = new Date(y, m - 1, d, h, min);
                confirmMsg = `定时器已设置\n类型：目标时间\n触发时间：${fmtDate(Math.floor(t.getTime() / 1000), ConfigManager.message.utcOffset)}\n提示内容：${content}`;
                break;
            }
            case 'interval': {
                const mins2 = y * 365 * 24 * 60 + m * 30 * 24 * 60 + d * 24 * 60 + h * 60 + min;
                confirmMsg = `定时器已设置\n类型：间隔循环\n间隔：${mins2 * 60}秒（约${Math.round(mins2 / 60)}小时）\n触发次数：${c === -1 ? '无限' : c}\n提示内容：${content}`;
                break;
            }
        }
        return { content: confirmMsg, images: [] };
    }

    const toolShow = new Tool({
        type: 'function',
        function: {
            name: 'show_timer_list',
            description: '查看当前聊天的所有定时器',
            parameters: {
                type: 'object',
                properties: {
                },
                required: []
            }
        }
    });
    toolShow.solve = async (_, __, ai, ___) => {
        const timers = TimerManager.getTimers(ai.id, '', ['target', 'interval']);

        if (timers.length === 0) {
            return { content: '当前对话没有定时器', images: [] };
        }

        const s = timers.map((t, i) => {
            switch (t.type as 'target' | 'interval') {
                case 'target': {
                    return `${i + 1}. 定时器设定时间：${fmtDate(t.set, ConfigManager.message.utcOffset)}
类型:${t.type}
目标时间：${fmtDate(t.target, ConfigManager.message.utcOffset)}
内容：${t.content}`;
                }
                case 'interval': {
                    return `${i + 1}. 定时器设定时间：${fmtDate(t.set, ConfigManager.message.utcOffset)}
类型:${t.type}
间隔时间：${t.interval}秒
剩余触发次数：${t.count === -1 ? '无限' : t.count - 1}
内容：${t.content}`;
                }
            }
        }).join('\n');

        return { content: s, images: [] };
    }

    const toolCancel = new Tool({
        type: 'function',
        function: {
            name: 'cancel_timer',
            description: '取消当前聊天的指定定时器',
            parameters: {
                type: 'object',
                properties: {
                    index_list: {
                        type: 'array',
                        items: {
                            type: 'integer'
                        },
                        description: '要取消的定时器序号列表，序号从1开始'
                    }
                },
                required: ['index_list']
            }
        }
    });
    toolCancel.solve = async (_, __, ai, args) => {
        const { index_list } = args;
        const timers = TimerManager.getTimers(ai.id, '', ['target', 'interval']);

        if (timers.length === 0) {
            return { content: '当前对话没有定时器', images: [] };
        }

        if (index_list.length === 0) {
            return { content: '请输入要取消的定时器序号', images: [] };
        }

        TimerManager.removeTimers(ai.id, '', ['target', 'interval'], index_list);

        return { content: '定时器取消成功', images: [] };
    }
}