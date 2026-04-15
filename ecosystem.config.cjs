module.exports = {
  apps: [
    {
      name: 'tldraw',
      // Same as npm run start (NODE_ENV=production tsx src/server/server.ts)
      script: 'npm',
      args: 'run start',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
}
