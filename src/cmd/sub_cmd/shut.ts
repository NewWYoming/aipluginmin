import { U } from "../privilege";
import { SubCmd, SubCmdContext } from "../root";

export function registerCmdShut() {
    const cmd = new SubCmd('shut');
    cmd.desc = '打断当前对话';
    cmd.help = '';
    cmd.priv = { priv: U };
    cmd.solve = async (scc: SubCmdContext) => {
        const { ctx, msg, ret } = scc;

        seal.replyToSender(ctx, msg, '当前版本不支持流式输出');
        return ret;
    }
}