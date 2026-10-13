// Live binding — app.js sets this before any panel mounts, from the
// length of its panel list.
export let PANELS = 6;
export function setPanels(n) { PANELS = n; }

export const DOMAIN = 'office-computer-online-worldwide.org';
// Deep link into Jellyfin's web UI for one item.
export const jellyfinItemUrl = (id, serverId) =>
  `https://jellyfin.${DOMAIN}/web/#/details?id=${id}${serverId ? `&serverId=${serverId}` : ''}`;
