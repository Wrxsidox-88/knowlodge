// 首屏"内容就绪"信号：刷新/访问页面时，加载层保留到当前页面关键数据加载完成才消失（期间页面在下层持续渲染）。
// 各视图在主要数据请求完成后调用 markBootReady()（幂等，多次调用无害）；无初始请求的视图立即调用。
let _resolve = null;
export const bootReady = new Promise((resolve) => {
  _resolve = resolve;
});

export function markBootReady() {
  if (_resolve) {
    const r = _resolve;
    _resolve = null;
    r();
  }
}
