import { AIManager } from "../../AI/AI";
import { get_chart_url } from "../../service/legacy";
import { aliasToCmd } from "../../utils/utils";
import { S, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

type UsageEntry = { prompt_tokens: number; completion_tokens: number };
type AggResult = { [dateKey: string]: UsageEntry };

function aggregateModelEntries(
    modelEntries: { [dateKey: string]: UsageEntry },
    period: 'year' | 'month'
): AggResult {
    const obj: AggResult = {};
    const now = new Date();

    for (const rawKey in modelEntries) {
        const usage = modelEntries[rawKey];
        const parts = rawKey.split('-').map(v => parseInt(v));

        if (period === 'year') {
            const [year, month] = parts;
            const ym = year * 12 + month;
            const currentYM = now.getFullYear() * 12 + (now.getMonth() + 1);
            if (ym >= currentYM - 11 && ym <= currentYM) {
                const dateKey = `${year}-${String(month).padStart(2, '0')}`;
                if (!obj[dateKey]) obj[dateKey] = { prompt_tokens: 0, completion_tokens: 0 };
                obj[dateKey].prompt_tokens += usage.prompt_tokens;
                obj[dateKey].completion_tokens += usage.completion_tokens;
            }
        } else {
            const [year, month, day] = parts;
            const ymd = year * 12 * 31 + month * 31 + day;
            const currentYMD = now.getFullYear() * 12 * 31 + (now.getMonth() + 1) * 31 + now.getDate();
            if (ymd >= currentYMD - 30 && ymd <= currentYMD) {
                const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                if (!obj[dateKey]) obj[dateKey] = { prompt_tokens: 0, completion_tokens: 0 };
                obj[dateKey].prompt_tokens += usage.prompt_tokens;
                obj[dateKey].completion_tokens += usage.completion_tokens;
            }
        }
    }
    return obj;
}

function mergeAggResults(target: AggResult, source: AggResult): AggResult {
    for (const key in source) {
        if (!target[key]) target[key] = { prompt_tokens: 0, completion_tokens: 0 };
        target[key].prompt_tokens += source[key].prompt_tokens;
        target[key].completion_tokens += source[key].completion_tokens;
    }
    return target;
}

function formatUsageReport(obj: AggResult, header: string): string {
    const s = Object.keys(obj).sort().map(key => {
        const usage = obj[key];
        if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) return '';
        return `${key}:
          输入token:${usage.prompt_tokens}
          输出token:${usage.completion_tokens}
          总token:${usage.prompt_tokens + usage.completion_tokens}`;
    }).filter(Boolean).join('\n');
    return s ? `${header}:\n${s}` : '';
}

export function registerCmdToken() {
    const cmd = new SubCmd('token');
    cmd.desc = 'token相关操作';
    cmd.help = '';
    cmd.priv = {
        priv: S, args: {
            list: { priv: U },
            sum: { priv: U },
            all: { priv: U },
            year: {
                priv: U, args: {
                    chart: { priv: U }
                }
            },
            month: {
                priv: U, args: {
                    chart: { priv: U }
                }
            },
            clear: { priv: U },
            help: { priv: U },
            "*": { priv: U }
        }
    };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, ret } = scc;

        const val2 = cmdArgs.getArgN(2);
        switch (aliasToCmd(val2)) {
            case 'list': {
                const s = Object.keys(AIManager.usageMap).join('\n');
                seal.replyToSender(ctx, msg, `有使用记录的模型:\n${s}`);
                return ret;
            }
            case 'sum': {
                const usage = {
                    prompt_tokens: 0,
                    completion_tokens: 0
                };

                for (const model in AIManager.usageMap) {
                    const modelUsage = AIManager.getModelUsage(model);
                    usage.prompt_tokens += modelUsage.prompt_tokens;
                    usage.completion_tokens += modelUsage.completion_tokens;
                }

                if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                    seal.replyToSender(ctx, msg, `没有使用记录`);
                    return ret;
                }

                const s = `输入token:${usage.prompt_tokens}
       输出token:${usage.completion_tokens}
       总token:${usage.prompt_tokens + usage.completion_tokens}`;
                seal.replyToSender(ctx, msg, s);
                return ret;
            }
            case 'all': {
                const s = Object.keys(AIManager.usageMap).map((model, index) => {
                    const usage = AIManager.getModelUsage(model);

                    if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                        return `${index + 1}. ${model}: 没有使用记录`;
                    }

                    return `${index + 1}. ${model}:
         输入token:${usage.prompt_tokens}
         输出token:${usage.completion_tokens}
         总token:${usage.prompt_tokens + usage.completion_tokens}`;
                }).join('\n');

                if (!s) {
                    seal.replyToSender(ctx, msg, `没有使用记录`);
                    return ret;
                }

                seal.replyToSender(ctx, msg, `全部使用记录如下:\n${s}`);
                return ret;
            }
            case 'year': {
                let obj: AggResult = {};
                for (const model in AIManager.usageMap) {
                    obj = mergeAggResults(obj, aggregateModelEntries(AIManager.usageMap[model], 'year'));
                }
                const val3 = cmdArgs.getArgN(3);
                if (val3 === 'chart') {
                    const url = await get_chart_url('year', obj);
                    seal.replyToSender(ctx, msg, url ? `[CQ:image,file=${url}]` : '图表生成失败');
                    return ret;
                }
                const report = formatUsageReport(obj, '最近12个月使用记录如下');
                seal.replyToSender(ctx, msg, report || '没有使用记录');
                return ret;
            }
            case 'month': {
                let obj: AggResult = {};
                for (const model in AIManager.usageMap) {
                    obj = mergeAggResults(obj, aggregateModelEntries(AIManager.usageMap[model], 'month'));
                }
                const val3 = cmdArgs.getArgN(3);
                if (val3 === 'chart') {
                    const url = await get_chart_url('month', obj);
                    seal.replyToSender(ctx, msg, url ? `[CQ:image,file=${url}]` : '图表生成失败');
                    return ret;
                }
                const report = formatUsageReport(obj, '最近31天使用记录如下');
                seal.replyToSender(ctx, msg, report || '没有使用记录');
                return ret;
            }
            case 'clear': {
                const val3 = cmdArgs.getArgN(3);
                if (!val3) {
                    AIManager.clearUsageMap();
                    seal.replyToSender(ctx, msg, '已清除token使用记录');
                    AIManager.saveUsageMap();
                    return ret;
                }

                if (!AIManager.usageMap.hasOwnProperty(val3)) {
                    seal.replyToSender(ctx, msg, '没有这个模型，请使用【.ai tk lst】查看所有模型');
                    return ret;
                }

                delete AIManager.usageMap[val3];
                seal.replyToSender(ctx, msg, `已清除 ${val3} 的token使用记录`);
                AIManager.saveUsageMap();
                return ret;
            }
            case '':
            case 'help': {
                seal.replyToSender(ctx, msg, `帮助:
       【.ai tk lst】查看所有模型
       【.ai tk sum】查看所有模型的token使用记录总和
       【.ai tk all】查看所有模型的token使用记录
       【.ai tk [y/m] (chart)】查看所有模型今年/这个月的token使用记录
       【.ai tk <模型名称>】查看模型的token使用记录
       【.ai tk <模型名称> [y/m] (chart)】查看模型今年/这个月的token使用记录
       【.ai tk clr】清除token使用记录
       【.ai tk clr <模型名称>】清除token使用记录`);
                return ret;
            }
            default: {
                if (!AIManager.usageMap.hasOwnProperty(val2)) {
                    seal.replyToSender(ctx, msg, '没有这个模型，请使用【.ai tk lst】查看所有模型');
                    return ret;
                }

                const val3 = cmdArgs.getArgN(3);
                switch (aliasToCmd(val3)) {
                    case 'year': {
                        const obj = aggregateModelEntries(AIManager.usageMap[val2], 'year');
                        const val4 = cmdArgs.getArgN(4);
                        if (val4 === 'chart') {
                            const url = await get_chart_url('year', obj);
                            seal.replyToSender(ctx, msg, url ? `[CQ:image,file=${url}]` : '图表生成失败');
                            return ret;
                        }
                        const report = formatUsageReport(obj, '最近12个月使用记录如下');
                        seal.replyToSender(ctx, msg, report || '没有使用记录');
                        return ret;
                    }
                    case 'month': {
                        const obj = aggregateModelEntries(AIManager.usageMap[val2], 'month');
                        const val4 = cmdArgs.getArgN(4);
                        if (val4 === 'chart') {
                            const url = await get_chart_url('month', obj);
                            seal.replyToSender(ctx, msg, url ? `[CQ:image,file=${url}]` : '图表生成失败');
                            return ret;
                        }
                        const report = formatUsageReport(obj, '最近31天使用记录如下');
                        seal.replyToSender(ctx, msg, report || '没有使用记录');
                        return ret;
                    }
                    default: {
                        const usage = AIManager.getModelUsage(val2);

                        if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
                            seal.replyToSender(ctx, msg, `没有使用记录`);
                            return ret;
                        }

                        const s = `输入token:${usage.prompt_tokens}
       输出token:${usage.completion_tokens}
       总token:${usage.prompt_tokens + usage.completion_tokens}`;
                        seal.replyToSender(ctx, msg, s);
                        return ret;
                    }
                }
            }
        }
    }
}