// Gives the editor page the few native features it uses in the desktop app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  /** Native "choose folder" dialog; resolves to the folder's path, or null if cancelled. */
  pickFolder: (defaultPath) => ipcRenderer.invoke('pick-folder', defaultPath),
  /** Show a file or folder in Finder / the file manager. */
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),
  /** Open a folder in Finder / the file manager; resolves to '' or an error message. */
  openFolder: (p) => ipcRenderer.invoke('open-folder', p),
  /** Open another editor window, on `project` (opened on the server first) or the project picker. */
  newWindow: (project) => ipcRenderer.invoke('new-window', project),
});
