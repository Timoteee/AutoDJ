const { ListeningHistory } = require('../lib/listening-history');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
test('completed plays rank above skips; duplicate events do not count twice and history persists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autodj-listening-'));
  try {
    const file = path.join(dir,'listening.json'), history = new ListeningHistory(file);
    history.record({ eventId:'one', artist:'Favorite',title:'Song',listenRatio:1 });
    history.record({ eventId:'one', artist:'Favorite',title:'Song',listenRatio:1 });
    history.record({ eventId:'two', artist:'Skipped',title:'Song',listenRatio:.1,skipped:true });
    expect(history.events).toHaveLength(2);
    expect(new ListeningHistory(file).seeds().map(s => s.artist)).toEqual(['Favorite']);
    history.setLike({artist:'Liked artist',title:'Loved song'},true);
    expect(new ListeningHistory(file).likes).toHaveLength(1);
    expect(history.seeds()[0].artist).toBe('Liked artist');
    history.setLike({artist:'Liked artist',title:'Loved song'},false);
    expect(new ListeningHistory(file).likes).toHaveLength(0);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
