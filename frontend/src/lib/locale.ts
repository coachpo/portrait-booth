/**
 * UI 语言键（O4）：模板 label 的语言键，不是 BCP-47 标签。
 * 当前只有 zh 一种文案（index.html lang="zh-CN"），未来加语言时改这里。
 * 做成函数而非导出常量，便于测试 vi.mock 覆盖。
 */
export function uiLocale(): string {
  return "zh";
}
