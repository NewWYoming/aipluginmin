import { ConfigManager } from '../config/configManager';
import { levenshteinDistance } from '../utils/utils';
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
    // Avoid duplicate entries by file
    if (this.images.some(img => img.file === entry.file && img.source === entry.source)) {
      logger.info('ImagePool.add 重复跳过: ' + entry.file.slice(0, 60) + '...');
      return;
    }
    this.images.push(entry);
    logger.info('ImagePool.add 已插入: ' + entry.description.slice(0, 40) + ' | 池中共' + this.images.length + '张(stolen:' + this.stolenCount + ', local:' + this.localCount + ') | 上限' + ConfigManager.image.maxStolenImageNum);
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

  loadLocalImages(): void {
    const { localImagePathMap } = ConfigManager.image;
    for (const [name, path] of Object.entries(localImagePathMap)) {
      if (this.images.some(img => img.file === path && img.source === 'local')) continue;
      this.images.push({
        id: 'local_' + name,
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
      .map((img, i) => (i + 1 + (page - 1) * 5) + '. 描述:' + (img.description || '无') + '\n[CQ:image,file=' + img.file + ']')
      .join('\n') + '\n当前页码:' + page + '/' + Math.ceil(stolen.length / 5);
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
