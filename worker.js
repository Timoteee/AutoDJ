// Usage: node worker.js --port=3001 --cacheDir=./cache

const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const app = express();
app.use(express.json());

// Config from CLI args
const PORT = parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '3001');
const CACHE_DIR = path.resolve(process.argv.find(a => a.startsWith('--cacheDir='))?.split('=')[1] || './cache');
const PROXY_FILE = path.resolve(process.argv.find(a => a.startsWith('--proxyFile='))?.split('=')[1] || './proxies.json');

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Active jobs
const activeJobs = new Map();

// Proxy pool (loaded from file)
let proxyPool = [];
let proxyIndex = 0;
function loadProxies() {
  try {
    if (fs.existsSync(PROXY_FILE)) {
      proxyPool = JSON.parse(fs.readFileSync(PROXY_FILE, 'utf8'));
      proxyIndex = 0;
    }
  } catch (e) { console.error('[Worker] Proxy load error:', e.message); }
}
loadProxies();
// Watch for changes
fs.watchFile(PROXY_FILE, { interval: 5000 }, loadProxies);

function getNextProxy() {
  if (proxyPool.length === 0) return '';
  const p = proxyPool[proxyIndex % proxyPool.length];
  proxyIndex++;
  return p.url || p;
}

// POST /worker/download - Start a download job
// Body: { jobId, videoId, url, proxy?, format?, callback }
app.post('/worker/download', (req, res) => {
  const { jobId, videoId, url, callback } = req.body;
  if (!jobId || !videoId || !url) return res.status(400).json({ error: 'Missing required fields' });

  const proxy = req.body.proxy || getNextProxy();
  const format = req.body.format || 'mp3';
  
  // Start yt-dlp
  const args = [
    '--extract-audio',
    '--audio-format', format,
    '--audio-quality', '0',
    '--output', path.join(CACHE_DIR, `${videoId}.%(ext)s`),
    '--no-playlist',
    '--geo-bypass',
    '--socket-timeout', '30',
    '--retries', '3',
    '--fragment-retries', '3',
    '--no-warnings',
    '--print', 'filename',
    '--print', 'duration_string',
  ];
  
  if (proxy) {
    args.push('--proxy', proxy);
  }
  
  args.push(url);

  const startTime = Date.now();
  const proc = spawn('yt-dlp', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300000 // 5 min
  });

  let stdout = '';
  let stderr = '';

  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  activeJobs.set(jobId, { proc, videoId, url, callback, startTime });

  proc.on('close', async (code) => {
    const duration = Date.now() - startTime;
    activeJobs.delete(jobId);

    if (code === 0) {
      // Parse output: last line is filename, second-to-last is duration
      const lines = stdout.trim().split('\n').filter(Boolean);
      const filepath = lines[lines.length - 2]?.trim();
      const durationStr = lines[lines.length - 1]?.trim();
      
      let fileSize = 0;
      let actualPath = filepath;
      
      // If filepath not in output, find it in cache dir
      if (!actualPath || !fs.existsSync(actualPath)) {
        const files = fs.readdirSync(CACHE_DIR);
        const match = files.find(f => f.startsWith(videoId));
        if (match) actualPath = path.join(CACHE_DIR, match);
      }
      
      try { fileSize = actualPath ? fs.statSync(actualPath).size : 0; } catch (e) {}

      const result = {
        jobId,
        videoId,
        status: 'completed',
        filepath: actualPath || '',
        size: fileSize,
        duration: durationStr || '',
        elapsed: duration
      };

      // Send callback
      if (callback) {
        try { await fetch(callback, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) }); }
        catch (e) { console.error('[Worker] Callback failed:', e.message); }
      }
      
      console.log(`[Worker] OK ${videoId} (${(fileSize/1048576).toFixed(1)}MB, ${durationStr || '?'}, ${duration}ms)`);
    } else {
      const result = {
        jobId,
        videoId,
        status: 'failed',
        error: stderr.slice(0, 500),
        elapsed: duration
      };

      if (callback) {
        try { await fetch(callback, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) }); }
        catch (e) { console.error('[Worker] Callback failed:', e.message); }
      }
      
      console.error(`[Worker] FAIL ${videoId}: ${stderr.slice(0, 200)}`);
    }
  });

  proc.on('error', async (err) => {
    activeJobs.delete(jobId);
    const result = { jobId, videoId, status: 'failed', error: err.message };
    if (callback) {
      try { await fetch(callback, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) }); }
      catch (e) { console.error('[Worker] Callback failed:', e.message); }
    }
  });

  res.json({ ok: true, jobId, status: 'started' });
});

// GET /worker/status - Check worker status
app.get('/worker/status', (req, res) => {
  res.json({
    uptime: process.uptime(),
    activeJobs: activeJobs.size,
    jobs: Array.from(activeJobs.entries()).map(([id, j]) => ({
      jobId: id,
      videoId: j.videoId,
      url: j.url,
      running: j.proc.exitCode === null,
      elapsed: Date.now() - j.startTime
    })),
    proxyCount: proxyPool.length,
    cacheDir: CACHE_DIR,
    cacheFiles: fs.readdirSync(CACHE_DIR).length
  });
});

// GET /worker/jobs/:jobId - Check specific job
app.get('/worker/jobs/:jobId', (req, res) => {
  const job = activeJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    jobId: req.params.jobId,
    videoId: job.videoId,
    url: job.url,
    running: job.proc.exitCode === null,
    elapsed: Date.now() - job.startTime
  });
});

// POST /worker/cancel/:jobId - Cancel a job
app.post('/worker/cancel/:jobId', (req, res) => {
  const job = activeJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.proc.kill('SIGTERM');
  activeJobs.delete(req.params.jobId);
  res.json({ ok: true });
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true, worker: true }));

// Check yt-dlp is available on startup
function checkYtdlp() {
  try {
    const v = execSync('yt-dlp --version', { encoding: 'utf8', timeout: 5000 }).trim();
    console.log(`[Worker] yt-dlp ${v} ready`);
    return true;
  } catch (e) {
    console.error('[Worker] yt-dlp not found! Install it: npm install -g yt-dlp or apt install yt-dlp');
    console.error('[Worker] Falling back to in-process download only');
    return false;
  }
}

const hasYtdlp = checkYtdlp();
app.listen(PORT, () => {
  console.log(`[Worker] AutoDJ yt-dlp Worker v1 on port ${PORT}`);
  console.log(`[Worker] Cache: ${CACHE_DIR}`);
  console.log(`[Worker] Proxies: ${proxyPool.length} loaded`);
  console.log(`[Worker] yt-dlp: ${hasYtdlp ? '✓ available' : '✗ NOT found (in-process fallback only)'}`);
});