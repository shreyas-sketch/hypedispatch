// pm2 start ecosystem.config.cjs  → keeps Hype Dispatch running and restarts it if it crashes
module.exports = {
  apps: [{
    name: 'hype-dispatch',
    script: 'src/index.js',
    cwd: __dirname,
    autorestart: true,
    max_restarts: 50,
    restart_delay: 5000,
    time: true,
  }],
};
