// 无头 Chrome + CDP 探针:打开考试页日期选择,读取日历首屏日期
import { spawn } from 'node:child_process';

const CHROME = '/bin/google-chrome';
const PORT = 9333;
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--disable-crash-reporter', '--disable-breakpad', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=/tmp/cal-probe-profile', 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WS = (url) => new Promise((resolve, reject) => {
  const w = new WebSocket(url);
  w.onopen = () => resolve(w);
  w.onerror = (e) => reject(new Error('ws error ' + e.message));
});

async function main() {
  // 等待调试端口
  let target = null;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* retry */ }
    await sleep(300);
  }
  if (!target) throw new Error('chrome debug target not found');

  const ws = await WS(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval error: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');

  // 登录并注入 token
  await send('Page.navigate', { url: 'http://127.0.0.1:2032/' });
  await sleep(2500);
  const login = await evaluate(`(async () => {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
    const j = await r.json();
    if (!j.token) return { fail: j };
    localStorage.setItem('kl_token', j.token);
    return { ok: true };
  })()`);
  console.log('login:', JSON.stringify(login));

  await send('Page.navigate', { url: 'http://127.0.0.1:2032/exams' });
  await sleep(3000);

  // 找日期选择按钮:考试登记卡片内的 .calendar-date-picker-button
  const btnInfo = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.calendar-date-picker-button')];
    return btns.map((b, i) => ({ i, visible: !!b.offsetParent, text: b.textContent.trim() }));
  })()`);
  console.log('date picker buttons:', JSON.stringify(btnInfo));

  const clicked = await evaluate(`(() => {
    const b = [...document.querySelectorAll('.calendar-date-picker-button')].find((x) => x.offsetParent);
    if (!b) return false;
    b.click();
    return true;
  })()`);
  console.log('clicked:', clicked);
  await sleep(1800);

  // 读取日历 flyout:label(月年) + 前 14 个可见日期按钮文本
  const cal = await evaluate(`(() => {
    const fly = document.querySelector('.picker-flyout');
    if (!fly) return { err: 'no flyout' };
    const label = fly.querySelector('.calendar-title-btn span')?.textContent || '';
    const scroll = fly.querySelector('.calendar-scroll');
    const days = [...fly.querySelectorAll('.calendar-day')].slice(0, 16).map((d) => d.querySelector('.day-text')?.textContent || d.textContent);
    return { label, firstDays: days, scrollH: scroll?.scrollHeight, clientH: scroll?.clientHeight, scrollTop: scroll?.scrollTop, winH: fly.offsetHeight };
  })()`);
  console.log('calendar:', JSON.stringify(cal, null, 1));

  // 再滚轮滚动测试
  const scrolled = await evaluate(`(() => {
    const fly = document.querySelector('.picker-flyout');
    const scroll = fly.querySelector('.calendar-scroll');
    scroll.scrollTop = 0; // 回到顶
    const ev = new WheelEvent('wheel', { deltaY: 120 * thisDictValue, bubbles: true, cancelable: true });
    scroll.dispatchEvent(ev);
    return { top: scroll.scrollTop };
  })()`).catch((e) => ({ err: e.message }));
  console.log('wheel test:', JSON.stringify(scrolled));
  await sleep(800);
  const after = await evaluate(`(() => {
    const fly = document.querySelector('.picker-flyout');
    const scroll = fly.querySelector('.calendar-scroll');
    const label = fly.querySelector('.calendar-title-btn span')?.textContent || '';
    return { top: scroll.scrollTop, label };
  })()`);
  console.log('after wheel:', JSON.stringify(after));

  ws.close();
  chrome.kill();
}
main().catch((e) => { console.error('PROBE FAIL:', e.message); chrome.kill(); process.exit(1); });