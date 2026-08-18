// 快速诊断：启动服务器，测试 API，然后退出
import fetch from 'node-fetch';
import { spawn } from 'child_process';

console.log('启动服务器...');
const server = spawn('node', ['server/src/index.js'], {
  cwd: process.cwd(),
  stdio: 'inherit'
});

// 给服务器3秒启动
await new Promise(r => setTimeout(r, 3000));

console.log('\n测试健康检查...');
try {
  const res = await fetch('http://localhost:8787/api/health');
  const data = await res.json();
  console.log('✓ 健康检查通过:', data);
} catch (e) {
  console.error('✗ 健康检查失败:', e.message);
}

console.log('\n测试登录...');
try {
  const res = await fetch('http://localhost:8787/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test', password: 'test123' })
  });
  const data = await res.json();
  console.log('✓ 登录接口响应:', res.status, data);
} catch (e) {
  console.error('✗ 登录测试失败:', e.message);
}

console.log('\n诊断完成，关闭服务器...');
server.kill();
setTimeout(() => process.exit(0), 500);
