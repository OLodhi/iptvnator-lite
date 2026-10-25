import { createSubscriber } from 'svelte/reactivity';

const QUERY = '(orientation: landscape) and (pointer: coarse)';

/** True while a touch device is held sideways. Listens only while read inside an effect. */
export function createOrientation(): { readonly landscape: boolean; destroy(): void } {
  const mql = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null;
  let destroyed = false;
  const subscribe = createSubscriber((update) => {
    if (!mql || destroyed) return;
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  });
  return {
    get landscape() {
      subscribe();
      return mql?.matches ?? false;
    },
    destroy() {
      destroyed = true;
    },
  };
}
