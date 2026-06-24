import { describe, expect, it, vi } from 'vitest';

import { makeActionCaller } from './connection';

// Flush pending microtasks so the promise's .catch handler has run.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('makeActionCaller — the action-error seam', () => {
  it('surfaces a rejected reducer call with the server Err message', async () => {
    const onError = vi.fn();
    makeActionCaller(onError)(Promise.reject(new Error('you have no bait')));
    await flush();
    expect(onError).toHaveBeenCalledWith('you have no bait');
  });

  it('falls back to a generic message when the rejection is not an Error', async () => {
    const onError = vi.fn();
    makeActionCaller(onError)(Promise.reject('not-an-error'));
    await flush();
    expect(onError).toHaveBeenCalledWith('That action could not be completed.');
  });

  it('does not fire on a resolved (successful) action', async () => {
    const onError = vi.fn();
    makeActionCaller(onError)(Promise.resolve());
    await flush();
    expect(onError).not.toHaveBeenCalled();
  });
});
