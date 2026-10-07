const express = require('express');
const { audioRelay } = require('../lib/audio-relay');
test('each display negotiates independently without sharing answers or ICE candidates', async () => {
  const app = express(); app.use(express.json()); audioRelay(app, (req, res, next) => next());
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (path, body = {}) => (await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  try {
    const a = await post('/api/audio/peers'), b = await post('/api/audio/peers');
    await post('/api/audio/peers/' + a.id, { offer: { type: 'offer', sdp: 'a' } });
    await post('/api/audio/peers/' + a.id, { answer: { type: 'answer', sdp: 'answer-a' }, role: 'receiver', candidate: { candidate: 'ice-a' } });
    const peers = await (await fetch(base + '/api/audio/peers')).json();
    expect(peers.find(p => p.id === a.id).answer.sdp).toBe('answer-a');
    expect(peers.find(p => p.id === b.id).answer).toBeNull();
    expect(peers.find(p => p.id === b.id).receiverIce).toEqual([]);
    await post('/api/audio/peers/' + a.id, { offer: { type: 'offer', sdp: 'new-publisher' } });
    const renewed = await (await fetch(base + '/api/audio/peers/' + a.id)).json();
    expect(renewed.answer).toBeNull(); expect(renewed.receiverIce).toEqual([]);
  } finally { await new Promise(r => server.close(r)); }
});
