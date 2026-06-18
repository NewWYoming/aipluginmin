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
