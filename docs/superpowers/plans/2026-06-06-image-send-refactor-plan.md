# Image Send & Steal Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace random-probability + prompt-inline image sending with a single `send_image` AI tool, and replace manual steal toggle with automatic emoji detection + probability-based storing.

**Architecture:** New `ImagePool` class (unified local+stolen image storage with search) replaces `ImageManager.stolenImages[]`. `ImageManager` delegates to `ImagePool` for storage. AI chooses images via `send_image(description)` tool; stealing is automatic on receive with visual model JSON detection.

**Tech Stack:** TypeScript, SeaDice JS plugin runtime, Qwen VL API (with `response_format: json_object`)

---

### Task 1: Create ImagePool

**Files:**
- Create: `src/AI/ImagePool.ts`

- [ ] **Step 1: Write ImagePool class**

```typescript
// src/AI/ImagePool.ts
import { ConfigManager } from '../config/configManager';
import { generateId, levenshteinDistance } from '../utils/utils';
import { Image } from './image';
import { logger } from '../logger';

export interface ImageEntry {
  id: string;
  file: string;
  description: string;
  source: 'local' | 'stolen';
  createdAt: number;
}

export class ImagePool {
  static validKeys: (keyof ImagePool)[] = ['images', 'maxStolen'];
  images: ImageEntry[];
  maxStolen: number;

  constructor() {
    this.images = [];
    this.maxStolen = 50;
  }

  add(entry: ImageEntry): void {
    this.images.push(entry);
    this.limit();
  }

  search(query: string): ImageEntry | null {
    if (!query.trim()) return null;
    const qTokens = this.tokenize(query);

    const scored = this.images
      .map(img => {
        let score = 0;
        const dTokens = this.tokenize(img.description);

        for (const qt of qTokens) {
          for (const dt of dTokens) {
            if (dt === qt) score += 3;
            else if (dt.includes(qt) || qt.includes(dt)) score += 2;
            else if (levenshteinDistance(dt, qt) <= 2) score += 1;
          }
        }

        if (img.source === 'stolen') {
          const ageHours = (Date.now() / 1000 - img.createdAt) / 3600;
          score += Math.max(0, 1 - ageHours / 72) * 0.5;
        }

        if (img.source === 'local') score += 0.5;

        return { img, score };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored[0]?.img || null;
  }

  remove(id: string): void {
    const idx = this.images.findIndex(img => img.id === id);
    if (idx !== -1) this.images.splice(idx, 1);
  }

  /** Load local images from config into pool */
  loadLocalImages(): void {
    const { localImagePathMap } = ConfigManager.image;
    for (const [name, path] of Object.entries(localImagePathMap)) {
      if (this.images.some(img => img.file === path && img.source === 'local')) continue;
      this.images.push({
        id: `local_${name}`,
        file: path,
        description: name,
        source: 'local',
        createdAt: 0
      });
    }
  }

  get stolenCount(): number {
    return this.images.filter(i => i.source === 'stolen').length;
  }

  get localCount(): number {
    return this.images.filter(i => i.source === 'local').length;
  }

  clear(type?: 'stolen' | 'local'): void {
    if (type) {
      this.images = this.images.filter(i => i.source !== type);
    } else {
      this.images = [];
    }
  }

  getStolenImageListText(page: number = 1): string {
    const stolen = this.images.filter(i => i.source === 'stolen');
    if (stolen.length === 0) return '';
    if (page > Math.ceil(stolen.length / 5)) page = Math.ceil(stolen.length / 5);
    return stolen.slice((page - 1) * 5, page * 5)
      .map((img, i) => `${i + 1 + (page - 1) * 5}. 描述:${img.description || '无'}\n[CQ:image,file=${img.file}]`)
      .join('\n') + `\n当前页码:${page}/${Math.ceil(stolen.length / 5)}`;
  }

  private limit(): void {
    this.maxStolen = ConfigManager.image.maxStolenImageNum;
    const stolen = this.images.filter(i => i.source === 'stolen');
    if (stolen.length <= this.maxStolen) return;
    stolen.sort((a, b) => a.createdAt - b.createdAt);
    const toRemove = stolen.slice(0, stolen.length - this.maxStolen);
    for (const r of toRemove) this.remove(r.id);
  }

  private tokenize(s: string): string[] {
    return s.split(/[\s,，。！？、；：""''（）\(\)\[\]{}]+/)
      .filter(t => t.length > 0 && t.length <= 10);
  }
}
```

- [ ] **Step 2: Verify build**

```bash
npm run build
```

Expected: build passes.

- [ ] **Step 3: Commit**

```bash
git add src/AI/ImagePool.ts
git commit -m "feat: add ImagePool - unified image storage with fuzzy search"
```

---

### Task 2: Update image config defaults

**Files:**
- Modify: `src/config/config_image.ts`

- [ ] **Step 1: Change defaults and update description**

```typescript
// Line 12 — change default from 0 to 10, update description string
seal.ext.registerIntConfig(ImageConfig.ext, "发送图片的概率/%", 10, "识别为表情包后存入图库的概率");
```

- [ ] **Step 2: Change default prompt to JSON output format**

```typescript
// Line 21 — change defaultPrompt to JSON format
seal.ext.registerStringConfig(ImageConfig.ext, "图片识别默认prompt",
  '分析这张图片，以JSON格式输出：text1为OCR识别原文（无则空字符串），text2为50字以内图片主要内容/动作和关键重点描述，isEmoji为是否表情包（true/false）。只输出JSON。',
  "");
```

- [ ] **Step 3: Add response_format to image body config or note it's handled in the request call**

No config change needed — `response_format: { type: 'json_object' }` will be added in the `sendITTRequest` call or the `imageToText` method.

- [ ] **Step 4: Remove unused imports/fields** (if any — `p` field still used but with new semantics)

- [ ] **Step 5: Verify build**

```bash
npm run build
```

Expected: build passes.

- [ ] **Step 6: Commit**

```bash
git add src/config/config_image.ts
git commit -m "feat: change image config defaults — steal probability 10, JSON recognition prompt"
```

---

### Task 3: Refactor ImageManager

**Files:**
- Modify: `src/AI/image.ts`

- [ ] **Step 1: Add ImagePool import and property to ImageManager**

```typescript
// At top of file, add import
import { ImagePool, ImageEntry } from './ImagePool';
```

Add `imagePool` property to `ImageManager` class:

```typescript
export class ImageManager {
  static validKeys: (keyof ImageManager)[] = ['imagePool'];  // was ['stolenImages', 'stealStatus']
  imagePool: ImagePool;  // new, replaces stolenImages + stealStatus
```

Remove old fields from class body:
- Delete `stolenImages: Image[];` (line 149)
- Delete `stealStatus: boolean;` (line 150)

- [ ] **Step 2: Update constructor**

```typescript
constructor() {
  this.imagePool = new ImagePool();
}
```

- [ ] **Step 3: Delete obsolete methods**

Remove these methods from ImageManager class:
- `getUserAvatar()` (lines 157-162) — move to static `Image` method or keep in class
- `getGroupAvatar()` (lines 164-169) — move to static
- `stealImages()` (lines 171-174)
- `drawStolenImage()` (lines 193-202)
- `getStolenImageListText()` (lines 204-212)
- `drawImage()` (lines 214-225)

Keep `getLocalImageListText()` (static) and `getUserAvatar`/`getGroupAvatar` (make static).

- [ ] **Step 4: Rewrite handleImageMessageSegment**

```typescript
async handleImageMessageSegment(ctx: seal.MsgContext, seg: MessageSegment): Promise<{ content: string, images: Image[] }> {
  const { receiveImage } = ConfigManager.image;
  if (!receiveImage || seg.type !== 'image') return { content: '', images: [] };

  let content = '';
  const images: Image[] = [];
  try {
    const file = seg.data.url || seg.data.file || '';
    if (!file) return { content: '', images: [] };

    const image = new Image();
    image.file = file;
    const { condition } = ConfigManager.image;
    const fmtCondition = parseInt(seal.format(ctx, `{${condition}}`));
    if (fmtCondition === 1) await image.imageToText();

    // Parse JSON result from imageToText (new JSON prompt)
    let text1 = '', text2 = image.content, isEmoji = false;
    if (image.content) {
      try {
        const parsed = JSON.parse(image.content);
        text1 = parsed.text1 || '';
        text2 = parsed.text2 || image.content;
        isEmoji = parsed.isEmoji === true;
      } catch {
        // Old format or non-JSON response: treat content as text2
        text2 = image.content;
      }
    }

    content += text2 ? `<|img:${image.id}:${text2}|>` : `<|img:${image.id}|>`;
    images.push(image);

    // Auto-steal: if emoji and probability hits → store in ImagePool
    if (isEmoji) {
      const { p } = ConfigManager.image;
      if (Math.random() * 100 < p) {
        this.imagePool.add({
          id: image.id,
          file: image.file,
          description: text2 || '表情包',
          source: 'stolen',
          createdAt: Math.floor(Date.now() / 1000)
        });
      }
    }
  } catch (error) {
    logger.error('在handleImageMessage中处理图片时出错:', error);
  }

  return { content, images };
}
```

- [ ] **Step 5: Update extractExistingImagesToSave — no changes needed** (still searches context for images by id, doesn't depend on stolenImages)

- [ ] **Step 6: Verify build**

```bash
npm run build
```

Expected: build passes. Check for any remaining references to `stealStatus`, `stolenImages`, `drawStolenImage`, `drawImage` in the codebase.

- [ ] **Step 7: Commit**

```bash
git add src/AI/image.ts
git commit -m "refactor: replace stolenImages/stealStatus with ImagePool, auto-steal on emoji detect"
```

---

### Task 4: Wire ImagePool into AI.ts

**Files:**
- Modify: `src/AI/AI.ts`

- [ ] **Step 1: Add import**

```typescript
// Add to existing imports
import { ImagePool } from './ImagePool';
```

- [ ] **Step 2: Add imagePool to validKeys**

```typescript
// Line 57 — add 'imagePool'
static validKeys: (keyof AI)[] = ['context', 'tool', 'memory', 'imageManager', 'imagePool', 'setting'];
```

- [ ] **Step 3: Initialize imagePool in constructor**

```typescript
// After line 76 (this.imageManager = new ImageManager();)
this.imagePool = new ImagePool();
```

- [ ] **Step 4: Remove random image sending from reply()**

Find the block at ~line 100-115 that does:
```typescript
const { p } = ConfigManager.image;
if (Math.random() * 100 < p) {
  const img = await this.imageManager.drawImage();
  if (img) {
    // ... send image
  }
}
```
Delete this entire block.

- [ ] **Step 5: Add old stolenImages migration in getAI revive**

In `AIManager.getAI()` (around line 287), update the `imageManager` revival:

```typescript
if (key === "imageManager") {
  const im = revive(ImageManager, value);
  // Migrate old stolenImages to ImagePool
  if (im.stolenImages && im.stolenImages.length > 0) {
    const pool = ai.imagePool || new ImagePool();
    for (const img of im.stolenImages) {
      if (img.file && img.id) {
        pool.add({
          id: img.id,
          file: img.file,
          description: img.content || '用户发送的图片',
          source: 'stolen',
          createdAt: Math.floor(Date.now() / 1000)
        });
      }
    }
    ai.imagePool = pool;
    im.stolenImages = [];
    im.stealStatus = false;
  }
  return im;
}
```

Wait — this is tricky because `ai` is not yet assigned when the reviver runs. The `JSON.parse` reviver callback processes the raw object tree, and `ai` is only available after parse completes. Instead, handle migration after JSON.parse:

After the `try { ai = JSON.parse(...) { ... } }` block (around line 296), add:

```typescript
// Migrate old stolenImages to ImagePool (one-time)
try {
  const rawData = ConfigManager.ext.storageGet(`AI_${id}`);
  if (rawData) {
    const raw = JSON.parse(rawData);
    if (raw.imageManager && raw.imageManager.stolenImages && raw.imageManager.stolenImages.length > 0) {
      if (!ai.imagePool) ai.imagePool = new ImagePool();
      for (const img of raw.imageManager.stolenImages) {
        if (img.file && img.id) {
          ai.imagePool.add({
            id: img.id,
            file: img.file,
            description: img.content || '用户发送的图片',
            source: 'stolen',
            createdAt: Math.floor(Date.now() / 1000)
          });
        }
      }
      // Clear migrated data so it doesn't re-migrate
      ai.imageManager.stolenImages = [];
      AIManager.saveAI(id);
    }
  }
} catch { /* migration is best-effort */ }
```

- [ ] **Step 6: Add imagePool revival in getAI JSON.parse**

```typescript
if (key === "imagePool") {
  return revive(ImagePool, value);
}
```

- [ ] **Step 7: Verify build**

```bash
npm run build
```

Expected: build passes.

- [ ] **Step 8: Commit**

```bash
git add src/AI/AI.ts
git commit -m "feat: wire ImagePool into AI, remove random image send, migrate old stolenImages"
```

---

### Task 5: Add send_image tool

**Files:**
- Modify: `src/tool/tool_image.ts`

- [ ] **Step 1: Add send_image tool registration**

After the `toolTTI` registration (before the closing `}` of `registerImage()`), add:

```typescript
const toolSendImage = new Tool({
    type: 'function',
    function: {
        name: 'send_image',
        description: '发送一张图片或表情包。根据描述从图库中匹配最合适的图片。当需要表达情绪、玩梗或配图时使用。',
        parameters: {
            type: 'object',
            properties: {
                description: {
                    type: 'string',
                    description: '图片描述，如"开心的猫"、"疑惑"、"拍桌大笑"'
                }
            },
            required: ['description']
        }
    }
});
toolSendImage.solve = async (ctx, msg, ai, args) => {
    const desc = args.description;
    if (!desc) return { content: '[send_image] 缺少描述参数', images: [] };

    // Load local images into pool (idempotent)
    ai.imagePool.loadLocalImages();

    const entry = ai.imagePool.search(desc);
    if (!entry) return { content: `[未找到匹配"${desc}"的图片]`, images: [] };

    // Validate stolen image URLs
    if (entry.source === 'stolen') {
        const img = new Image();
        img.file = entry.file;
        if (!await img.checkImageUrl()) {
            ai.imagePool.remove(entry.id);
            // Retry once
            const retry = ai.imagePool.search(desc);
            if (retry) {
                seal.replyToSender(ctx, msg, `[CQ:image,file=${retry.file}]`);
                return { content: '', images: [] };
            }
            return { content: `[匹配的图片链接已过期]`, images: [] };
        }
    }

    seal.replyToSender(ctx, msg, `[CQ:image,file=${entry.file}]`);
    return { content: '', images: [] };
};
```

- [ ] **Step 2: Add Image import at top**

```typescript
import { Image } from '../AI/image';
```

(Already exists at line 2)

- [ ] **Step 3: Verify build**

```bash
npm run build
```

Expected: build passes.

- [ ] **Step 4: Commit**

```bash
git add src/tool/tool_image.ts
git commit -m "feat: add send_image tool for AI-driven image sending"
```

---

### Task 6: Clean system prompt

**Files:**
- Modify: `src/config/config_message.ts` (lines 43-55)
- Modify: `src/utils/utils_message.ts` (lines 14-16, 57-60)

- [ ] **Step 1: Remove <|img:xxx|> sections from system message template**

In `config_message.ts`, replace the entire "## 图片相关" section (lines 43-55) with:

```
{{#if 接收图片}}
    - 对话中的 <|img:xxxxxx:yyy|> 表示用户发送了图片，xxxxxx为图片id，yyy为AI生成的图片描述。可使用 send_image 函数发送表情包。
{{/if}}
```

- [ ] **Step 2: Remove sandableImagesPrompt from buildSystemMessage**

In `utils_message.ts`, delete lines 13-16:
```typescript
// Remove:
const { localImagePathMap, receiveImage, condition } = ConfigManager.image;
```
Change to:
```typescript
const { receiveImage, condition } = ConfigManager.image;
```

Remove line 14-16 (sandableImagesPrompt construction):
```typescript
const sandableImagesPrompt: string = Object.keys(localImagePathMap)
    .map((id, index) => `${index + 1}. ${id}`)
    .join('\n');
```

In the template data object (around lines 56-60), remove:
```typescript
"可发送图片不为空": sandableImagesPrompt,
"可发送图片列表": sandableImagesPrompt,
```

- [ ] **Step 3: Verify build**

```bash
npm run build
```

Expected: build passes.

- [ ] **Step 4: Commit**

```bash
git add src/config/config_message.ts src/utils/utils_message.ts
git commit -m "feat: remove <|img:xxx|> from system prompt, use send_image tool"
```

---

### Task 7: Remove <|img|> from handleReply

**Files:**
- Modify: `src/utils/utils_string.ts` (lines 267-278)

- [ ] **Step 1: Remove img parsing from transformContentToText**

Delete the `case 'img':` block (lines 267-278):
```typescript
case 'img': {
    const id = seg.content;
    const image = await ai.context.findImage(ctx, id);

    if (image) {
        images.push(image);
        text += image.CQCode;
    } else {
        logger.warning(`无法找到图片：${id}`);
    }
    break;
}
```

- [ ] **Step 2: Verify no remaining img references in handleReply path**

```bash
npm run build
```

Check for any compile errors. The `parseSpecialTokens` function itself can still parse img tokens (used by context display), but handleReply no longer converts them.

- [ ] **Step 3: Commit**

```bash
git add src/utils/utils_string.ts
git commit -m "feat: remove <|img|> parsing from handleReply (replaced by send_image tool)"
```

---

### Task 8: Update .img steal commands

**Files:**
- Modify: `src/cmd/sub_cmd/image.ts`

- [ ] **Step 1: Rewrite .img stl commands**

Replace the `case 'steal':` block (lines 53-78):

```typescript
case 'steal': {
    const op = cmdArgs.getArgN(3);
    switch (aliasToCmd(op)) {
        case 'forget': {
            ai.imagePool.clear('stolen');
            seal.replyToSender(ctx, msg, '偷取图片已清空');
            AIManager.saveAI(sid);
            return ret;
        }
        default: {
            seal.replyToSender(ctx, msg, `图片池状态: 偷取图${ai.imagePool.stolenCount}张, 本地图${ai.imagePool.localCount}张\n【.ai img stl f】清空偷取图片`);
            return ret;
        }
    }
}
```

Remove `on` and `off` cases (steal is automatic now). Keep `forget` (clear stolen).

- [ ] **Step 2: Update .img list steal**

Replace line 40:
```typescript
seal.replyToSender(ctx, msg, ai.imageManager.getStolenImageListText(page) || '暂无偷取图片');
```
With:
```typescript
seal.replyToSender(ctx, msg, ai.imagePool.getStolenImageListText(page) || '暂无偷取图片');
```

- [ ] **Step 3: Update help text**

In the default case (line 106), update:
```
【.ai img stl [f]】管理偷取图片（f=清空）
```

- [ ] **Step 4: Verify build**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/cmd/sub_cmd/image.ts
git commit -m "refactor: update .img steal commands for ImagePool (remove on/off, keep forget)"
```

---

### Task 9: Add response_format to image requests

**Files:**
- Modify: `src/AI/image.ts` (imageToText method)
- Modify: `src/service/legacy.ts` (sendITTRequest function)

- [ ] **Step 1: Check sendITTRequest signature**

```typescript
// In legacy.ts, sendITTRequest currently takes messages array and calls fetchData
// We need to add response_format: { type: 'json_object' } to the body
```

Read current `sendITTRequest`:
```typescript
export async function sendITTRequest(messages: any[]): Promise<string> {
    const { url, apiKey, bodyTemplate } = ConfigManager.image;
    // ... builds bodyObject from template, sends to url
}
```

Add `response_format` to the body:
```typescript
bodyObject.response_format = { type: "json_object" };
```

This is safe for Qwen VL (confirmed supports it), OpenAI, and most compatible APIs. Pre-V5 models that don't support it will ignore the field.

- [ ] **Step 2: Verify build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/service/legacy.ts
git commit -m "feat: add response_format json_object to ITT requests for emoji detection"
```

---

### Task 10: Final verification

- [ ] **Step 1: Search for stale references**

```bash
rg "stealStatus|stolenImages|drawStolenImage|drawImage" src/
```

Expected: no results (except in migration code or ImagePool internal methods).

```bash
rg "<\|img:" src/config/ src/utils/utils_message.ts
```

Expected: only in system prompt's description of received image format, not in "可发送图片" context.

- [ ] **Step 2: Full build**

```bash
npm run build
```

Expected: build passes with no errors.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: final cleanup of image refactor, verify no stale references"
```
