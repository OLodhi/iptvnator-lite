import type { Db } from '../db/db.ts';
import { createGuideRunner } from '../guide/runner.ts';
import type { GuideRunner } from '../guide/runner.ts';
import { createGuideStore } from '../guide/store.ts';
import { createPrefsService } from '../prefs/service.ts';
import type { PrefsService } from '../prefs/service.ts';
import type { ProviderService } from '../providers/service.ts';

/** The `guide` and `prefs` deps `buildApp` requires, for tests that never refresh a guide. */
export function guideDeps(db: Db, providers: ProviderService): { guide: GuideRunner; prefs: PrefsService } {
  return {
    guide: createGuideRunner({ db, store: createGuideStore(db), providers, visibleLiveItemIds: () => [] }),
    prefs: createPrefsService(db),
  };
}
