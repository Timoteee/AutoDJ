class DownloadQueue {
  constructor(run, concurrency = 2) { this.run = run; this.concurrency = concurrency; this.jobs = new Map(); this.pending = []; this.active = 0; }
  add(id, track) {
    if (this.jobs.has(id)) return this.jobs.get(id);
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    this.jobs.set(id, promise); this.pending.push({ id, track, resolve }); this.drain();
    return promise;
  }
  drain() {
    while (this.active < this.concurrency && this.pending.length) {
      const job = this.pending.shift(); this.active++;
      Promise.resolve().then(() => this.run(job.track)).catch(() => {}).finally(() => {
        this.active--; this.jobs.delete(job.id); job.resolve(); this.drain();
      });
    }
  }
}
module.exports = { DownloadQueue };
