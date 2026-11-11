// Native features offered by the desktop app (electron/preload.cjs); absent in a browser.
type Desktop = {
  platform: string;
  pickFolder(defaultPath?: string): Promise<string | null>;
  revealPath(path: string): Promise<void>;
};

export const desktop: Desktop | null = (window as unknown as { desktop?: Desktop }).desktop ?? null;
