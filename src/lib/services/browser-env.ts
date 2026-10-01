/**
 * 运行时浏览器能力检测。
 * 真实 SvelteKit SSR 下 window 不存在，返回 false；浏览器内返回 true。
 * 不使用 $app/environment 的 browser 常量，便于在 jsdom / SSR 测试容器中验证本地持久化流程。
 */
export function canUseBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}
