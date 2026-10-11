// Sends recorded audio chunks to the server one at a time, in order, retrying
// with a growing delay. Pure logic with no React Native imports, so it can be
// unit tested in plain Node (see audioUploadQueue.test.js).
//
// `uploadChunk(item)` does the whole round trip for one chunk (ask the API for
// an upload link, PUT the file, confirm). It throws on any failure.
//
// A chunk that keeps failing is not dropped: it stays at the front and is tried
// again on the next flush, because a rider in a car loses signal in tunnels and
// gets it back. Chunks are only kept in memory, so closing the app discards any
// that have not been sent yet.

function createUploadQueue({ uploadChunk, maxAttemptsPerFlush = 4, baseDelayMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onSent = () => {} }) {
  const items = [];
  let running = null;

  async function drain() {
    while (items.length > 0) {
      const item = items[0];
      let sent = false;
      for (let attempt = 0; attempt < maxAttemptsPerFlush && !sent; attempt++) {
        try {
          await uploadChunk(item);
          sent = true;
        } catch (err) {
          item.lastError = err;
          if (attempt < maxAttemptsPerFlush - 1) await sleep(baseDelayMs * 2 ** attempt);
        }
      }
      if (!sent) return false; // leave it queued; the next enqueue or flush retries it
      items.shift();
      try { onSent(item); } catch { /* a bad callback must not stall uploads */ }
    }
    return true;
  }

  // Starts draining if not already; resolves true when the queue is empty.
  function flush() {
    if (!running) {
      running = drain().finally(() => { running = null; });
    }
    return running;
  }

  return {
    enqueue(item) {
      items.push(item);
      return flush();
    },
    flush,
    size: () => items.length,
  };
}

module.exports = { createUploadQueue };
