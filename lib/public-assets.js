const path = require('node:path');
const files = new Set([
  '/dj.html', '/display.html', '/nano.html', '/engine.js', '/audio-transitions.js', '/ui-resilience.js',
  '/sw.js', '/manifest.json', '/icon-192.png', '/icon-512.png',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon.svg',
  '/css/shared.css', '/css/console.css',
]);
function publicAssets(root) {
  return (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method) || !files.has(req.path)) return next();
    const asset = req.path.replace(/^\/icons\/(icon-\d+\.png)$/, '/$1');
    res.set('Cache-Control', asset === '/sw.js' || asset.endsWith('.html') ? 'no-store' : 'no-cache');
    res.sendFile(path.join(root, asset), err => { if (err) next(err); });
  };
}
module.exports = { publicAssets };
