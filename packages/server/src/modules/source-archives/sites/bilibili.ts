/** Canonical Bilibili identity checks; no site network or account access in the server. */
export const bilibiliSourceIdentity = {
  site: 'bilibili', identityVersion: 1,
  account: (id: string) => /^[1-9]\d{0,19}$/.test(id),
  collection: (id: string) => /^[1-9]\d{0,19}$/.test(id),
  item: (id: string, url: string) => /^video:av:[1-9]\d{0,19}$/.test(id) && url === `https://www.bilibili.com/video/av${id.slice(9)}`,
};
