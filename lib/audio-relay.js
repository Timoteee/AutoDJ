const { randomUUID } = require('node:crypto');
function audioRelay(app, auth) {
  const peers = new Map();
  const prune = () => { for (const [id, peer] of peers) if (Date.now() - peer.seen > 60000) peers.delete(id); };
  app.post('/api/audio/peers', auth, (req, res) => {
    prune(); if (peers.size >= 16) return res.status(429).json({ error: 'Listener limit reached' });
    const id = randomUUID(); peers.set(id, { id, seen: Date.now(), offer: null, answer: null, senderIce: [], receiverIce: [] }); res.json({ id });
  });
  app.get('/api/audio/peers', auth, (req, res) => { prune(); res.json([...peers.values()]); });
  app.get('/api/audio/peers/:id', auth, (req, res) => {
    prune(); const peer = peers.get(req.params.id); if (!peer) return res.status(404).json({ error: 'Reconnect listener' });
    peer.seen = Date.now(); res.json(peer);
  });
  app.post('/api/audio/peers/:id', auth, (req, res) => {
    const peer = peers.get(req.params.id); if (!peer) return res.status(404).json({ error: 'Reconnect listener' });
    const b = req.body || {};
    if (b.offer?.type === 'offer' && typeof b.offer.sdp === 'string') { peer.offer = b.offer; peer.answer = null; peer.senderIce = []; peer.receiverIce = []; }
    if (b.answer?.type === 'answer' && typeof b.answer.sdp === 'string') peer.answer = b.answer;
    if (b.candidate?.candidate && ['sender', 'receiver'].includes(b.role)) {
      const list = b.role === 'sender' ? peer.senderIce : peer.receiverIce;
      if (list.length < 64) list.push(b.candidate);
    }
    res.json({ ok: true });
  });
  app.delete('/api/audio/peers/:id', auth, (req, res) => { peers.delete(req.params.id); res.json({ ok: true }); });
}
module.exports = { audioRelay };
