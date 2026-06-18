import { AIManager } from "../../AI/AI";
import { ImageManager } from "../../AI/image";
import { aliasToCmd } from "../../utils/utils";
import { transformArrayToContent, transformTextToArray } from "../../utils/utils_string";
import { I, M, U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

export function registerCmdImage() {
    const cmd = new SubCmd('image');
    cmd.desc = '图片相关操作';
    cmd.help = '';
    cmd.priv = {
        priv: U, args: {
            list: {
                priv: U, args: {
                    steal: { priv: U },
                    local: { priv: M }
                }
            },
            steal: {
                priv: I, args: {
                    forget: { priv: U },
                }
            },
            itt: { priv: M },
            find: { priv: I }
        }
    };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, cmdArgs, sid, ai, page, ret } = scc;

        const val2 = cmdArgs.getArgN(2);
        switch (aliasToCmd(val2)) {
            case 'list': {
                const type = cmdArgs.getArgN(3);
                switch (aliasToCmd(type)) {
                    case 'steal': {
                        seal.replyToSender(ctx, msg, ai.imagePool.getStolenImageListText(page) || '暂无偷取图片');
                        return ret;
                    }
                    case 'local': {
                        seal.replyToSender(ctx, msg, ImageManager.getLocalImageListText(page) || '暂无本地图片');
                        return ret;
                    }
                    default: {
                        seal.replyToSender(ctx, msg, '【.ai img list [stl/lcl]】展示偷取的图片/本地图片');
                        return ret;
                    }
                }
            }
            case 'steal': {
                const op = cmdArgs.getArgN(3);
                switch (aliasToCmd(op)) {
                    case 'forget': {
                        ai.imagePool.clear('stolen');
                        seal.replyToSender(ctx, msg, '偷取图片已清空');
                        AIManager.saveAI(sid);
                        return ret;
                    }
                    default: {
                        seal.replyToSender(ctx, msg, '图片池状态: 偷取图' + ai.imagePool.stolenCount + '张, 本地图' + ai.imagePool.localCount + '张\n【.ai img stl f】清空偷取图片');
                        return ret;
                    }
                }
            }
            case 'itt': {
                const val3 = cmdArgs.getArgN(3);
                if (!val3) {
                    seal.replyToSender(ctx, msg, '【.ai img itt [图片] (附加提示词)】图片转文字');
                    return ret;
                }
                const messageArray = transformTextToArray(val3);
                const { images } = await transformArrayToContent(ctx, ai, messageArray);
                if (images.length === 0) {
                    seal.replyToSender(ctx, msg, '请附带图片');
                    return ret;
                }
                const img = images[0];
                await img.imageToText(cmdArgs.getRestArgsFrom(4))
                seal.replyToSender(ctx, msg, img.CQCode + `\n` + img.content);
                return ret;
            }
            case 'find': {
                const id = cmdArgs.getArgN(3);
                if (!id) {
                    seal.replyToSender(ctx, msg, '【.ai img find <图片ID>】查找图片');
                    return ret;
                }
                const img = await ai.context.findImage(ctx, id);
                seal.replyToSender(ctx, msg, img ? img.CQCode : '未找到该图片');
                return ret;
            }
            default: {
                seal.replyToSender(ctx, msg, `帮助:
 【.ai img list [stl/lcl]】展示偷取的图片/本地图片
 【.ai img stl [f]】管理偷取图片（f=清空）
 【.ai img itt [图片] (附加提示词)】图片转文字
 【.ai img find <图片ID>】查找图片`);
                return ret;
            }
        }
    }
}