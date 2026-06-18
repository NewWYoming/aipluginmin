# 设计文档：AI 任务提醒助手

> 日期：2025-06-18
> 目标：让 AI 成为任务提醒助手——用户通过对话让 AI 管理任务，到时间 AI 自动提醒

---

## 1. 需求概述

用户与 AI 自然对话创建/管理任务。系统在到期时触发 AI 回复，AI 以自然语言提醒用户。

### 功能清单

| 功能 | 通过 AI 工具实现 | 通过用户指令实现 |
|------|:--:|:--:|
| 创建任务（名称、截止时间、提醒设置） | `create_task` | `.ai task add` |
| 查看任务列表/进度 | `list_tasks` | `.ai task list` |
| 更新任务进度 | `update_task` | `.ai task update` |
| 删除任务 | `delete_task` | `.ai task delete` |
| 到期提醒（固定格式 → AI 润色 → 群聊 @用户） | 自动触发 | — |
| 公开任务（全群可见） | `create_task` scope=group | — |

### 任务类型

| 类型 | 说明 | 示例 |
|------|------|------|
| **倒计时任务** (deadline) | 指定截止日期/时间 | 「6月25日交报告」「156小时后」 |
| **固定周期任务** (periodic) | 每天/每周固定时间触发 | 「每天早上8点发早报」 |

---

## 2. 调度机制

### 2.1 Cron 扫描（每天 0:00）

SealDice 的 `seal.ext.registerTask(ext, "cron", '0 0 * * *', ...)` 每天 0:00 执行：

```
dailyCron() {
  1. 清理过期任务（截止日期 < 今天且未完成）
  2. 遍历所有倒计时任务：
     - 计算 截止时间 - 当前时间 的差值
     - 若差值 > 24h：不设闹钟，等待明天 cron
     - 若差值 ≤ 24h：创建一个 target 定时器，精确到分钟
  3. 遍历所有周期任务：
     - 计算下次触发时间（今天/明天/本周的指定时刻）
     - 创建一个 target 定时器
}
```

### 2.2 闹钟触发

```
timerFires(task) {
  1. 检查任务是否已被完成/删除（可能被用户提前处理）
  2. 按模板生成提醒文本（参考 GUGUtask 格式）：
     ⏳ {任务名} (进度: {进度}%, 截止: {截止日期})
     剩余时间：{剩余天数}天
     {群聊时追加: [CQ:at,qq={被指派者QQ号}]}
  3. 将模板作为 system 用户消息注入 AI 上下文：
     ai.context.addSystemUserMessage("任务提醒", 模板文本, [])
     发送者身份为"系统"，AI 视为来自系统用户的通知
  4. AI 按 '任务提醒润色提示' 配置的方向润色后回复
  5. 周期任务：重新计算下次触发时间，创建新闹钟
  6. 倒计时任务：不自动完成，等待用户手动标记
}
```


---

## 3. 数据模型

### 3.1 Task（新文件 `src/task.ts`）

```typescript
interface Task {
  id: string;           // 唯一 ID，用 msg.time 生成
  name: string;         // 任务名称
  type: 'deadline' | 'periodic';
  deadline?: string;    // 截止日期 "YYYY-MM-DD" 或 "YYYY-MM-DD HH:MM"
  period?: string;      // 周期规则 "daily@08:00" 或 "weekly@mon@09:00"
  progress: number;     // 0-100
  completed: boolean;
  reminder: boolean;    // 是否需要提醒
  scope: 'private' | 'group';  // 私聊任务还是群聊任务
  creatorId: string;    // 创建者 userId
  assigneeId: string;   // 被指派者 userId（公开任务时可为 'public'）
  groupId: string;      // 所属群聊（private 任务为空）
  createdAt: number;    // 创建时间戳
}
```

### 3.2 TaskManager（`src/task.ts`）

```typescript
class TaskManager {
  static tasks: { [assigneeId: string]: Task[] };
  
  static addTask(task: Task): void;
  static getTasks(assigneeId: string, groupId?: string): Task[];
  static updateTask(id: string, updates: Partial<Task>): boolean;
  static deleteTask(id: string): boolean;
  static getDueDeadlineTasks(): Task[];    // 24h 内到期的倒计时任务
  static getNextPeriodicTasks(): Task[];   // 需要设下一次闹钟的周期任务
  static cleanupExpired(): void;           // 删除过期任务
  
  // 持久化
  static load(): void;
  static save(): void;
  
  // Cron
  static initCron(ext: seal.ExtInfo): void;
  static dailyScan(): void;
}
```

### 3.3 存储

使用 SealDice storage：`ext.storageGet('taskList')` / `ext.storageSet('taskList', JSON)`

按 `assigneeId` 分区，结构：
```json
{
  "QQ:123456": [
    { "id": "1718700000", "name": "交报告", ... },
  ],
  "public": [
    { "id": "1718700001", "name": "群公告提醒", ... },
  ]
}
```

### 3.4 配置项

在 `src/config/config_memory.ts` 中新增：

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `任务提醒润色提示` | string | `用亲切自然的语气提醒用户，可以适当加入鼓励的话语` | 控制 AI 在发送任务提醒时的语气和风格方向 |

使用方式：闹钟触发时，将此配置值注入 AI 系统提示，作为润色指令：

```
你收到一条任务提醒，请按以下风格转述：
{任务提醒润色提示}

原始提醒：
⏳ 交报告 (进度: 30%, 截止: 2025-06-25)
剩余时间：7天

请在群聊中回复。
```

---

## 4. AI 工具设计

### 4.1 优化现有 `set_timer`（修复 AI 困惑）

**当前问题：** 参数强制拆成 year/month/day/hour/minute，AI 难以映射。

**修复方案：** 新增 `datetime` 和 `seconds` 参数，兼容旧参数：

| 参数 | 类型 | 说明 |
|------|------|------|
| `types` | enum | `target` / `interval`（保持） |
| `datetime` | string | **新增**：ISO 时间 "2025-06-25T08:00" 或 "2025-06-25" |
| `seconds` | integer | **新增**：相对秒数，如 561600（156小时） |
| `years/month/days/hours/minutes` | integer | 保留兼容，但标记为 deprecated |

优先级：`datetime` > `seconds` > `years+months+...`

**返回值优化：** 从 `设置定时器成功，请等待` 改为：
```
定时器已设置
类型：倒计时
触发时间：2025-06-25 08:00（北京时间）
提示内容：提醒用户交报告
```

### 4.2 新增任务工具

所有工具均需要在 `src/tool/tool_task.ts` 中实现，注册到 `ToolManager`。

#### create_task

```
name: create_task
description: 创建一个新任务，用于追踪待办事项和设置截止提醒
parameters:
  name: string (required) — 任务名称
  type: string (enum: 'deadline', 'periodic') — 任务类型
  datetime: string — 截止日期/时间，格式 YYYY-MM-DD 或 YYYY-MM-DD HH:MM
  period: string — 周期规则，如 "daily@08:00", "weekly@mon@09:00"
  reminder: boolean — 是否需要到期提醒，默认 true
  scope: string (enum: 'private', 'group') — 私聊/群聊任务
  assignee: string — 指派给谁（QQ号，默认自己）
```

#### list_tasks

```
name: list_tasks
description: 查看当前会话的任务列表
parameters:
  scope: string (enum: 'all', 'private', 'group') — 筛选范围
  assignee: string — 查看指定用户的任务
```

#### update_task

```
name: update_task
description: 更新任务进度或详情
parameters:
  task_id: string (required) — 任务ID（从 list_tasks 获取）
  progress: integer — 更新进度 0-100
  name: string — 修改任务名称
  datetime: string — 修改截止时间
  completed: boolean — 标记完成
```

#### delete_task

```
name: delete_task
description: 删除任务
parameters:
  task_id: string (required) — 任务ID
```

---

## 5. 用户指令设计

### `.ai task` 子命令

| 指令 | 权限 | 功能 |
|------|:--:|------|
| `.ai task add <名> <日期/周期>` | U | 创建任务 |
| `.ai task list [assignee]` | U | 查看任务 |
| `.ai task update <id> <进度>` | U | 更新进度 |
| `.ai task delete <id>` | U | 删除任务 |
| `.ai task remind` | I | 手动发送提醒 |

与 AI 工具共享同一个 `TaskManager` 后端。

---

## 6. 文件清单

| 文件 | 职责 | 改动类型 |
|------|------|----------|
| `src/task.ts` | Task 数据模型 + TaskManager CRUD + cron 调度 | **新建** |
| `src/tool/tool_task.ts` | AI 工具：create/list/update/delete_task | **新建** |
| `src/tool/tool_time.ts` | 优化 set_timer 参数 + 返回值 | **修改** |
| `src/cmd/sub_cmd/task.ts` | 用户指令：.ai task | **新建** |
| `src/cmd/root.ts` | 注册 task 子命令 | **修改** |
| `src/tool/tool.ts` | 注册新工具 | **修改** |
| `src/config/config_memory.ts` | 注册任务提醒润色配置项 | **修改** |
| `src/index.ts` | 初始化 TaskManager + cron | **修改** |

---

## 7. 自检

| 检查项 | 状态 |
|--------|:--:|
| 有无 TBD/TODO | ✅ 无 |
| 数据模型与调度逻辑一致 | ✅ cron + alarm 双层 |
| 作用域清晰 | ✅ 新文件独立，不改 TimerInfo |
| 现有 set_timer 兼容 | ✅ 新增参数，旧参数保留 deprecated |

---

## 8. 已确认

- Cron 扫描时间：每天 **0:00** 执行
- 过期任务：保留 **3 天** 后自动清理
- 周期任务：支持 **daily**（每天指定时刻）和 **weekly**（每周指定星期几+时刻）
