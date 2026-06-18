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
  deadline?: string;
  period?: string;
  progress: number;
  completed: boolean;
  reminder: boolean;
  scope: 'private' | 'group';
  creatorId: string;
  assigneeId: string;
  groupId: string;
  createdAt: number;
  completedAt?: number; // 完成时间戳，用于清理逻辑
  assignedTimerId?: string;
}

export class TaskManager {
  static tasks: { [assigneeId: string]: Task[] } = {};

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
          this.tasks[uid][idx].completedAt = Math.floor(Date.now() / 1000);
          TimerManager.removeTimers('', `__TASK_${id}__`, ['target']);
          this.tasks[uid][idx].assignedTimerId = undefined;
        }
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
        TimerManager.removeTimers('', `__TASK_${id}__`, ['target']);
        this.tasks[uid].splice(idx, 1);
        this.save();
        return true;
      }
    }
    return false;
  }

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
        if (t.completed) {
          const completedTs = t.completedAt || t.createdAt; // fallback for old tasks
          return (now - completedTs) < 3 * 24 * 60 * 60;
        }
        if (t.type === 'deadline' && t.deadline) {
          const ts = parseDeadline(t.deadline);
          if (ts !== null && ts < threeDaysAgo) return false;
        }
        return true;
      });
    }
    this.save();
  }

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

    const existing = TimerManager.getTimers('', `__TASK_${task.id}__`, ['target']);
    if (existing.length > 0) return;

    const session = this.resolveSession(task);
    if (!session) return;

    TimerManager.addTargetTimer(session.ctx, session.ai, targetTs, `__TASK_${task.id}__`);
    task.assignedTimerId = `${targetTs}`;
    this.save();
    logger.info(`[TaskManager] 闹钟已创建: ${task.name} → ${fmtDate(targetTs, ConfigManager.message.utcOffset)}`);
  }

  static async timerFires(taskId: string): Promise<void> {
    const task = this.getTaskById(taskId);
    if (!task || task.completed) return;

    const session = this.resolveSession(task);
    if (!session) return;
    const { ctx, msg, ai } = session;

    const deadlineTs = task.deadline ? parseDeadline(task.deadline) : null;
    const remainingDays = deadlineTs ? Math.ceil((deadlineTs - Date.now() / 1000) / 86400) : 0;
    let template = `⏳ ${task.name} (进度: ${task.progress}%, 截止: ${task.deadline || '无'})`;
    if (remainingDays > 0) template += `\n剩余时间：${remainingDays}天`;
    if (task.scope === 'group' && task.assigneeId !== 'public') {
      template += `\n[CQ:at,qq=${task.assigneeId.replace(/^QQ:/, '')}]`;
    }

    const polishHint = ConfigManager.memory.taskReminderPolish || '用亲切自然的语气提醒用户';
    const systemMsg = `你是任务提醒助手。${polishHint}\n\n以下是一条任务提醒，请用自然语气转述：\n${template}`;

    await ai.context.addSystemUserMessage('任务提醒', systemMsg, []);
    ai.enqueueReminder(ctx, msg);

    task.assignedTimerId = undefined;
    if (task.type === 'periodic') this.createAlarm(task);
    this.save();
    logger.info(`[TaskManager] 闹钟触发: ${task.name}`);
  }

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
}

function parseDeadline(deadline: string): number | null {
  const match = deadline.match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/);
  if (!match) return null;
  const [, y, m, d, h = '0', min = '0'] = match;
  return new Date(+y, +m - 1, +d, +h, +min).getTime() / 1000;
}

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
