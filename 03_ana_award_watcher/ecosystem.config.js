module.exports = {
  apps: [
    {
      name: 'ana-award-watcher',
      cwd: __dirname,
      script: 'src/scheduler.js',
      instances: 1,
      autorestart: true,
      restart_delay: 30000,
      max_restarts: 20,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
