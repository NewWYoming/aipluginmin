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
