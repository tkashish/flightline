/**
 * Video picks (file input or drop) are checked before they touch the open clip: check(file, signal)
 * resolves a problem or null. A newer pick, or cancel(), stops a pick still being checked and drops
 * it, so Cancel always wins. A pick of several files is a batch from its check on: until open() has
 * it (or the check is stopped), every other pick is refused.
 */
export function createPicker({ check, open, refuse }) {
  let current = 0, batch = 0, controller = null;
  const stop = () => { current++; batch = 0; controller?.abort(); };
  return {
    get batching() { return batch !== 0; },
    cancel: stop,
    /** checking() runs as the check starts and checked() once it ends, stopped or not. */
    async pick(files, { checking, checked } = {}) {
      if (batch) return refuse();
      stop();
      const pick = current, { signal } = controller = new AbortController(), results = [];
      if (files.length > 1) batch = pick;
      checking?.();
      try {
        for (const file of files) {
          if (pick !== current) return;
          results.push({ file, problem: await check(file, signal) });
        }
      } finally {
        if (batch === pick) batch = 0;
        checked?.();
      }
      if (pick === current) return open(results);
    }
  };
}
