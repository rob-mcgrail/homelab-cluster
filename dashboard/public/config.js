// Live binding — app.js sets this before any panel mounts, from the
// length of its panel list.
export let PANELS = 6;
export function setPanels(n) { PANELS = n; }
