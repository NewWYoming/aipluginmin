import { logger } from "../logger";
import { ConfigManager } from "../config/configManager";
import { Tool, ToolInfo } from "./tool"

function getDeckNames(): string[] {
    return ConfigManager.tool.decks
        .map(name => `${name || ""}`.trim())
        .filter(name => name !== "");
}

function buildDeckToolInfo(): ToolInfo {
    const deckNames = getDeckNames();
    const descriptionSuffix = deckNames.length > 0
        ? `，牌堆的名字有:${deckNames.join("、")}`
        : "";

    return {
        type: "function",
        function: {
            name: "draw_deck",
            description: `按牌堆名称实际抽取一次牌堆内容；仅在需要抽卡时调用，不要用这个函数查询牌堆列表${descriptionSuffix}`,
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "牌堆名称",
                        ...(deckNames.length > 0 ? { enum: deckNames } : {})
                    }
                },
                required: ["name"]
            }
        }
    };
}

export function registerDeck() {
    const toolList = new Tool({
        type: "function",
        function: {
            name: "list_decks",
            description: "获取当前允许提供给AI使用的牌堆名称列表；当你只是想知道有哪些牌堆时调用这个函数，不要抽卡",
            parameters: {
                type: "object",
                properties: {},
                required: []
            }
        }
    });
    toolList.solve = async () => {
        const deckNames = getDeckNames();
        if (deckNames.length === 0) {
            return { content: "当前没有配置可用牌堆", images: [] };
        }

        return { content: `当前可用牌堆:${deckNames.join("、")}`, images: [] };
    }

    const toolDraw = new Tool(buildDeckToolInfo());
    toolDraw.getInfo = () => buildDeckToolInfo();

    toolDraw.solve = async (ctx, msg, _, args) => {
        const name = `${args.name || ""}`.trim();
        const deckNames = getDeckNames();

        if (!name) {
            return { content: "牌堆名称不能为空", images: [] };
        }

        if (deckNames.length > 0 && !deckNames.includes(name)) {
            return {
                content: `牌堆${name}不在允许列表中，当前可用牌堆:${deckNames.join("、")}`,
                images: []
            };
        }

        const dr = seal.deck.draw(ctx, name, true);
        if (!dr.exists) {
            logger.error(`牌堆${name}不存在:${dr.err}`);
            return { content: `牌堆${name}不存在:${dr.err}`, images: [] };
        }

        const result = dr.result;
        if (result == null) {
            logger.error(`牌堆${name}结果为空:${dr.err}`);
            return { content: `牌堆${name}结果为空:${dr.err}`, images: [] };
        }

        //seal.replyToSender(ctx, msg, result); // 不发送原消息，直接返回结果给AI
        return { content: result, images: [] };
    }
}
