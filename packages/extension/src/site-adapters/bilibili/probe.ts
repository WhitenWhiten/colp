/** Bundled MAIN entry. Holds no extension authority. SA-02 installs the audited observation wrapper. */
(() => {
  const key = '__knownBilibiliProbeV1';
  const scope = globalThis as typeof globalThis & { [key]?: boolean };
  if (location.origin !== 'https://www.bilibili.com' || window.top !== window || scope[key]) return;
  scope[key] = true;
})();
