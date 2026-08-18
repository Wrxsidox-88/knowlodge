import('./server/src/index.js').catch(e => {
  console.error('启动错误:', e);
  process.exit(1);
});

setTimeout(() => {
  console.log('启动超时 - 可能在等待什么...');
  process.exit(1);
}, 3000);
