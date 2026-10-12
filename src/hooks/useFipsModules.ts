import { useMemo } from 'react';
import { useEnclaveAssets } from './useEnclaveAssets';
import { FipsModuleRef, collectFipsModules } from '../data/telemetry/fipsValidation';

/**
 * The validated cryptographic modules recorded on the active tenant's Security Protection Assets, for the policy compiler
 * and the SSP. `undefined` until the inventory has loaded (and if it cannot be loaded): documents then keep their generic
 * wording instead of claiming that no module is recorded.
 */
export function useFipsModules(): FipsModuleRef[] | undefined {
  const { assets, loading, error } = useEnclaveAssets();
  return useMemo(() => (loading || error ? undefined : collectFipsModules(assets)), [assets, loading, error]);
}
