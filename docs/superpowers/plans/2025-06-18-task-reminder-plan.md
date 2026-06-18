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
| `src/tool/tool.ts` | 注册 `tool_task.ts` 的 4 个工具 + 调用 `TaskManager.initCron()` | 修改 |
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
  assignedTimerId?: string; // 关联的 TimerManager 定时器记录
}

export class TaskManager {
  static tasks: { [assigneeId: string]: Task[] } = {};
  
  static load(): void { /* Step 2 */ }
  static save(): void { /* Step 2 */ }
  static addTask(task: Task): void { /* Step 3 */ }
  static getTasks(assigneeId: string, groupId?: string): Task[] { /* Step 3 */ }
  static getTaskById(id: string): Task | undefined { /* Step 3 */ }
  static updateTask(id: string, updates: Partial<Task>): boolean { /* Step 3 */ }
  static deleteTask(id: string): boolean { /* Step 3 */ }
  static getDueDeadlineTasks(): Task[] { /* Step 4 */ }
  static getNextPeriodicTasks(): Task[] { /* Step 4 */ }
  static cleanupExpired(): void { /* Step 4 */ }
  static createAlarm(task: Task): void { /* Step 5 */ }
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

- [ ] **Step 3: 实现 CRUD**

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

static updateTask(id: string, updates: Partial<Task>): boolean {
  for (const uid in this.tasks) {
    const idx = this.tasks[uid].findIndex(t => t.id === id);
    if (idx !== -1) {
      this.tasks[uid][idx] = { ...this.tasks[uid][idx], ...updates };
      if (updates.progress === 100) {
        this.tasks[uid][idx].completed = true;
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
      this.tasks[uid].splice(idx, 1);
      this.save();
      return true;
    }
  }
  return false;
}
```

- [ ] **Step 4: 实现筛选方法**

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
      if (diff > 0 && diff <= 24 * 60 * 60) {  // 24h 内
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
      if (!t.deadline) return true;
      const ts = parseDeadline(t.deadline);
      if (ts === null) return true;
      return ts >= threeDaysAgo || t.completed;
    });
  }
  this.save();
}

// 辅助：解析截止时间字符串为时间戳
function parseDeadline(deadline: string): number | null {
  const match = deadline.match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/);
  if (!match) return null;
  const [, y, m, d, h = '0', min = '0'] = match;
  return new Date(+y, +m - 1, +d, +h, +min).getTime() / 1000;
}

// 辅助：计算周期任务的下次触发时间
function parsePeriodNext(period: string, now: number): number | null {
  // daily@08:00
  const dailyMatch = period.match(/^daily@(\d{2}):(\d{2})$/);
  if (dailyMatch) {
    const [, h, m] = dailyMatch;
    const d = new Date(now * 1000);
    d.setHours(+h, +m, 0, 0);
    if (d.getTime() / 1000 <= now) d.setDate(d.getDate() + 1);
    return Math.floor(d.getTime() / 1000);
  }
  // weekly@mon@09:00
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

- [ ] **Step 5: 实现闹钟创建（注入上下文 + 排队）**

```typescript
static createAlarm(task: Task): void {
  let targetTs: number | null = null;
  if (task.type === 'deadline' && task.deadline) {
    targetTs = parseDeadline(task.deadline);
  } else if (task.type === 'periodic' && task.period) {
    targetTs = parsePeriodNext(task.period, Math.floor(Date.now() / 1000));
  }
  if (targetTs === null) return;
  
  // 使用 TimerManager 创建绝对时间定时器
  // target 已经是秒级时间戳，直接存储为 target 类型定时器
  // 但 TimerManager.addTargetTimer 需要 ctx/ai/content，而这里我们用一个桥接：
  // 将 task.id 存入 content，触发时由 task timerFires 回调处理
  // 简单做法：直接用秒数计算，不通过 TimerManager 的完整 target 路径
  // 复用现有 TimerManager 的 target 定时器：
  const now = Math.floor(Date.now() / 1000);
  const diff = targetTs - now;
  if (diff <= 0 || diff > 24 * 60 * 60) return;
  
  // 找到对应会话的 ctx 和 msg
  const isPrivate = task.scope === 'private';
  const sid = isPrivate ? task.assigneeId : task.groupId;
  const epId = task.creatorId; // 简化：用创建者的 epId
  
  // 使用 TimerManager.addIntervalTimer 的 target 变体
  // 直接调用底层 setTargetTimer
  // 这里不直接调 TimerManager，而是存为一个简化的 target timer
  // 实际使用 task.content 作为定时器触发内容
}
```

等等，`createAlarm` 需要获取 ctx。task 存储了 `creatorId` 和 `groupId`，但需要 `epId`。从 SealDice API 中可以通过 `seal.getEndPoints()` 获取。

重新设计 `createAlarm`：

```typescript
static createAlarm(task: Task): void {
  let targetTs: number | null = null;
  if (task.type === 'deadline' && task.deadline) {
    targetTs = parseDeadline(task.deadline);
  } else if (task.type === 'periodic' && task.period) {
    targetTs = parsePeriodNext(task.period, Math.floor(Date.now() / 1000));
  }
  if (targetTs === null) return;
  
  const now = Math.floor(Date.now() / 1000);
  const diff = targetTs - now;
  if (diff <= 0 || diff > 24 * 60 * 60) return;
  
  const eps = seal.getEndPoints();
  if (!eps || eps.length === 0) {
    logger.error('[TaskManager] 无法获取 EndPoint，闹钟创建失败');
    return;
  }
  const epId = eps[0].userId;
  const isPrivate = task.scope === 'private';
  const sid = isPrivate ? task.assigneeId : task.groupId;
  const { ctx, msg } = getSessionCtxAndMsg(epId, sid, isPrivate);
  
  // 创建一个 content 包含 task.id 的定时器
  // 触发时由 TaskManager.timerFires 处理
  TimerManager.addTargetTimer(ctx, AIManager.getAI(sid), targetTs, `__TASK_${task.id}__`);
  logger.info(`[TaskManager] 闹钟已创建: ${task.name} → ${fmtDate(targetTs, ConfigManager.message.utcOffset)}`);
}
```

但这里有个问题：TimerManager.addTargetTimer 触发时调用 `ai.chat()` 注入的是 content（即 `__TASK_${task.id}__`）作为指示，但我们需要的是模板格式化后的完整提醒文本。

解决方案：定时器触发时，我们通过 `content` 前缀识别为任务提醒，然后在 `timerFires` 中查询 task 构建完整模板。

实际上更简单的方案：不修改 TimerManager，而是在 cron 扫描时直接为每个 24h 内的 task 调用 `ai.enqueueReminder` 注入提醒。这样闹钟就是即时生效的。

不对，cron 是每天 0:00 执行，那时候可能不是提醒的时间。应该是：
1. Cron 扫描 → 发现 task A 在 8:00 到期（还剩 8h）
2. 创建一个 8h 后的定时器（用 TimerManager）
3. 定时器触发 → 识别 content 前缀 `__TASK_` → 调用 `timerFires(task)` → 构建模板 → 注入上下文 → 排队

但 TimerManager 的 task() 方法中，target 定时器触发后会直接调 `ai.chat()`。我们需要修改触发逻辑让它识别任务定时器。

让我重新思考这个问题。最简洁的方式：

**在 `timer.ts` 的 `task()` 方法中，检查 `content` 是否以 `__TASK_` 开头。如果是，调用 TaskManager.timerFires 处理，而不是走默认逻辑。**

```typescript
// timer.ts task() 方法中的 target 分支，在 210 行附近插入：
if (content.startsWith('__TASK_')) {
  const taskId = content.slice(7);
  TaskManager.timerFires(taskId);
  continue;
}
```

然后 TaskManager.timerFires：
```typescript
static timerFires(taskId: string): void {
  const task = this.getTaskById(taskId);
  if (!task || task.completed) return;
  
  const isPrivate = task.scope === 'private';
  const sid = isPrivate ? task.assigneeId : task.groupId;
  const eps = seal.getEndPoints();
  if (!eps || eps.length === 0) return;
  const epId = eps[0].userId;
  const { ctx, msg } = getSessionCtxAndMsg(epId, sid, isPrivate);
  const ai = AIManager.getAI(sid);
  
  // 构建 GUGUtask 格式提醒模板
  const remainingDays = task.deadline
    ? Math.ceil((parseDeadline(task.deadline)! - Date.now() / 1000) / 86400)
    : 0;
  let template = `⏳ ${task.name} (进度: ${task.progress}%, 截止: ${task.deadline || '无'})`;
  if (remainingDays > 0) template += `\n剩余时间：${remainingDays}天`;
  
  // 群聊时 @用户
  if (task.scope === 'group' && task.assigneeId !== 'public') {
    const qq = task.assigneeId.replace(/^QQ:/, '');
    template += `\n[CQ:at,qq=${qq}]`;
  }
  
  // 注入润色配置
  const polishHint = ConfigManager.memory.taskReminderPolish || '用亲切自然的语气提醒用户';
  
  const systemMsg = `你是任务提醒助手。${polishHint}\n\n以下是一条任务提醒，请用自然语气转述：\n${template}`;
  
  ai.context.addSystemUserMessage('任务提醒', systemMsg, []);
  ai.enqueueReminder(ctx, msg);
  
  // 周期任务：重新创建下一次闹钟
  if (task.type === 'periodic') {
    this.createAlarm(task);
  }
  
  logger.info(`[TaskManager] 闹钟触发: ${task.name}`);
}
```

好的，这个设计清晰了。让我继续写完整的计划。

- [ ] **Step 5: 实现 createAlarm 和 timerFires**

```typescript
static createAlarm(task: Task): void {
  let targetTs: number | null = null;
  if (task.type === 'deadline' && task.deadline) {
    targetTs = parseDeadline(task.deadline);
  } else if (task.type === 'periodic' && task.period) {
    targetTs = parsePeriodNext(task.period, Math.floor(Date.now() / 1000));
  }
  if (targetTs === null) return;
  
  const now = Math.floor(Date.now() / 1000);
  const diff = targetTs - now;
  if (diff <= 0 || diff > 24 * 60 * 60) return;
  
  const eps = seal.getEndPoints();
  if (!eps || eps.length === 0) {
    logger.error('[TaskManager] 无法获取 EndPoint');
    return;
  }
  const epId = eps[0].userId;
  const isPrivate = task.scope === 'private';
  const sid = isPrivate ? task.assigneeId : task.groupId;
  const { ctx, msg } = getSessionCtxAndMsg(epId, sid, isPrivate);
  
  TimerManager.addTargetTimer(ctx, AIManager.getAI(sid), targetTs, `__TASK_${task.id}__`);
}

static timerFires(taskId: string): void {
  const task = this.getTaskById(taskId);
  if (!task || task.completed) return;
  
  const isPrivate = task.scope === 'private';
  const sid = isPrivate ? task.assigneeId : task.groupId;
  const eps = seal.getEndPoints();
  if (!eps || eps.length === 0) return;
  const epId = eps[0].userId;
  const { ctx, msg } = getSessionCtxAndMsg(epId, sid, isPrivate);
  const ai = AIManager.getAI(sid);
  
  const remainingDays = task.deadline
    ? Math.ceil((parseDeadline(task.deadline)! - Date.now() / 1000) / 86400)
    : 0;
  let template = `⏳ ${task.name} (进度: ${task.progress}%, 截止: ${task.deadline || '无'})`;
  if (remainingDays > 0) template += `\n剩余时间：${remainingDays}天`;
  if (task.scope === 'group' && task.assigneeId !== 'public') {
    const qq = task.assigneeId.replace(/^QQ:/, '');
    template += `\n[CQ:at,qq=${qq}]`;
  }
  
  const polishHint = ConfigManager.memory?.['任务提醒润色提示'] as string || '用亲切自然的语气提醒用户';
  const systemMsg = `你是任务提醒助手。${polishHint}\n\n以下是一条任务提醒，请用自然语气转述：\n${template}`;
  
  ai.context.addSystemUserMessage('任务提醒', systemMsg, []);
  ai.enqueueReminder(ctx, msg);
  
  if (task.type === 'periodic') {
    this.createAlarm(task);
  }
  
  logger.info(`[TaskManager] 闹钟触发: ${task.name}`);
}
```

- [ ] **Step 6: 实现 dailyScan + initCron**

```typescript
static dailyScan(): void {
  logger.info('[TaskManager] 开始每日扫描');
  
  // 1. 清理过期任务
  this.cleanupExpired();
  
  // 2. 为 24h 内到期的倒计时任务创建闹钟
  const deadlineTasks = this.getDueDeadlineTasks();
  for (const task of deadlineTasks) {
    this.createAlarm(task);
  }
  
  // 3. 为周期任务创建闹钟
  const periodicTasks = this.getNextPeriodicTasks();
  for (const task of periodicTasks) {
    this.createAlarm(task);
  }
  
  logger.info(`[TaskManager] 扫描完成: ${deadlineTasks.length} 倒计时 + ${periodicTasks.length} 周期`);
}

static initCron(ext: seal.ExtInfo): void {
  this.load();
  // 每天 0:00 执行
  seal.ext.registerTask(ext, 'cron', '0 0 * * *', () => {
    TaskManager.dailyScan();
  }, 'task_daily_scan', '任务系统每日扫描');
  
  // 启动时也执行一次
  this.dailyScan();
}
```

- [ ] **Step 7: 在 timer.ts 中增加任务定时器识别**

修改 `src/timer.ts` 的 `task()` 方法，在 `case 'target':` 分支中（line 209 附近），content 解析前插入：

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
    
    // ★ 新增：任务定时器识别
    if (timer.content.startsWith('__TASK_')) {
        const taskId = timer.content.slice(7, -2); // 去掉前后的 __
        // 延迟导入避免循环依赖
        const { TaskManager: TM } = require('./task');
        TM.timerFires(taskId);
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
git commit -m "feat: add TaskManager with cron scheduling and GUGUtask-style reminders"
```

---

### Task 2: 配置项 — 任务提醒润色提示

**Files:**
- Modify: `src/config/config_memory.ts`

- [ ] **Step 1: 在 register 方法中新增配置项**

在 `src/config/config_memory.ts` 的 `register()` 方法末尾添加：

```typescript
seal.ext.registerStringConfig(MemoryConfig.ext, '任务提醒润色提示', '用亲切自然的语气提醒用户，可以适当加入鼓励的话语',
    'AI 在发送任务提醒时的语气和风格方向。例如："用严厉的口吻" 或 "用可爱的语气，加颜文字"');
```

- [ ] **Step 2: 在 refresh 方法中读取**

在 `refresh()` 返回对象中添加：

```typescript
taskReminderPolish: seal.ext.getStringConfig(MemoryConfig.ext, '任务提醒润色提示'),
```

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

在 `AI` 类属性区域（约 line 85 附近）添加：

```typescript
pendingReminders: { ctx: seal.MsgContext; msg: seal.Message }[] = [];
```

- [ ] **Step 2: 添加 enqueueReminder 方法**

在 AI 类中（`chat()` 方法之前）添加：

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

找到 `this.isChatting = false;`（约 line 191），在其后添加：

```typescript
this.isChatting = false;
this.processNextReminder();  // ★ 新增
```

- [ ] **Step 5: Bucket 豁免**

找到 bucket 检查行：

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

在 `properties` 中（`hours` 定义之后，`count` 之前）添加：

```typescript
datetime: {
    type: 'string',
    description: '截止日期时间，格式 YYYY-MM-DD 或 YYYY-MM-DD HH:MM。与 seconds/years 互斥，优先级最高'
},
seconds: {
    type: 'integer',
    description: '相对秒数，如 3600 表示 1 小时后。与 datetime/years 互斥'
},
```

- [ ] **Step 2: 修改 solve 方法支持 datetime**

在 `toolSet.solve` 中（约 line 70），解构参数中添加 `datetime` 和 `seconds`：

```typescript
const { types, datetime, seconds, years = 0, months = 0, days = 0, hours = 0, minutes, count = 1, content } = args;
```

在 `switch (types)` 之前，添加 datetime/seconds 解析：

```typescript
let y = parseInt(years), m = parseInt(months), d = parseInt(days), h = parseInt(hours), min = parseInt(minutes);
let c = parseInt(count);

// datetime 优先级最高
if (datetime) {
  const match = datetime.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/);
  if (match) {
    y = parseInt(match[1]);
    m = parseInt(match[2]);
    d = parseInt(match[3]);
    h = match[4] ? parseInt(match[4]) : 0;
    min = match[5] ? parseInt(match[5]) : 0;
  } else {
    return { content: 'datetime 格式错误，应为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM', images: [] };
  }
} else if (seconds) {
  // seconds 覆盖 years/months/days/hours
  y = 0; m = 0; d = 0; h = 0; min = Math.ceil(seconds / 60);
}
```

- [ ] **Step 3: 优化返回值，确认具体时间**

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
    const mins2 = mins;
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
      description: '创建一个新任务，用于追踪待办事项和设置截止提醒。用户说"提醒我XX"或"帮我记一下XX"时使用此工具。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '任务名称' },
          type: { type: 'string', enum: ['deadline', 'periodic'], description: 'deadline=倒计时截止, periodic=固定周期重复' },
          datetime: { type: 'string', description: '截止日期：YYYY-MM-DD 或 YYYY-MM-DD HH:MM。仅 deadline 类型需要' },
          period: { type: 'string', description: '周期规则：daily@HH:MM 或 weekly@星期@HH:MM。仅 periodic 类型需要。星期用 mon/tue/wed/thu/fri/sat/sun' },
          reminder: { type: 'boolean', description: '是否到期提醒，默认 true' },
          scope: { type: 'string', enum: ['private', 'group'], description: '私聊任务(仅自己可见)还是群聊任务(全群可见)' },
          assignee: { type: 'string', description: '指派给谁的QQ号。不填默认自己。填"public"为公开任务' }
        },
        required: ['name', 'type']
      }
    }
  });
  toolCreate.solve = async (ctx, _, ai, args) => {
    const { name, type, datetime, period, reminder = true, scope, assignee } = args;
    const now = Math.floor(Date.now() / 1000);
    
    const task: Task = {
      id: `${now}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      type,
      deadline: datetime || undefined,
      period: period || undefined,
      progress: 0,
      completed: false,
      reminder,
      scope: scope || (ctx.isPrivate ? 'private' : 'group'),
      creatorId: ctx.player.userId,
      assigneeId: assignee ? `QQ:${assignee}` : ctx.player.userId,
      groupId: ctx.isPrivate ? '' : ctx.group.groupId,
      createdAt: now,
    };
    
    if (type === 'deadline' && !datetime) {
      return { content: '倒计时任务需要指定截止日期(datetime)', images: [] };
    }
    if (type === 'periodic' && !period) {
      return { content: '周期任务需要指定周期规则(period)，如 daily@08:00', images: [] };
    }
    
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
      description: '查看当前会话的任务列表。用户问"我有哪些任务"时使用此工具。',
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
    
    // 同时获取公开任务
    if (!ctx.isPrivate && scope !== 'private') {
      const publicTasks = (TaskManager.getTasks('public') || [])
        .filter(t => t.groupId === ctx.group.groupId);
      tasks = [...tasks, ...publicTasks];
    }
    
    if (tasks.length === 0) {
      return { content: '当前没有任务。', images: [] };
    }
    
    const list = tasks.map(t => {
      const status = t.completed ? '✅' : '⏳';
      const progress = t.completed ? '已完成' : `${t.progress}%`;
      const due = t.deadline || t.period || '无';
      return `[${t.id.slice(-4)}] ${status} ${t.name}\n  进度: ${progress} | 截止: ${due}`;
    }).join('\n');
    
    return { content: `任务列表：\n${list}`, images: [] };
  };
```

- [ ] **Step 3: update_task 工具**

```typescript
  const toolUpdate = new Tool({
    type: 'function',
    function: {
      name: 'update_task',
      description: '更新任务进度或详情。用户说"XX任务完成了"或"XX进度到50%"时使用。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '任务ID（从 list_tasks 返回的方括号中的4位短ID）' },
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
    
    // task_id 可能是短ID（后4位），需要模糊匹配
    let fullId = task_id;
    if (task_id.length <= 6) {
      for (const uid in TaskManager.tasks) {
        const found = TaskManager.tasks[uid].find(t => t.id.endsWith(task_id));
        if (found) { fullId = found.id; break; }
      }
    }
    
    const updates: Partial<Task> = {};
    if (progress !== undefined) updates.progress = Math.min(100, Math.max(0, progress));
    if (name !== undefined) updates.name = name;
    if (datetime !== undefined) updates.deadline = datetime;
    if (completed !== undefined) {
      updates.completed = completed;
      if (completed) updates.progress = 100;
    }
    
    const ok = TaskManager.updateTask(fullId, updates);
    return ok
      ? { content: `任务已更新`, images: [] }
      : { content: `未找到任务 ${task_id}`, images: [] };
  };
```

- [ ] **Step 4: delete_task 工具**

```typescript
  const toolDelete = new Tool({
    type: 'function',
    function: {
      name: 'delete_task',
      description: '删除任务。用户说"删除XX任务"或"取消XX提醒"时使用。',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '任务ID（从 list_tasks 返回的方括号中的4位短ID）' }
        },
        required: ['task_id']
      }
    }
  });
  toolDelete.solve = async (ctx, _, ai, args) => {
    const { task_id } = args;
    
    let fullId = task_id;
    if (task_id.length <= 6) {
      for (const uid in TaskManager.tasks) {
        const found = TaskManager.tasks[uid].find(t => t.id.endsWith(task_id));
        if (found) { fullId = found.id; break; }
      }
    }
    
    const ok = TaskManager.deleteTask(fullId);
    return ok
      ? { content: '任务已删除', images: [] }
      : { content: `未找到任务 ${task_id}`, images: [] };
  };
}
```

- [ ] **Step 5: 在 ToolManager 中注册**

修改 `src/tool/tool.ts`，在 `registerTool()` 中添加：

```typescript
import { registerTaskTools } from './tool_task';
// ... 在 registerTool() 中：
registerTaskTools();
```

- [ ] **Step 6: 构建 + 提交**

```bash
npm run build
git add src/tool/tool_task.ts src/tool/tool.ts
git commit -m "feat: add AI task tools — create_task/list_tasks/update_task/delete_task"
```

---

### Task 6: 用户指令 — .ai task

**Files:**
- Create: `src/cmd/sub_cmd/task.ts`
- Modify: `src/cmd/root.ts`

- [ ] **Step 1: 实现 task 子命令**

```typescript
// src/cmd/sub_cmd/task.ts
import { TaskManager } from '../../task';
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
        const task = {
          id: `${Math.floor(Date.now()/1000)}_${Math.random().toString(36).slice(2,8)}`,
          name, type,
          deadline: type === 'deadline' ? datetime : undefined,
          period: type === 'periodic' ? datetime : undefined,
          progress: 0, completed: false, reminder: true,
          scope: ctx.isPrivate ? 'private' : 'group',
          creatorId: ctx.player.userId,
          assigneeId: ctx.player.userId,
          groupId: ctx.isPrivate ? '' : ctx.group.groupId,
          createdAt: Math.floor(Date.now() / 1000),
        };
        TaskManager.addTask(task);
        seal.replyToSender(ctx, msg, `任务「${name}」已创建`);
        return ret;
      }
      case 'list': {
        const uid = ctx.player.userId;
        const tasks = TaskManager.getTasks(uid, ctx.isPrivate ? '' : ctx.group.groupId);
        if (tasks.length === 0) {
          seal.replyToSender(ctx, msg, '暂无任务');
          return ret;
        }
        const list = tasks.map(t =>
          `[${t.id.slice(-4)}] ${t.completed ? '✅' : '⏳'} ${t.name} | 进度:${t.progress}% | 截止:${t.deadline || t.period}`
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
        TaskManager.updateTask(id, { progress: Math.min(100, Math.max(0, progress)) });
        seal.replyToSender(ctx, msg, `任务 ${id} 进度更新为 ${progress}%`);
        return ret;
      }
      case 'delete': {
        const id = cmdArgs.getArgN(3);
        if (!id) {
          seal.replyToSender(ctx, msg, '【.ai task delete <任务ID>】');
          return ret;
        }
        TaskManager.deleteTask(id);
        seal.replyToSender(ctx, msg, `任务 ${id} 已删除`);
        return ret;
      }
      case 'remind': {
        seal.replyToSender(ctx, msg, '提醒功能请通过 AI 对话触发');
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
- 添加 import：`import { registerCmdTask } from './sub_cmd/task';`
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

- [ ] **Step 1: 在 index.ts 中导入并初始化 TaskManager**

在 `src/index.ts` 中找到初始化部分（`main()` 函数内），添加：

```typescript
import { TaskManager } from './task';
// ... 在 main() 中，ext 注册完成后：
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
预期：编译通过，无报错

- [ ] **Step 2: 检查循环依赖**

确认 `src/task.ts` → `src/timer.ts` → `src/task.ts` 的循环依赖通过 `require()` 延迟导入解决

- [ ] **Step 3: 版本 bump**

`src/config/config.ts`: `VERSION` 从 `"5.1.10"` → `"5.1.11"`
`header.txt`: `@version` 从 `5.1.10` → `5.1.11`

- [ ] **Step 4: 最终提交**

```bash
git add src/config/config.ts header.txt
git commit -m "feat: task reminder system complete — v5.1.11"
```

---

## 自检

| 检查项 | 状态 |
|--------|:--:|
| 覆盖所有设计需求 | ✅ Task 模型、Cron、AI 工具、用户指令、润色配置、排队机制 |
| 无占位符 | ✅ 每步有具体代码 |
| 类型一致性 | ✅ Task 接口在 Task 1 定义，Task 5/6 引用一致 |
| 循环依赖处理 | ✅ Task 7 使用 `require()` 延迟导入 |
| 现有 set_timer 兼容 | ✅ 新参数可选，旧参数保留 |

---

## 附录：Oracle 审查修正项

实施时务必修正：

### 🔴 必须

1. **配置键访问错误**：`timerFires` 中用 `ConfigManager.memory.taskReminderPolish`（camelCase），非 `['任务提醒润色提示']`

2. **重启重复定时器**：`createAlarm` 用 `task.assignedTimerId` + `TimerManager.getTimers` 检查已有活跃定时器

3. **清理周期任务**：`cleanupExpired` 同时清理 `completed=true` 且 3 天前完成的周期任务

### 🟠 强烈建议

4. **截止更新重调度**：`updateTask` 改 deadline 时取消旧闹钟 + 创建新闹钟

5. **短 ID 提取**：`resolveTaskId()` 辅助函数，避免 update/delete 重复循环

6. **timer.ts 集成**：`content.startsWith('__TASK_')` 处提取 taskId 用 `slice(7, -2)`，含 require('./task') 延迟导入

### 🟡 可延后

7. **时区**：`parseDeadline` 用本地时区，假设 UTC+8

8. **计划噪音**：第 250-378 行为推导过程，以最终代码为准
