# 长期修复计划：指令系统 Bug 修复

> 创建日期：2025-06-18
> 来源：子代理全面审查 `.ai` 指令系统
> 共发现：6 个 Bug / 4 个代码质量问题 / 2 个持久性缺失

---

## 🔴 严重 Bug（安全漏洞 / 崩溃 / 逻辑错误）

| # | 任务 | 影响文件 | 重要性 | 进度 |
|---|------|----------|--------|------|
| F1 | `tool.ts` — `call` 子命令绕过安全检查 | `src/cmd/sub_cmd/tool.ts` | 🔴 高危 | ✅ 已修复 |
| F2 | `image.ts` — `itt` 分支缺少 `return`，导致崩溃 | `src/cmd/sub_cmd/image.ts` | 🔴 高危 | ✅ 已修复 |
| F3 | `on.ts` — 活跃时间 `segs=0` 导致除零 | `src/cmd/sub_cmd/on.ts` | 🔴 高危 | ✅ 已修复 |
| F4 | `role.ts` — 越界检查缺少 `return`，允许错误角色切换 | `src/cmd/sub_cmd/role.ts` | 🟠 中危 | ✅ 已修复 |
| F5 | `forget.ts` — `resetState()` 过早调用，针对性清除时触发副作用 | `src/cmd/sub_cmd/forget.ts` | 🟠 中危 | ✅ 已修复 |
| F6 | `ctxn.ts` — `Promise.all` 即发即弃，回复在操作完成前发送 | `src/cmd/sub_cmd/ctxn.ts` | 🟠 中危 | ✅ 已修复 |

### F1: `tool.ts` — call 绕过安全检查

| 子任务 | 描述 | 文件/行号 | 进度 | 备注 |
|--------|------|-----------|------|------|
| F1.1 | `call` 分支添加 `toolsNotAllow` 检查 | `tool.ts:~L100` | ✅ | 在 getArgN(3) 存在性检查后、cmdInfo.ext 检查前插入 |
| F1.2 | `call` 分支添加 `tool.type` 兼容性检查 | `tool.ts:~L100` | ✅ | 镜像 `handleToolCall()` 的检查逻辑和错误消息 |
| F1.3 | 审查参数解析器 `JSON.parse([val])[0]` 健壮性 | `tool.ts:L109-117` | ⬜ | 延后处理，不影响核心安全 |

### F2: `image.ts` — itt 崩溃

| 子任务 | 描述 | 文件/行号 | 进度 | 备注 |
|--------|------|-----------|------|------|
| F2.1 | 零图片守卫后添加 `return ret` | `image.ts:L75` | ✅ | 将单行 if 改为块级 if + return ret，防止 images[0] 崩溃 |
| F2.2 | 添加 `val3` 空值/无效输入验证 | `image.ts:L72-78` | ⬜ | `val3` 非空已在 L68 检查；transformTextToArray 空数组已由 L74 覆盖 |

### F3: `on.ts` — segs=0 除零

| 子任务 | 描述 | 文件/行号 | 进度 | 备注 |
|--------|------|-----------|------|------|
| F3.1 | active 段验证添加 `segs >= 1` 检查 | `on.ts:L93`（附近） | ✅ | 在 Number.isInteger 检查后添加 `segs < 1` 验证 |
| F3.2 | 审查 active 时间验证完整性 | `on.ts:L85-103` | ✅ | `endReal - start` 始终 >= 1（start===end 已在 L83 拦截）；NaN segs 已被整数检查拦截 |

### F4: `role.ts` — 越界检查缺 return

| 子任务 | 描述 | 文件/行号 | 进度 | 备注 |
|--------|------|-----------|------|------|
| F4.1 | 越界错误消息后添加 `return ret` | `role.ts:L28` | ✅ | 添加了 return ret 阻止错误角色切换 |
| F4.2 | 添加 `AIManager.saveAI()` 持久化角色变更 | `role.ts:~L35` | ✅ | 非问题：角色通过 `seal.vars.strSet` 持久化，由 SealDice 管理 |

### F5: `forget.ts` — resetState 副作用

| 子任务 | 描述 | 文件/行号 | 进度 | 备注 |
|--------|------|-----------|------|------|
| F5.1 | 将 `ai.resetState()` 移入"清除全部"分支 | `forget.ts:L19` | ✅ | resetState 移入 default 分支，针对性清除不再触发副作用 |
| F5.2 | 添加 `cmd.help` 内容 | `forget.ts:L9` | ⬜ | 延期；低优先级 UI 改进 |

### F6: `ctxn.ts` — Promise 即发即弃

| 子任务 | 描述 | 文件/行号 | 进度 | 备注 |
|--------|------|-----------|------|------|
| F6.1 | `await Promise.all(...)` 并在完成后回复 | `ctxn.ts:L40` | ✅ | solve 改为 async，.then() 改为 await；回复在名称解析后发送 |
| F6.2 | 名称更新后添加 `AIManager.saveAI()` | `ctxn.ts:~L43` | ✅ | set 和 mod 分支均添加 saveAI；补充 import 和 sid 解构 |

---

## 🟡 代码质量 / 技术债务

| # | 任务 | 影响文件 | 重要性 | 进度 |
|---|------|----------|--------|------|
| Q1 | `token.ts` — 年度/月度聚合逻辑严重重复 (~160行) | `src/cmd/sub_cmd/token.ts` | 🟡 低 | ✅ 已修复 |
| Q2 | `memory.ts` — private/group 分支代码重复 | `src/cmd/sub_cmd/memory.ts` | 🟡 低 | ✅ 已修复 |
| Q3 | `status.ts` — 回复文本嵌入缩进空格，聊天显示异常 | `src/cmd/sub_cmd/status.ts` | 🟡 低 | ✅ 已修复 |
| Q4 | `token.ts` — month 排序使用魔法公式，应改用 Date | `src/cmd/sub_cmd/token.ts` | 🟡 低 | ✅ 已修复 |

### Q1: token.ts 重复逻辑

| 子任务 | 描述 | 文件/行号 | 进度 | 备注 |
|--------|------|-----------|------|------|
| Q1.1 | 提取 `computeYearlyUsage(model?)` 辅助函数 | `token.ts:L86-150` + `L254-318` | ⬜ | 两处完全相同的聚合逻辑 |
| Q1.2 | 提取 `computeMonthlyUsage(model?)` 辅助函数 | `token.ts:L153-204` + `L321-380` | ⬜ | 同上 |
| Q1.3 | 使用辅助函数重构 year/month 分支 | `token.ts` | ⬜ | 减少约40%代码量 |

### Q2: memory.ts 重复逻辑

| 子任务 | 描述 | 文件/行号 | 进度 | 备注 |
|--------|------|-----------|------|------|
| Q2.1 | 提取 private/group 共享的内存操作辅助函数 | `memory.ts` | ⬜ | set/delete/list/clear 在两种作用域下几乎相同 |
| Q2.2 | 审查 `status` 中 `@` 逻辑 | `memory.ts:L53-55` | ⬜ | 多个 @时 AI 切换逻辑脆弱 |

### Q3: status.ts 缩进

| 子任务 | 描述 | 文件/行号 | 进度 | 备注 |
|--------|------|-----------|------|------|
| Q3.1 | 移除回复模板中的缩进空格（含 memory.ts） | `status.ts:~L14` + `memory.ts` | ✅ | 改为 `\n` + 字符串拼接；memory.ts 同样修复 4 处模板字面量 |

### Q4: token.ts 魔法公式

| 子任务 | 描述 | 文件/行号 | 进度 | 备注 |
|--------|------|-----------|------|------|
| Q4.1 | 日期 key 补零到 ISO 格式（YYYY-MM / YYYY-MM-DD） | `token.ts:L105,172,274,341` | ✅ | `padStart(2, '0')` 补零月/日 |
| Q4.2 | 替换 magic formula sort 为 `keys.sort()` | `token.ts:L126-130,193-197,294-298,361-365` | ✅ | ISO key 可直接字符串排序，4 处全部替换 |

---

## 🔵 架构 / 其他

| # | 任务 | 影响文件 | 重要性 | 进度 |
|---|------|----------|--------|------|
| A1 | `sample.ts` — 死代码文件，不应在生产中暴露 | `src/cmd/sub_cmd/sample.ts` | 🔵 信息 | ⬜ 待评估 |
| A2 | `privilege.ts` — `updateCmdPriv` 不修剪僵尸命令 | `src/cmd/privilege.ts` | 🔵 信息 | ⬜ 待评估 |
| A3 | `shut.ts` — 占位符命令，需决定保留或隐藏 | `src/cmd/sub_cmd/shut.ts` | 🔵 信息 | ⬜ 待评估 |
| A4 | 所有子命令 `cmd.help` 字段统一填充 | 多个文件 | 🔵 信息 | ⬜ 待评估 |

### A1: sample.ts

| 子任务 | 描述 | 进度 | 备注 |
|--------|------|------|------|
| A1.1 | 评估是否需要保留为开发模板 | ⬜ | 如果保留，考虑从生产帮助中隐藏 |
| A1.2 | 若不保留，移除文件和相关 import | ⬜ | 当前 `SubCmd.register()` 未调用它，无运行时影响 |

### A2: privilege.ts 僵尸命令

| 子任务 | 描述 | 进度 | 备注 |
|--------|------|------|------|
| A2.1 | `updateCmdPriv` 中检测并移除不存在于 default 的键 | ⬜ | 更新插件后旧命令权限残留 |

---

## 实施策略

**修复顺序：** F1 → F2 → F3 → F4 → F5 → F6（按严重性+依赖关系）

**每项修复流程：**
1. Research — 必要时 dispatch `@explorer` 读取上下文
2. Write fix plan — 指定确切的行变更
3. Review — dispatch `@oracle` 审查修复计划
4. Implement — dispatch `@fixer` 执行
5. Verify — `npm run build` 确认编译通过
6. Commit — 提交并记录进度

**版本管理：** 每次提交修改 `src/` 时 bump patch 版本（X.Y.Z → X.Y.Z+1）
