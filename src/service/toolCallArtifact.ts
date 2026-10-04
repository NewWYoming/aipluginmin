/**
 * Detect tool-call protocol text that a model emitted as ordinary content.
 * Keep this deliberately conservative: only protocol-shaped markers count.
 */
export function isToolCallArtifact(content: string): boolean {
  const text = String(content || '').trim();
  if (!text) return false;

  return /(?:<\/?tool[_ -]?call\b|<\|(?:tool[_ -]?call|recipient|call)\|>|<function(?:=|\b)|recipient\s*=\s*(?:functions?\.)?|to\s*=\s*(?:functions?\.)?|\bdsml(?:\s|[|｜│]){0,8}(?:calls?|invoke|parameter)\b)/i.test(text);
}
