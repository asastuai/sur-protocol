module.exports = {
  apps: [
    {
      name: 'aster-swing',
      script: 'index.ts',
      interpreter: 'C:\\Users\\Juan\\AppData\\Local\\bun\\bun.exe',
      interpreter_args: 'run',
      args: '--engine=swing --live --symbol=BTCUSDT',
      cwd: 'C:\\Users\\Juan\\Desktop\\workflow\\aster-bot',
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 50,
      min_uptime: '10s',
      out_file: 'C:\\Users\\Juan\\Desktop\\workflow\\aster-bot\\logs\\swing-out.log',
      error_file: 'C:\\Users\\Juan\\Desktop\\workflow\\aster-bot\\logs\\swing-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: { NODE_ENV: 'production' }
    },
    {
      name: 'aster-bot',
      script: 'index.ts',
      interpreter: 'C:\\Users\\Juan\\AppData\\Local\\bun\\bun.exe',
      interpreter_args: 'run',
      args: '--engine=scalp --live --symbol=BTCUSDT --verbose',
      cwd: 'C:\\Users\\Juan\\Desktop\\workflow\\aster-bot',
      watch: false,
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 50,
      min_uptime: '10s',
      out_file: 'C:\\Users\\Juan\\Desktop\\workflow\\aster-bot\\logs\\pm2-out.log',
      error_file: 'C:\\Users\\Juan\\Desktop\\workflow\\aster-bot\\logs\\pm2-err.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      env: { NODE_ENV: 'production' }
    }
  ]
};
