'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
function downloaderBinary() {
  const local = path.join(__dirname, '..', '.tools', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  return process.env.YTDLP_BIN || (fs.existsSync(local) ? local : 'yt-dlp');
}
async function downloadYouTube(videoId, cacheDir, { execFileImpl = execFile, timeoutMs = 90000 } = {}) {
  if (!/^[\w-]{11}$/.test(String(videoId))) return null;
  const root = path.resolve(cacheDir);
  const prefix = `yt-${videoId}-${crypto.randomUUID()}`;
  const args = ['--ignore-config', '--no-playlist', '--quiet', '--no-progress',
    '--js-runtimes', `node:${process.execPath}`, '--socket-timeout', '15', '--retries', '1',
    '--max-filesize', '80M', '-f', 'bestaudio[ext=m4a]/bestaudio', '--print', 'after_move:filepath',
    '-o', path.join(root, prefix + '.%(ext)s'), `https://www.youtube.com/watch?v=${videoId}`];
  try {
    const output = await new Promise((resolve, reject) => execFileImpl(downloaderBinary(), args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, shell: false },
      (error, stdout, stderr) => { if (error) { error.stderr = stderr; reject(error); } else resolve(stdout); }));
    const filepath = path.resolve(String(output).trim().split(/\r?\n/).at(-1));
    if (path.dirname(filepath) !== root || !path.basename(filepath).startsWith(prefix + '.')) throw new Error('Downloader returned an unexpected file path');
    if (!fs.existsSync(filepath) || fs.statSync(filepath).size < 1000) throw new Error('Downloader produced no valid audio file');
    return { filepath, size: fs.statSync(filepath).size };
  } catch (error) {
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith(prefix + '.') && fs.statSync(path.join(root, name)).isFile()) fs.unlinkSync(path.join(root, name));
    }
    if (error.code === 'ENOENT') return null;
    const reason = String(error.stderr || '').split(/\r?\n/).filter(line => /ERROR:/i.test(line)).join(' ').replace(/https?:\/\/\S+/g, '[upstream URL]').slice(0, 400);
    throw new Error(error.killed ? 'YouTube download timed out' : (reason || 'YouTube downloader failed; check server logs'));
  }
}
module.exports = { downloadYouTube, downloaderBinary };
