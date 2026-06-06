# 图片发送与偷图机制重构

## 目标

将 AI 发图从"随机概率 + 提示词内嵌语法"重构为"AI 自主 Tool 调用"，同时修复偷图链路的问题。

## 问题分析

### 旧系统问题

1. **AI 发图非自主**：`p%` 随机概率发图 + system prompt 中 `<|img:xxx|>` 语法，两条路径混杂
2. **偷图偷不到**：
   - `p` 默认 0（从不发图）
   - `stealStatus` 默认 false（从不存图）
   - `receiveImage=false` 时偷图也废掉（耦合）
3. **偷来的图无描述**：AI 不知道每张图是什么内容，无法定向选择
4. **system prompt 臃肿**：`<|img:xxx|>` 语法说明约 200 字
5. **偷图一次性**：`drawStolenImage()` 用 splice 取出后不再可用

### 设计原则

- **一条路径**：AI 只用 `send_image(description)` 一个 tool 发图
- **自动偷图**：收图时自动识图 → 存描述 → 概率入池，无需手动开关
- **统一池**：本地图片和偷取图片合并在 ImagePool，AI 无感知来源差异
- **最小侵入**：复用现有视觉模型和识图链路

## 架构

```
收图（链路 A — 不变逻辑，改存图目标）:
  用户发图 → receiveImage=true → condition 满足？
    → 视觉模型识别（JSON 输出）
      → { text1: OCR原文, text2: 50字描述, isEmoji: bool }
    → text1 + text2 → 存入上下文（和前一样）
    → isEmoji=true && 概率命中？→ ImagePool.add({ file, description: text2 })

发图（链路 B — 删除随机，新增 tool）:
  AI 调用 send_image({ description: "开心的猫" })
    → ImagePool.search("开心的猫")
      → 关键词匹配（Levenshtein + 分词重叠）
      → 偷取图新近度加分、本地图基础分
    → 偷取图：HEAD 请求验证链接 → 有效则发送，过期则移除 + 重试
    → 发送 [CQ:image,file=...]
```

## 组件

### 新建：`src/AI/ImagePool.ts`

统一图片池，替代 `ImageManager.stolenImages[]`。

```typescript
interface ImageEntry {
  id: string;
  file: string;          // URL 或本地路径
  description: string;   // AI 识图结果（text2）或文件名
  source: 'local' | 'stolen';
  createdAt: number;     // Unix timestamp
}

class ImagePool {
  images: ImageEntry[];
  maxStolen: number;

  add(entry: ImageEntry): void;       // 添加图片，超出上限淘汰最旧偷取图
  search(query: string): ImageEntry | null;  // 查询前过滤过期偷取图
  remove(id: string): void;
}
```

**持久化**：挂在 AI 实例下，`AI.validKeys` 包含 `imagePool`。`ImagePool.validKeys = ['images', 'maxStolen']`。

### 修改：`src/AI/image.ts`

**Image 类**：不变。

**ImageManager 类**：

| 保留 | 删除 |
|------|------|
| `stolenImages` → 迁移到 ImagePool | `stealStatus` |
| `getUserAvatar()`, `getGroupAvatar()` | `drawImage()`, `drawStolenImage()` |
| `getLocalImageListText()` | `getStolenImageListText()` |
| `handleImageMessageSegment()` | `stealImages()` |

`handleImageMessageSegment()` 改为：识图完成后，若 `isEmoji=true` 且概率命中，调用 `ImagePool.add()`。

### 修改：`src/tool/tool_image.ts`

新增 tool：

```typescript
{
  name: 'send_image',
  description: '发送一张图片/表情包。根据描述匹配图库中最合适的图片。当需要表达情绪、玩梗或配图时使用。',
  parameters: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: '图片描述，如"开心的猫"、"疑惑"、"拍桌大笑"'
      }
    },
    required: ['description']
  },
  solve: async (ctx, msg, ai, args) => {
    const entry = ai.imagePool.search(args.description);
    if (!entry) return '[未找到匹配图片]';

    // 偷取图验证链接
    if (entry.source === 'stolen') {
      const img = new Image(); img.file = entry.file;
      if (!await img.checkImageUrl()) {
        ai.imagePool.remove(entry.id);
        return '[图片链接已过期，已清理]';
      }
    }

    seal.replyToSender(ctx, msg, `[CQ:image,file=${entry.file}]`);
    return '';  // 不发描述文本
  }
}
```

保留 `image_to_text` 和 `text_to_image` 不变。

### 修改：`src/config/config_image.ts`

| 配置 key | 变更 | 新默认 |
|----------|------|--------|
| `发送图片的概率/%` | 改为**表情包存图概率**（旧 p% 无意义后复用） | 10 |
| `图片识别默认prompt` | 改为 JSON 结构化输出 prompt | 见下 |

新增识图 prompt：
```
分析这张图片，以JSON格式输出：text1为OCR识别原文（无则空字符串），text2为50字以内图片主要内容/动作和关键重点描述，isEmoji为是否表情包（true/false）。只输出JSON。
```

视觉模型 API 调用加 `response_format: { type: "json_object" }`（Qwen VL 支持）。

### 修改：`src/AI/AI.ts`

- `validKeys` 新增 `'imagePool'`
- 移除 `reply()` 中随机发图逻辑（p% + drawImage）
- `revive` 中新增 `imagePool` 反序列化 + 旧 `stolenImages` 迁移逻辑

### 修改：系统提示词模板

删除 `<|img:xxx|>` 语法说明（约 200 字）。

新增 1 行：
```
你可以通过调用 send_image 函数来发送表情包或图片，传入想要的图片描述即可，如"开心的猫"。
```

### 修改：`src/utils/utils_string.ts`

- `handleReply()` 中移除 `<|img:xxx|>` 解析
- `transformArrayToContent()` 不变（仍调 `handleImageMessageSegment`）

## 数据迁移

### 旧 stolenImages → 新 ImagePool

`AI.revive` 时检测 `imageManager` 中是否存在旧 `stolenImages` 数组：

```typescript
if (imageManager.stolenImages && imageManager.stolenImages.length > 0) {
  for (const img of imageManager.stolenImages) {
    this.imagePool.add({
      id: img.id,
      file: img.file,
      description: img.content || '用户发送的图片',
      source: 'stolen',
      createdAt: Date.now() / 1000
    });
  }
  imageManager.stolenImages = [];
}
```

迁移后清空 `stolenImages`，下次保存时不再写入旧字段。

### 配置迁移

`发送图片的概率/%` 旧默认值 0 → 新默认值 10。用户如果之前手动设过值，保留不变。语义从"随机发图概率"变为"表情包存图概率"。

## 命令影响

| 命令 | 变更 |
|------|------|
| `.img stl on/off` | 移除（无需手动开关） |
| `.img stl` | 改为显示 ImagePool 图片数量 |
| `.img draw` | 保留（手动调试发图） |
| `.img itt` | 保留（手动识图） |
| `.img f` | 保留（清空偷取图 → 清空 ImagePool 中 source=stolen 的图） |

## 自检清单

- [ ] 无 TBD/TODO
- [ ] send_image tool 不依赖外部插件
- [ ] 本地图片自动加入 ImagePool（配置加载时）
- [ ] 偷取图链接过期自动清理 + 重试
- [ ] 旧数据迁移覆盖所有持久化 AI 实例
- [ ] system prompt 瘦身，<|img:xxx|> 语法彻底移除
