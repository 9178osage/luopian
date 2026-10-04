const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("luopianDesktop", {
  platform: process.platform,
  isDesktop: true,
});
