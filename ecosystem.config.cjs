module.exports = {
  apps: [
    {
      name: 'tldraw',
      // 直接复用 npm run start（= NODE_ENV=production tsx src/server/server.ts）
      script: 'npm',
      args: 'run start',
      cwd: __dirname,
      // 崩溃后自动重启
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      // 日志
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
}
