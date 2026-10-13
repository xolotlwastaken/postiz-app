module.exports = {
  apps: [
    { name: 'publishing-api', cwd: '/app/apps/backend', script: 'dist/apps/backend/src/main.js', node_args: '--experimental-require-module' },
    { name: 'publishing-worker', cwd: '/app/apps/orchestrator', script: 'dist/apps/orchestrator/src/main.js', node_args: '--experimental-require-module' },
    { name: 'publishing-gateway', script: '/usr/sbin/nginx', args: '-g "daemon off;"', interpreter: 'none' },
  ],
};
