module.exports = {
  apps: [
    {
      name: 'tldraw',
      script: 'src/server/server.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx/esm',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: 5858,
      },
      // 崩溃后自动重启
      autorestart: true,
      // 最多重试 10 次，超过则停止（防止无限崩溃循环）
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
