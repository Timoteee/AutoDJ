import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const express = require('express');
const multer = require('multer');
it('Multer 2 handles multipart uploads and rejects oversized files', async () => {
  const app = express();
  app.post('/upload', multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 } }).array('files', 100),
    (req, res) => res.json({ names: req.files.map(file => file.originalname) }));
  app.use((error, req, res, next) => res.status(400).json({ code: error.code }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/upload`;
    const form = new FormData();
    form.append('files', new Blob(['audio fixture']), 'test.mp3');
    const response = await fetch(url, { method: 'POST', body: form });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ names: ['test.mp3'] });
    const oversized = new FormData();
    oversized.append('files', new Blob(['x'.repeat(17)]), 'large.mp3');
    const rejected = await fetch(url, { method: 'POST', body: oversized });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ code: 'LIMIT_FILE_SIZE' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
