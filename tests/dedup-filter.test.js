const { DedupFilter } = require('../lib/dedup-filter');

describe('DedupFilter', () => {
  let filter;

  beforeEach(() => {
    filter = new DedupFilter({
      enabled: true,
      historyWindow: 200,
      artistSpacing: 5,
      titleSimilarityThreshold: 0.85
    });
  });

  describe('isDuplicate - exact videoId match', () => {
    test('returns true for same videoId in queue', () => {
      const queue = [{ videoId: 'abc123', title: 'Song A', artist: 'Artist A' }];
      const result = filter.isDuplicate({ videoId: 'abc123', title: 'Song B', artist: 'Artist B' }, queue);
      expect(result.isDuplicate).toBe(true);
      expect(result.reason).toContain('videoId');
    });

    test('returns false for different videoId', () => {
      const queue = [{ videoId: 'abc123', title: 'Song A', artist: 'Artist A' }];
      const result = filter.isDuplicate({ videoId: 'def456', title: 'Song B', artist: 'Artist B' }, queue);
      expect(result.isDuplicate).toBe(false);
    });
  });

  describe('isDuplicate - history window', () => {
    test('returns true for videoId in history', () => {
      filter.setHistory(['vid1', 'vid2', 'vid3']);
      const result = filter.isDuplicate({ videoId: 'vid2', title: 'Test', artist: 'Artist' }, []);
      expect(result.isDuplicate).toBe(true);
      expect(result.reason).toContain('history');
    });

    test('returns false for videoId not in history', () => {
      filter.setHistory(['vid1', 'vid2']);
      const result = filter.isDuplicate({ videoId: 'vid4', title: 'Test', artist: 'Artist' }, []);
      expect(result.isDuplicate).toBe(false);
    });
  });

  describe('isDuplicate - artist spacing', () => {
    test('returns true for same artist within spacing window', () => {
      const queue = [
        { videoId: '1', title: 'One', artist: 'Artist A' },
        { videoId: '2', title: 'Two', artist: 'Artist A' },
        { videoId: '3', title: 'Three', artist: 'Artist B' },
      ];
      const result = filter.isDuplicate({ videoId: '4', title: 'Four', artist: 'Artist A' }, queue);
      expect(result.isDuplicate).toBe(true);
      expect(result.reason).toContain('artist');
    });

    test('returns false for same artist outside spacing window', () => {
      const queue = Array.from({length: 20}, (_, i) => ({
        videoId: String(i + 1),
        title: `Song ${String.fromCharCode(65 + i)}`,
        artist: `Artist ${String.fromCharCode(65 + i)}`
      }));
      // Put Artist A at the beginning (index 0) - far outside spacing window of 5
      queue[0] = { videoId: '0', title: 'Zero', artist: 'Artist A' };
      // Artist A is at position 0, outside spacing window of 5
      const result = filter.isDuplicate({ videoId: '999', title: 'New Song', artist: 'Artist A' }, queue);
      expect(result.isDuplicate).toBe(false);
    });

    test('returns false when artist not in queue', () => {
      const queue = [{ videoId: '1', title: 'One', artist: 'Artist A' }];
      const result = filter.isDuplicate({ videoId: '2', title: 'Two', artist: 'Artist B' }, queue);
      expect(result.isDuplicate).toBe(false);
    });
  });

  describe('isDuplicate - title similarity', () => {
    test('returns true for very similar titles', () => {
      const queue = [{ videoId: '1', title: 'Hello World Radio', artist: 'Artist A' }];
      const result = filter.isDuplicate({ videoId: '2', title: 'hello world radio', artist: 'Artist B' }, queue);
      expect(result.isDuplicate).toBe(true);
    });

    test('returns false for different titles', () => {
      const queue = [{ videoId: '1', title: 'Hello World', artist: 'Artist A' }];
      const result = filter.isDuplicate({ videoId: '2', title: 'Goodbye Moon', artist: 'Artist B' }, queue);
      expect(result.isDuplicate).toBe(false);
    });
  });

  describe('disabled', () => {
    test('never returns duplicate when disabled', () => {
      const disabledFilter = new DedupFilter({ enabled: false });
      const queue = [{ videoId: 'abc', title: 'Test', artist: 'Artist' }];
      expect(disabledFilter.isDuplicate({ videoId: 'abc' }, queue).isDuplicate).toBe(false);
    });
  });

  describe('filterTracks', () => {
    test('removes duplicates from batch', () => {
      const queue = [{ videoId: '1', title: 'Song A', artist: 'Artist A' }];
      const tracks = [
        { videoId: '1', title: 'Song A', artist: 'Artist A' },  // duplicate
        { videoId: '2', title: 'Song B', artist: 'Artist B' },  // new
        { videoId: '3', title: 'Song B (remix)', artist: 'Artist B' }, // title similar
      ];
      const filtered = filter.filterTracks(tracks, queue);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].videoId).toBe('2');
    });

    test('empty batch returns empty', () => {
      expect(filter.filterTracks([], [])).toEqual([]);
    });
  });

  describe('addPlayed', () => {
    test('adds to history', () => {
      filter.addPlayed('vid1');
      expect(filter._history).toContain('vid1');
    });

    test('respects history window limit', () => {
      const smallFilter = new DedupFilter({ historyWindow: 3 });
      smallFilter.addPlayed('a');
      smallFilter.addPlayed('b');
      smallFilter.addPlayed('c');
      smallFilter.addPlayed('d');
      expect(smallFilter._history).toEqual(['b', 'c', 'd']);
    });
  });

  describe('findDuplicates', () => {
    test('finds duplicate groups', () => {
      const queue = [
        { videoId: '1', title: 'Song A', artist: 'Artist A' },
        { videoId: '1', title: 'Song A (dupe)', artist: 'Artist B' },
        { videoId: '2', title: 'Song B', artist: 'Artist C' },
        { videoId: '3', title: 'Song C', artist: 'Artist A' },
      ];
      const groups = filter.findDuplicates(queue);
      expect(groups.length).toBeGreaterThanOrEqual(1);
      // First group should have videoId 1 as dupe
      const group1 = groups.find(g => g.original.videoId === '1');
      expect(group1).toBeDefined();
    });

    test('returns empty for no duplicates', () => {
      const queue = [
        { videoId: '1', title: 'Song A', artist: 'Artist A' },
        { videoId: '2', title: 'Song B', artist: 'Artist B' },
      ];
      expect(filter.findDuplicates(queue)).toEqual([]);
    });
  });

  describe('setHistory', () => {
    test('replaces history entirely', () => {
      filter.setHistory(['a', 'b', 'c']);
      expect(filter._history).toEqual(['a', 'b', 'c']);
    });
  });
});