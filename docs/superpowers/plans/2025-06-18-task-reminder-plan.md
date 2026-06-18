# AI 任务提醒助手 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 AI 变为任务提醒助手——用户通过对话管理任务，到时 AI 自动润色提醒

**Architecture:** 新建 TaskManager（data+timer+cron），复用现有 TimerManager 设精确闹钟，AI 类增加排队机制解决并发冲突，新增 4 个 AI 工具 + 1 个子命令组

**Tech Stack:** TypeScript, SealDice API, 复用现有 AIManager/TimerManager/ConfigManager

---

## 文件结构

| 文件 | 职责 | 操作 |
|------|------|:--:|
| `src/task.ts` | Task 接口 + TaskManager 类（CRUD、持久化、cron 调度、闹钟创建） | 新建 |
| `src/AI/AI.ts` | 增加 `pendingReminders` 队列 + `processNextReminder()` + bucket 豁免 `'任务提醒'` | 修改 |
| `src/tool/tool_time.ts` | 优化 `set_timer`：新增 `datetime`/`seconds` 参数 + 返回值确认具体时间 | 修改 |
| `src/tool/tool_task.ts` | AI 工具：`create_task` / `list_tasks` / `update_task` / `delete_task` | 新建 |
| `src/config/config_memory.ts` | 注册 `任务提醒润色提示` 字符串配置项 | 修改 |
| `src/cmd/sub_cmd/task.ts` | 用户指令：`.ai task add/list/update/delete/remind` | 新建 |
| `src/cmd/root.ts` | 注册 `task` 子命令到 SubCmd.map | 修改 |
| `src/tool/tool.ts` | 注册 `tool_task.ts` 的 4 个工具 | 修改 |
| `src/index.ts` | 导入并初始化 TaskManager | 修改 |

---

### Task 1: Task 数据模型 + TaskManager

**Files:**
- Create: `src/task.ts`

- [ ] **Step 1: 定义 Task 接口和 TaskManager 类骨架**

```typescript
// src/task.ts
import { AIManager } from './AI/AI';
import { TimerManager } from './timer';
import { ConfigManager } from './config/configManager';
import { logger } from './logger';
import { fmtDate } from './utils/utils_string';
import { getSessionCtxAndMsg } from './utils/utils_seal';

const STORAGE_KEY = 'taskList';

export interface Task {
  id: string;
  name: string;
  type: 'deadline' | 'periodic';
  deadline?: string;      // "YYYY-MM-DD" 或 "YYYY-MM-DD HH:MM"
  period?: string;         // "daily@08:00" 或 "weekly@mon@09:00"
  progress: number;        // 0-100
  completed: boolean;
  reminder: boolean;
  scope: 'private' | 'group';
  creatorId: string;
  assigneeId: string;      // "QQ:xxx" 或 "public"
  groupId: string;
  createdAt: number;       // 秒级时间戳
  assignedTimerId?: string; // 关联的定时器标记（防重复创建）
}

export class TaskManager {
  static tasks: { [assigneeId: string]: Task[] } = {};

  static load(): void { /* Step 2 */ }
  static save(): void { /* Step 2 */ }
  static addTask(task: Task): void { /* Step 3 */ }
  static getTasks(assigneeId: string, groupId?: string): Task[] { /* Step 3 */ }
  static getTaskById(id: string): Task | undefined { /* Step 3 */ }
  static resolveTaskId(shortOrFullId: string): string { /* Step 3 */ }
  static updateTask(id: string, updates: Partial<Task>): boolean { /* Step 3 */ }
  static deleteTask(id: string): boolean { /* Step 3 */ }
  static getDueDeadlineTasks(): Task[] { /* Step 4 */ }
  static getNextPeriodicTasks(): Task[] { /* Step 4 */ }
  static cleanupExpired(): void { /* Step 4 */ }
  static resolveSession(task: Task): { ctx; msg; ai } | null { /* Step 5 */ }
  static createAlarm(task: Task): void { /* Step 5 */ }
  static timerFires(taskId: string): void { /* Step 5 */ }
  static dailyScan(): void { /* Step 6 */ }
  static initCron(ext: seal.ExtInfo): void { /* Step 6 */ }
}
```

- [ ] **Step 2: 实现持久化 load/save**

```typescript
static load(): void {
  try {
    const data = JSON.parse(ConfigManager.ext.storageGet(STORAGE_KEY) || '{}');
    if (typeof data === 'object' && !Array.isArray(data)) {
      this.tasks = data;
    }
  } catch (e) {
    logger.error('加载任务列表失败:', e);
  }
}

static save(): void {
  ConfigManager.ext.storageSet(STORAGE_KEY, JSON.stringify(this.tasks));
}
```

- [ ] **Step 3: 实现 CRUD（含短 ID 解析辅助函数）**

```typescript
static addTask(task: Task): void {
  if (!this.tasks[task.assigneeId]) {
    this.tasks[task.assigneeId] = [];
  }
  this.tasks[task.assigneeId].push(task);
  this.save();
}

static getTasks(assigneeId: string, groupId?: string): Task[] {
  const list = this.tasks[assigneeId] || [];
  if (!groupId) return list;
  return list.filter(t => t.groupId === groupId || t.scope === 'private');
}

static getTaskById(id: string): Task | undefined {
  for (const uid in this.tasks) {
    const found = this.tasks[uid].find(t => t.id === id);
    if (found) return found;
  }
  return undefined;
}

// 短 ID（≤6位）→ 完整 ID 解析。长 ID 直接返回
static resolveTaskId(shortOrFullId: string): string {
  if (shortOrFullId.length > 6) return shortOrFullId;
  for (const uid in this.tasks) {
    const found = this.tasks[uid].find(t => t.id.endsWith(shortOrFullId));
    if (found) return found.id;
  }
  return shortOrFullId;
}

static updateTask(id: string, updates: Partial<Task>): boolean {
  for (const uid in this.tasks) {
    const idx = this.tasks[uid].findIndex(t => t.id === id);
    if (idx !== -1) {
      const oldTask = this.tasks[uid][idx];
      this.tasks[uid][idx] = { ...oldTask, ...updates };
      if (updates.progress === 100 || updates.completed) {
        this.tasks[uid][idx].completed = true;
        this.tasks[uid][idx].progress = 100;
        // 标记完成时移除关联的定时器，避免空触发
        TimerManager.removeTimers('', `__TASK_${id}__`, ['target']);
        this.tasks[uid][idx].assignedTimerId = undefined;
      }
      // 截止时间变更 → 清除旧闹钟标记，等下次 cron 重新设
      if (updates.deadline && updates.deadline !== oldTask.deadline) {
        this.tasks[uid][idx].assignedTimerId = undefined;
        TimerManager.removeTimers('', `__TASK_${id}__`, ['target']);
      }
      this.save();
      return true;
    }
  }
  return false;
}

static deleteTask(id: string): boolean {
  for (const uid in this.tasks) {
    const idx = this.tasks[uid].findIndex(t => t.id === id);
    if (idx !== -1) {
      // 删除关联的定时器
      TimerManager.removeTimers('', `__TASK_${id}__`, ['target']);
      this.tasks[uid].splice(idx, 1);
      this.save();
      return true;
    }
  }
  return false;
}
```

- [ ] **Step 4: 实现筛选 + 清理方法**

```typescript
static getDueDeadlineTasks(): Task[] {
  const now = Math.floor(Date.now() / 1000);
  const due: Task[] = [];
  for (const uid in this.tasks) {
    for (const t of this.tasks[uid]) {
      if (t.type !== 'deadline' || t.completed || !t.deadline) continue;
      const deadlineTs = parseDeadline(t.deadline);
      if (deadlineTs === null) continue;
      const diff = deadlineTs - now;
      if (diff > 0 && diff <= 24 * 60 * 60) {
        due.push(t);
      }
    }
  }
  return due;
}

static getNextPeriodicTasks(): Task[] {
  const now = Math.floor(Date.now() / 1000);
  const due: Task[] = [];
  for (const uid in this.tasks) {
    for (const t of this.tasks[uid]) {
      if (t.type !== 'periodic' || t.completed || !t.period) continue;
      const nextTs = parsePeriodNext(t.period, now);
      if (nextTs !== null && nextTs - now <= 24 * 60 * 60) {
        due.push(t);
      }
    }
  }
  return due;
}

static cleanupExpired(): void {
  const now = Math.floor(Date.now() / 1000);
  const threeDaysAgo = now - 3 * 24 * 60 * 60;
  for (const uid in this.tasks) {
    this.tasks[uid] = this.tasks[uid].filter(t => {
  // 已完成任务：保留 3 天后清理
  if (t.completed) {
    // 近似：用 createdAt 替代 completedAt。若需精确，可加 completedAt 字段
    return (now - t.createdAt) < 3 * 24 * 60 * 60;
  }
      // 倒计时任务：截止日期是否已过 3 天
      if (t.type === 'deadline' && t.deadline) {
        const ts = parseDeadline(t.deadline);
        if (ts !== null && ts < threeDaysAgo) return false;
      }
      return true;
    });
  }
  this.save();
}

// 辅助：解析截止时间字符串为时间戳（基于本地时区，假设服务器 UTC+8）
function parseDeadline(deadline: string): number | null {
  const match = deadline.match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/);
  if (!match) return null;
  const [, y, m, d, h = '0', min = '0'] = match;
  return new Date(+y, +m - 1, +d, +h, +min).getTime() / 1000;
}

// 辅助：计算周期任务的下次触发时间
function parsePeriodNext(period: string, now: number): number | null {
  const dailyMatch = period.match(/^daily@(\d{2}):(\d{2})$/);
  if (dailyMatch) {
    const [, h, m] = dailyMatch;
    const d = new Date(now * 1000);
    d.setHours(+h, +m, 0, 0);
    if (d.getTime() / 1000 <= now) d.setDate(d.getDate() + 1);
    return Math.floor(d.getTime() / 1000);
  }
  const weeklyMatch = period.match(/^weekly@(mon|tue|wed|thu|fri|sat|sun)@(\d{2}):(\d{2})$/);
  if (weeklyMatch) {
    const dayMap: { [k: string]: number } = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const targetDay = dayMap[weeklyMatch[1]];
    const [, , h, m] = weeklyMatch;
    const d = new Date(now * 1000);
    d.setHours(+h, +m, 0, 0);
    const daysUntil = (targetDay - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + (daysUntil === 0 && d.getTime() / 1000 <= now ? 7 : daysUntil));
    return Math.floor(d.getTime() / 1000);
  }
  return null;
}
```

- [ ] **Step 5: 实现 resolveSession + createAlarm + timerFires**

```typescript
static resolveSession(task: Task): { ctx: seal.MsgContext; msg: seal.Message; ai: ReturnType<typeof AIManager.getAI> } | null {
  const eps = seal.getEndPoints();
  if (!eps || eps.length === 0) {
    logger.error('[TaskManager] 无法获取 EndPoint');
    return null;
  }
  const epId = eps[0].userId;
  const isPrivate = task.scope === 'private';
  const sid = isPrivate ? task.assigneeId : task.groupId;
  const { ctx, msg } = getSessionCtxAndMsg(epId, sid, isPrivate);
  return { ctx, msg, ai: AIManager.getAI(sid) };
}

static createAlarm(task: Task): void {
  let targetTs: number | null = null;
  if (task.type === 'deadline' && task.deadline) {
    targetTs = parseDeadline(task.deadline);
  } else if (task.type === 'periodic' && task.period) {
    targetTs = parsePeriodNext(task.period, Math.floor(Date.now() / 1000));
  }
  if (targetTs === null) return;
  const diff = targetTs - Math.floor(Date.now() / 1000);
  if (diff <= 0 || diff > 24 * 60 * 60) return;

  // 防止重启时重复创建：检查是否已有未触发的定时器
  const existing = TimerManager.getTimers('', `__TASK_${task.id}__`, ['target']);
  if (existing.length > 0) return;

  const session = this.resolveSession(task);
  if (!session) return;

  TimerManager.addTargetTimer(session.ctx, session.ai, targetTs, `__TASK_${task.id}__`);
  task.assignedTimerId = `${targetTs}`;
  this.save();
  logger.info(`[TaskManager] 闹钟已创建: ${task.name} → ${fmtDate(targetTs, ConfigManager.message.utcOffset)}`);
}

static timerFires(taskId: string): void {
  const task = this.getTaskById(taskId);
  if (!task || task.completed) return;

  const session = this.resolveSession(task);
  if (!session) return;
  const { ctx, msg, ai } = session;

  const remainingDays = task.deadline
    ? Math.ceil((parseDeadline(task.deadline)! - Date.now() / 1000) / 86400) : 0;
  let template = `⏳ ${task.name} (进度: ${task.progress}%, 截止: ${task.deadline || '无'})`;
  if (remainingDays > 0) template += `\n剩余时间：${remainingDays}天`;
  if (task.scope === 'group' && task.assigneeId !== 'public') {
    template += `\n[CQ:at,qq=${task.assigneeId.replace(/^QQ:/, '')}]`;
  }

  const polishHint = ConfigManager.memory.taskReminderPolish || '用亲切自然的语气提醒用户';
  const systemMsg = `你是任务提醒助手。${polishHint}\n\n以下是一条任务提醒，请用自然语气转述：\n${template}`;

  ai.context.addSystemUserMessage('任务提醒', systemMsg, []);
  ai.enqueueReminder(ctx, msg);

  task.assignedTimerId = undefined;
  if (task.type === 'periodic') this.createAlarm(task);
  this.save();
  logger.info(`[TaskManager] 闹钟触发: ${task.name}`);
}
```

- [ ] **Step 6: 实现 dailyScan + initCron**

```typescript
static dailyScan(): void {
  logger.info('[TaskManager] 开始每日扫描');
  this.cleanupExpired();

  const deadlineTasks = this.getDueDeadlineTasks();
  for (const task of deadlineTasks) this.createAlarm(task);

  const periodicTasks = this.getNextPeriodicTasks();
  for (const task of periodicTasks) this.createAlarm(task);

  logger.info(`[TaskManager] 扫描完成: ${deadlineTasks.length} 倒计时 + ${periodicTasks.length} 周期`);
}

static initCron(ext: seal.ExtInfo): void {
  this.load();
  seal.ext.registerTask(ext, 'cron', '0 0 * * *', () => {
    TaskManager.dailyScan();
  }, 'task_daily_scan', '任务系统每日扫描');
  this.dailyScan();
}
```

- [ ] **Step 7: 在 timer.ts 中增加任务定时器识别**

修改 `src/timer.ts` 的 `task()` 方法，在 `case 'target':` 分支中（line 209 附近），`content` 使用前插入：

```typescript
case 'target': {
    const target = timer.target;
    if (target > Math.floor(Date.now() / 1000)) {
        this.timerQueue.push(timer);
        continue;
    } else if (Math.floor(Date.now() / 1000) - target >= 60 * 60) {
        logger.info(`${timer.sid} 的${timer.type}定时器触发了，超时一小时，忽略执行`);
        continue;
    }

    // 任务定时器识别：content 为 __TASK_<taskId>__ 格式
    if (timer.content && timer.content.startsWith('__TASK_')) {
      const taskId = timer.content.slice(7, -2);
      const { TaskManager } = require('./task');  // 延迟导入避免循环依赖
      TaskManager.timerFires(taskId);
      continue;
    }

    const { sid, isPrivate, epId, set, content } = timer;
    // ... 原有逻辑 ...
```

- [ ] **Step 8: 构建验证**

```bash
npm run build
```
预期：编译通过

- [ ] **Step 9: 提交**

```bash
git add src/task.ts src/timer.ts
git commit -m "feat: add TaskManager with cron scheduling, GUGUtask reminders, and timer.ts integration"
```

---

### Task 2: 配置项 — 任务提醒润色提示

**Files:**
- Modify: `src/config/config_memory.ts`

- [ ] **Step 1: 在 register 方法中新增配置项**

在 `MemoryConfig.register()` 方法末尾添加：

```typescript
seal.ext.registerStringConfig(MemoryConfig.ext, '任务提醒润色提示',
    '用亲切自然的语气提醒用户，可以适当加入鼓励的话语',
    'AI 在发送任务提醒时的语气和风格方向。例如："用严厉的口吻" 或 "用可爱的语气，加颜文字"');
```

- [ ] **Step 2: 在 get 方法中读取（camelCase 键名）**

在 `MemoryConfig.get()` 返回对象中添加：

```typescript
taskReminderPolish: seal.ext.getStringConfig(MemoryConfig.ext, '任务提醒润色提示') || '用亲切自然的语气提醒用户',
```

任务代码中通过 `ConfigManager.memory.taskReminderPolish` 访问。

- [ ] **Step 3: 构建 + 提交**

```bash
npm run build
git add src/config/config_memory.ts
git commit -m "feat: add task reminder polish config key"
```

---

### Task 3: AI 排队机制 + Bucket 豁免

**Files:**
- Modify: `src/AI/AI.ts`

- [ ] **Step 1: 在 AI 类中添加 pendingReminders 队列**

在 `AI` 类属性区域添加：

```typescript
pendingReminders: { ctx: seal.MsgContext; msg: seal.Message }[] = [];
```

- [ ] **Step 2: 添加 enqueueReminder 方法**

```typescript
enqueueReminder(ctx: seal.MsgContext, msg: seal.Message): void {
  this.pendingReminders.push({ ctx, msg });
  if (!this.isChatting) {
    this.processNextReminder();
  }
}
```

- [ ] **Step 3: 添加 processNextReminder 方法**

```typescript
async processNextReminder(): Promise<void> {
  if (this.pendingReminders.length === 0) return;
  const { ctx, msg } = this.pendingReminders.shift()!;
  await this.chat(ctx, msg, '任务提醒');
}
```

- [ ] **Step 4: 在 chat() 的 finally 块中调用 processNextReminder**

找到 `this.isChatting = false;`，在其后添加：

```typescript
this.isChatting = false;
this.processNextReminder();  // 当前回复结束后立即处理排队提醒
```

- [ ] **Step 5: Bucket 豁免**

找到：

```typescript
if (reason !== '函数回调触发') {
```

改为：

```typescript
if (reason !== '函数回调触发' && reason !== '任务提醒') {
```

- [ ] **Step 6: 构建 + 提交**

```bash
npm run build
git add src/AI/AI.ts
git commit -m "feat: add pendingReminders queue + bucket exemption for task reminders"
```

---

### Task 4: 优化 set_timer 参数

**Files:**
- Modify: `src/tool/tool_time.ts`

- [ ] **Step 1: 在 set_timer 参数中添加 datetime 和 seconds**

在 `properties` 中（`hours` 之后、`count` 之前）添加：

```typescript
datetime: {
    type: 'string',
    description: '截止日期时间，格式 YYYY-MM-DD 或 YYYY-MM-DD HH:MM。优先级高于 years/months/days/hours/minutes'
},
seconds: {
    type: 'integer',
    description: '相对秒数，如 3600=1小时后。优先级高于 years/months/days/hours/minutes'
},
```

- [ ] **Step 2: 修改 solve 解析逻辑**

在 `toolSet.solve` 中，解构添加 `datetime` 和 `seconds`：

```typescript
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
```

- [ ] **Step 3: 优化返回值确认具体时间**

将 `return { content: '设置定时器成功，请等待', images: [] };` 改为：

```typescript
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
```

- [ ] **Step 4: 构建 + 提交**

```bash
npm run build
git add src/tool/tool_time.ts
git commit -m "feat: optimize set_timer — add datetime/seconds params + confirm actual time in reply"
```

---

### Task 5: AI 任务工具

**Files:**
- Create: `src/tool/tool_task.ts`
- Modify: `src/tool/tool.ts`

- [ ] **Step 1: create_task 工具**

```typescript
// src/tool/tool_task.ts
import { Tool } from './tool';
import { TaskManager, Task } from '../task';
import { logger } from '../logger';

export function registerTaskTools() {
  const toolCreate = new Tool({
    type: 'function',
    function: {
      name: 'create_task',
      description: '创建一个新任务，用于追踪待办事项和设置截止提醒。用户说"提醒我XX"或"帮我记一下XX"时使用。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '任务名称' },
          type: { type: 'string', enum: ['deadline', 'periodic'], description: 'deadline=倒计时截止, periodic=固定周期重复' },
          datetime: { type: 'string', description: '截止日期：YYYY-MM-DD 或 YYYY-MM-DD HH:MM。仅 deadline 类型需要' },
          period: { type: 'string', description: '周期规则：daily@HH:MM 或 weekly@星期@HH:MM。仅 periodic 类型需要。星期用 mon/tue/wed/thu/fri/sat/sun' },
          reminder: { type: 'boolean', description: '是否到期提醒，默认 true' },
          scope: { type: 'string', enum: ['private', 'group'], description: '私聊任务或群聊任务' },
          assignee: { type: 'string', description: '指派给谁的QQ号。不填默认自己。填"public"为公开任务' }
        },
        required: ['name', 'type']
      }
    }
  });
  toolCreate.solve = async (ctx, _, ai, args) => {
    const { name, type, datetime, period, reminder = true, scope, assignee } = args;
    const now = Math.floor(Date.now() / 1000);

    if (type === 'deadline' && !datetime) {
      return { content: '倒计时任务需要指定截止日期(datetime)，格式 YYYY-MM-DD 或 YYYY-MM-DD HH:MM', images: [] };
    }
    if (type === 'periodic' && !period) {
      return { content: '周期任务需要指定周期规则(period)，如 daily@08:00 或 weekly@mon@09:00', images: [] };
    }

    const task: Task = {
      id: `${now}_${Math.random().toString(36).slice(2, 8)}`,
      name, type,
      deadline: datetime || undefined,
      period: period || undefined,
      progress: 0, completed: false, reminder,
      scope: scope || (ctx.isPrivate ? 'private' : 'group'),
      creatorId: ctx.player.userId,
      assigneeId: assignee ? `QQ:${assignee}` : ctx.player.userId,
      groupId: ctx.isPrivate ? '' : ctx.group.groupId,
      createdAt: now,
    };

    TaskManager.addTask(task);
    logger.info(`[TaskManager] 任务已创建: ${name}`);
    return { content: `任务「${name}」已创建，截止 ${datetime || period}，到时候我会提醒你。`, images: [] };
  };
```

- [ ] **Step 2: list_tasks 工具**

```typescript
  const toolList = new Tool({
    type: 'function',
    function: {
      name: 'list_tasks',
      description: '查看当前会话的任务列表。用户问"我有哪些任务"时使用。',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['all', 'private', 'group'], description: '筛选范围' },
          assignee: { type: 'string', description: '查看指定QQ号用户的任务' }
        },
        required: []
      }
    }
  });
  toolList.solve = async (ctx, _, ai, args) => {
    const { scope = 'all', assignee } = args;
    const uid = assignee ? `QQ:${assignee}` : ctx.player.userId;
    let tasks = TaskManager.getTasks(uid, ctx.isPrivate ? '' : ctx.group.groupId);
    if (!ctx.isPrivate && scope !== 'private') {
      const publicTasks = (TaskManager.getTasks('public') || [])
        .filter(t => t.groupId === ctx.group.groupId);
      tasks = [...tasks, ...publicTasks];
    }
    if (tasks.length === 0) return { content: '当前没有任务。', images: [] };

    const list = tasks.map(t => {
      const status = t.completed ? '✅' : '⏳';
      const progress = t.completed ? '已完成' : `${t.progress}%`;
      const due = t.deadline || t.period || '无';
      return `[${t.id.slice(-6)}] ${status} ${t.name}\n  进度: ${progress} | 截止: ${due}`;
    }).join('\n');
    return { content: `任务列表：\n${list}`, images: [] };
  };
```

- [ ] **Step 3: update_task 工具（复用 resolveTaskId）**

```typescript
  const toolUpdate = new Tool({
    type: 'function',
    function: {
      name: 'update_task',
      description: '更新任务进度或详情。用户说"XX任务完成了"或"XX进度到50%"时使用。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '任务ID（从 list_tasks 返回的方括号中的短ID或完整ID）' },
          progress: { type: 'integer', description: '更新进度 0-100。100 自动标记完成' },
          name: { type: 'string', description: '修改任务名称' },
          datetime: { type: 'string', description: '修改截止时间' },
          completed: { type: 'boolean', description: '标记为已完成' }
        },
        required: ['task_id']
      }
    }
  });
  toolUpdate.solve = async (ctx, _, ai, args) => {
    const { task_id, progress, name, datetime, completed } = args;
    const fullId = TaskManager.resolveTaskId(task_id);
    const updates: Partial<Task> = {};
    if (progress !== undefined) updates.progress = Math.min(100, Math.max(0, progress));
    if (name !== undefined) updates.name = name;
    if (datetime !== undefined) updates.deadline = datetime;
    if (completed !== undefined) { updates.completed = completed; if (completed) updates.progress = 100; }
    const ok = TaskManager.updateTask(fullId, updates);
    return ok ? { content: '任务已更新', images: [] } : { content: `未找到任务 ${task_id}`, images: [] };
  };
```

- [ ] **Step 4: delete_task 工具（复用 resolveTaskId）**

```typescript
  const toolDelete = new Tool({
    type: 'function',
    function: {
      name: 'delete_task',
      description: '删除任务。用户说"删除XX任务"或"取消XX提醒"时使用。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '任务ID（从 list_tasks 返回的方括号中的短ID或完整ID）' }
        },
        required: ['task_id']
      }
    }
  });
  toolDelete.solve = async (ctx, _, ai, args) => {
    const { task_id } = args;
    const fullId = TaskManager.resolveTaskId(task_id);
    const ok = TaskManager.deleteTask(fullId);
    return ok ? { content: '任务已删除', images: [] } : { content: `未找到任务 ${task_id}`, images: [] };
  };
}
```

- [ ] **Step 5: 在 ToolManager 中注册**

修改 `src/tool/tool.ts`，在 `registerTool()` 中添加：

```typescript
import { registerTaskTools } from './tool_task';
// 在 registerTool() 内：
registerTaskTools();
```

- [ ] **Step 6: 构建 + 提交**

```bash
npm run build
git add src/tool/tool_task.ts src/tool/tool.ts
git commit -m "feat: add AI task tools — create/list/update/delete_task"
```

---

### Task 6: 用户指令 — .ai task

**Files:**
- Create: `src/cmd/sub_cmd/task.ts`
- Modify: `src/cmd/root.ts`

- [ ] **Step 1: 实现 task 子命令**

```typescript
// src/cmd/sub_cmd/task.ts
import { TaskManager, Task } from '../../task';
import { U, I } from '../privilege';
import { SubCmd, SubCmdContext } from '../root';

export function registerCmdTask() {
  const cmd = new SubCmd('task');
  cmd.desc = '任务管理';
  cmd.help = `帮助:
【.ai task add <任务名> <截止日期/周期>】创建任务
【.ai task list】查看任务列表
【.ai task update <任务ID> <进度>】更新任务进度
【.ai task delete <任务ID>】删除任务
【.ai task remind】手动发送提醒`;
  cmd.priv = { priv: U, args: { remind: { priv: I } } };
  cmd.solve = (scc: SubCmdContext) => {
    const { ctx, msg, cmdArgs, ret } = scc;
    const val2 = cmdArgs.getArgN(2);
    switch (val2) {
      case 'add': {
        const name = cmdArgs.getArgN(3);
        const datetime = cmdArgs.getArgN(4);
        if (!name || !datetime) {
          seal.replyToSender(ctx, msg, '【.ai task add <任务名> <YYYY-MM-DD 或 daily@HH:MM>】');
          return ret;
        }
        const type = datetime.match(/^\d{4}-\d{2}-\d{2}/) ? 'deadline' : 'periodic';
        const now = Math.floor(Date.now() / 1000);
        const task: Task = {
          id: `${now}_${Math.random().toString(36).slice(2, 8)}`,
          name, type,
          deadline: type === 'deadline' ? datetime : undefined,
          period: type === 'periodic' ? datetime : undefined,
          progress: 0, completed: false, reminder: true,
          scope: ctx.isPrivate ? 'private' : 'group',
          creatorId: ctx.player.userId,
          assigneeId: ctx.player.userId,
          groupId: ctx.isPrivate ? '' : ctx.group.groupId,
          createdAt: now,
        };
        TaskManager.addTask(task);
        seal.replyToSender(ctx, msg, `任务「${name}」已创建`);
        return ret;
      }
      case 'list': {
        const tasks = TaskManager.getTasks(ctx.player.userId, ctx.isPrivate ? '' : ctx.group.groupId);
        if (tasks.length === 0) {
          seal.replyToSender(ctx, msg, '暂无任务');
          return ret;
        }
        const list = tasks.map(t =>
          `[${t.id.slice(-6)}] ${t.completed ? '✅' : '⏳'} ${t.name} | 进度:${t.progress}% | 截止:${t.deadline || t.period}`
        ).join('\n');
        seal.replyToSender(ctx, msg, list);
        return ret;
      }
      case 'update': {
        const id = cmdArgs.getArgN(3);
        const progress = parseInt(cmdArgs.getArgN(4));
        if (!id || isNaN(progress)) {
          seal.replyToSender(ctx, msg, '【.ai task update <任务ID> <进度0-100>】');
          return ret;
        }
        const fullId = TaskManager.resolveTaskId(id);
        TaskManager.updateTask(fullId, { progress: Math.min(100, Math.max(0, progress)) });
        seal.replyToSender(ctx, msg, `任务进度更新为 ${progress}%`);
        return ret;
      }
      case 'delete': {
        const id = cmdArgs.getArgN(3);
        if (!id) {
          seal.replyToSender(ctx, msg, '【.ai task delete <任务ID>】');
          return ret;
        }
        const fullId = TaskManager.resolveTaskId(id);
        TaskManager.deleteTask(fullId);
        seal.replyToSender(ctx, msg, '任务已删除');
        return ret;
      }
      case 'remind': {
        seal.replyToSender(ctx, msg, '提醒由系统自动处理，无需手动触发。');
        return ret;
      }
      default: {
        seal.replyToSender(ctx, msg, cmd.help);
        return ret;
      }
    }
  };
}
```

- [ ] **Step 2: 在 root.ts 中注册**

修改 `src/cmd/root.ts`：
- 添加：`import { registerCmdTask } from './sub_cmd/task';`
- 在 `SubCmd.register()` 中添加：`registerCmdTask();`

- [ ] **Step 3: 构建 + 提交**

```bash
npm run build
git add src/cmd/sub_cmd/task.ts src/cmd/root.ts
git commit -m "feat: add .ai task subcommand — add/list/update/delete"
```

---

### Task 7: 初始化入口

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 导入并初始化 TaskManager**

```typescript
import { TaskManager } from './task';
// 在 main() 中，ext 注册完成后：
TaskManager.initCron(ext);
```

- [ ] **Step 2: 构建 + 提交**

```bash
npm run build
git add src/index.ts
git commit -m "feat: initialize TaskManager with daily cron at startup"
```

---

### Task 8: 全局验证 + 版本 bump

- [ ] **Step 1: 完整构建**

```bash
npm run build
```
预期：编译通过

- [ ] **Step 2: 版本 bump**

`src/config/config.ts`: `VERSION` → `"5.1.11"`
`header.txt`: `@version` → `5.1.11`

- [ ] **Step 3: 最终提交**

```bash
git add src/config/config.ts header.txt
git commit -m "feat: task reminder system complete — v5.1.11"
```

---

## 自检

| 检查项 | 状态 |
|--------|:--:|
| 覆盖所有设计需求 | ✅ Task 模型、Cron、AI 工具、用户指令、润色配置、排队机制 |
| config 键名正确 | ✅ `ConfigManager.memory.taskReminderPolish`；`seal.ext.getStringConfig` 确认存在（sealdocu.md L90） |
| 防重复定时器 | ✅ `createAlarm` 检查 `TimerManager.getTimers`；`assignedTimerId` 为辅助标记 |
| 完成任务清理定时器 | ✅ `updateTask` completed=true 时调用 `removeTimers` |
| 周期任务清理 | ✅ `cleanupExpired` 同时清理 deadline 过期和 completed 旧任务（createdAt 近似，可后续加 completedAt） |
| 截止更新重调度 | ✅ `updateTask` 检测 deadline 变更 → 清除旧闹钟 |
| 短 ID 去重 | ✅ `TaskManager.resolveTaskId()` 统一解析 |
| timer.ts 集成 | ✅ `content.startsWith('__TASK_')` → `slice(7, -2)` + `require('./task')` |
| 类型安全 | ✅ `resolveSession` 返回 `ReturnType&lt;typeof AIManager.getAI&gt;` 替代 `any` |
| 无占位符 | ✅ 每步有具体代码 |
| 现有 set_timer 兼容 | ✅ 新参数可选，旧参数保留 |
