// Replaces src/chat/functions/setChatList.ts in the WA-Exporter build.
// Upstream registers a load-time patch (loader.onFullReady(applyPatch)); exportModule
// only needs this export for wrapModuleFunction, which the minimal build never calls.
export function wrapShouldAppearFunction(): never {
  throw new Error('wrapShouldAppearFunction is disabled in the WA-Exporter build');
}
