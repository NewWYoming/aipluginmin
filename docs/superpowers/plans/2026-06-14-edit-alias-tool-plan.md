# edit_alias 工具 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `edit_alias` 函数工具，让 AI 在发现群友新昵称或别名映射错误时，能够自主添加/删除别名映射。

**Architecture:** 新增 `src/tool/tool_alias.ts`，在 `Context.aliases` 数据结构上直接操作。通过 `findUserInfo` 解析用户名称获取 UID，然后在 `aliases[uid]` 上做增删。工具内置去重和越权检查（不允许删除当前显示名）。

**Tech Stack:** TypeScript, SeaDice JS plugin

---

### Task 0: 版本号更新

每次提交 src/ 下的代码后，必须：
1. `src/config/config.ts` `VERSION` patch +1
2. `header.txt` `@version` patch +1
3. 使用 `edit` 工具，禁用 PowerShell `Set-Content`

---

## Task 1: 新增 edit_alias 工具

**Files:**
- Create: `src/tool/tool_alias.ts`
- Modify: `src/tool/tool.ts:10`（添加 import）+ `:197`（添加 register 调用）

### step 1: 创建 `src/tool/tool_alias.ts`

```typescript
import { logger } from "../logger";
import { ConfigManager } from "../config/configManager";
import { Tool } from "./tool";

export function registerAlias() {
    const tool = new Tool({
        type: 'function',
        function: {
            name: 'edit_alias',
            description: '管理用户别名映射。当群友在对话中使用不同于当前显示名的昵称、称呼、外号时，将这些别名绑定到该用户以便正确识别。当发现之前的别名映射错误时，也可以删除或修正。',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['add', 'delete'],
                        description: '操作类型: add=添加别名映射, delete=删除已有的错误别名'
                    },
                    user_name: {
                        type: 'string',
                        description: '用户当前在对话中的显示名称' + (ConfigManager.message.showNumber ? '或纯数字QQ号' : '') + '，用于定位用户'
                    },
                    alias: {
                        type: 'string',
                        description: '要添加或删除的别名/昵称'
                    }
                },
                required: ['action', 'user_name', 'alias']
            }
        }
    });
    tool.solve = async (ctx, _, ai, args) => {
        const { action, user_name, alias } = args;

        // 查找用户
        const ui = await ai.context.findUserInfo(ctx, user_name);
        if (ui === null) {
            return { content: `未找到用户<${user_name}>，请确认用户名称是否正确后再试`, images: [] };
        }

        const uid = ui.id;
        const now = Math.floor(Date.now() / 1000);

        // 确保 aliases 结构存在
        if (!ai.context.aliases[uid]) {
            ai.context.aliases[uid] = { names: [], lastUsed: {} };
        }
        const aliasEntry = ai.context.aliases[uid];

        if (action === 'add') {
            // 去重：检查别名是否已存在
            if (aliasEntry.names.includes(alias)) {
                logger.warning(`edit_alias: 别名'${alias}'已存在于'${user_name}'(uid=${uid})的别名列表中，跳过`);
                return { content: `别名"${alias}"已在"${user_name}"的别名列表中，无需重复添加`, images: [] };
            }

            aliasEntry.names.push(alias);
            aliasEntry.lastUsed[alias] = now;
            logger.info(`edit_alias: add — uid=${uid}, alias='${alias}' → '${user_name}'`);
            return { content: `已将别名"${alias}"绑定到用户"${user_name}"`, images: [] };
        }

        if (action === 'delete') {
            // 安全检查：不允许删除用户当前显示名
            if (alias === user_name || alias === ui.name) {
                return { content: `无法删除用户"${user_name}"的当前显示名，只能删除之前绑定的别名`, images: [] };
            }

            // 查找并删除别名
            const idx = aliasEntry.names.indexOf(alias);
            if (idx === -1) {
                return { content: `未找到别名"${alias}"，该用户当前没有此别名`, images: [] };
            }

            aliasEntry.names.splice(idx, 1);
            delete aliasEntry.lastUsed[alias];

            // 如果该用户没有别名了，清理整个 entry
            if (aliasEntry.names.length === 0) {
                delete ai.context.aliases[uid];
            }

            logger.info(`edit_alias: delete — uid=${uid}, alias='${alias}' removed from '${user_name}'`);
            return { content: `已从用户"${user_name}"的别名列表中移除"${alias}"`, images: [] };
        }

        return { content: `未知操作"${action}"`, images: [] };
    }
}
```

### Step 2: 在 tool.ts 中注册

**添加 import**（在 `src/tool/tool.ts` 顶部，`tool_rename` import 附近）：
```typescript
import { registerAlias } from "./tool_alias";
```

**添加注册调用**（在 `src/tool/tool.ts` 的 `registerTool` 方法中，`registerRename()` 附近）：
```typescript
        registerAlias();
```

### Step 3: 构建验证

```bash
npm run build
```

### Step 4: 版本号 + 提交

```bash
git add src/tool/tool_alias.ts src/tool/tool.ts src/config/config.ts header.txt
git commit -m "feat: add edit_alias tool — AI can add/delete user alias mappings"
```

---

## 最终验证

- [ ] **完整构建**

```bash
npm run build
```

- [ ] **提交**

```bash
git add -A
git commit -m "chore: final verification of edit_alias tool"
```
