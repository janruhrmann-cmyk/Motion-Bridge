/**
 * The few pieces of Adobe's CEP runtime this panel needs, without pulling in
 * CSInterface.js: running ExtendScript, finding the extension folder and
 * reaching Node.js.
 */
import type { HostResult } from '../../shared/ae-raw.ts';

interface CepRuntime {
  evalScript(script: string, callback: (result: string) => void): void;
  getSystemPath(type: string): string;
  getHostEnvironment?(): string;
  addEventListener?(type: string, listener: (event?: { data?: unknown }) => void): void;
  dispatchEvent?(event: { type: string; scope: string; appId: string; extensionId: string; data: string }): void;
  getExtensionId?(): string;
  requestOpenExtension?(id: string, params: string): void;
  closeExtension?(): void;
  invokeSync?(name: string, params: string): string;
}

interface CepWindow {
  __adobe_cep__?: CepRuntime;
  cep_node?: { require(id: string): unknown };
  require?: (id: string) => unknown;
}

const w = window as unknown as CepWindow;

export const inCep = !!w.__adobe_cep__;

export function nodeRequire<T>(id: string): T {
  const req = w.cep_node?.require ?? w.require;
  if (!req) throw new Error('Node.js is not available in this panel.');
  return req(id) as T;
}

export function evalScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!w.__adobe_cep__) {
      reject(new Error('Not running inside After Effects.'));
      return;
    }
    w.__adobe_cep__.evalScript(script, resolve);
  });
}

/** A folder CEP knows, as a plain path: 'extension', or 'userData' (AppData\Roaming, ~/Library/Application Support). */
export function systemPath(type: 'extension' | 'userData'): string {
  const raw = decodeURI(w.__adobe_cep__?.getSystemPath(type) ?? '');
  // Windows reports file:///C:/..., macOS file:///Users/...
  if (/^file:\/\/\/[A-Za-z]:/.test(raw)) return raw.replace('file:///', '');
  return raw.replace('file://', '');
}

export function extensionPath(): string {
  return systemPath('extension');
}

/** After Effects' own panel colour (0..255 per channel), which follows its interface brightness. */
export function hostPanelColor(): { r: number; g: number; b: number } | null {
  try {
    const env = JSON.parse(w.__adobe_cep__?.getHostEnvironment?.() ?? 'null') as {
      appSkinInfo?: { panelBackgroundColor?: { color?: { red: number; green: number; blue: number } } };
    } | null;
    const c = env?.appSkinInfo?.panelBackgroundColor?.color;
    if (!c || ![c.red, c.green, c.blue].every((n) => typeof n === 'number' && isFinite(n))) return null;
    return { r: Math.round(c.red), g: Math.round(c.green), b: Math.round(c.blue) };
  } catch {
    return null;
  }
}

/** Calls back when the user changes After Effects' interface brightness. */
export function onHostThemeChange(listener: () => void): void {
  try {
    w.__adobe_cep__?.addEventListener?.('com.adobe.csxs.events.ThemeColorChanged', listener);
  } catch {
    // Without the event the panel keeps the colours it started with.
  }
}

/** (Re)loads the ExtendScript side. Done on every panel start so edits to host.jsx are picked up. */
export async function loadHost(): Promise<void> {
  const file = `${extensionPath()}/host/host.jsx`.replace(/\\/g, '/');
  const result = await evalScript(`$.evalFile(new File(${JSON.stringify(file)})); typeof MOTIONBRIDGE`);
  if (result !== 'object') throw new Error(`The After Effects script could not be loaded (${result}).`);
}

/** Calls MOTIONBRIDGE.<fn>(...args) in After Effects and unwraps its JSON answer. */
export async function callHost<T>(fn: string, ...args: Array<string | number | string[] | null>): Promise<T> {
  const script = `MOTIONBRIDGE.${fn}(${args.map((a) => JSON.stringify(a)).join(',')})`;
  const raw = await evalScript(script);
  if (!raw || raw === 'EvalScript error.') {
    throw new Error('After Effects could not run the bridge script. Close and reopen the panel.');
  }
  let parsed: HostResult<T> | (T & { ok: true });
  try {
    parsed = JSON.parse(raw) as HostResult<T> | (T & { ok: true });
  } catch {
    throw new Error('After Effects returned something unreadable.');
  }
  if (!parsed.ok) {
    const where = parsed.line ? ` (host.jsx line ${parsed.line})` : '';
    throw new Error(`${parsed.message}${where}`);
  }
  return 'data' in parsed ? (parsed.data as T) : (parsed as T);
}

// ------------------------------------------------- the panel's second window

/** The ids manifest.xml gives the docked panel and its settings window. */
export const PANEL_ID = 'com.motionbridge.panel';
export const SETTINGS_ID = 'com.motionbridge.settings';

/** Which of the bundle's extensions this window is. */
export function extensionId(): string {
  try {
    return w.__adobe_cep__?.getExtensionId?.() ?? '';
  } catch {
    return '';
  }
}

/** Opens another extension of this bundle (or brings it to the front). */
export function openExtension(id: string): void {
  try {
    w.__adobe_cep__?.requestOpenExtension?.(id, '');
  } catch {
    // The window simply does not open.
  }
}

export function closeThisExtension(): void {
  try {
    w.__adobe_cep__?.closeExtension?.();
  } catch {
    // It stays open and says that it has lost its panel.
  }
}

/** The title of a floating window (a docked panel takes its name from the manifest). */
export function setWindowTitle(title: string): void {
  try {
    w.__adobe_cep__?.invokeSync?.('setWindowTitle', title);
  } catch {
    // It keeps the name it has.
  }
}

function appId(): string {
  try {
    const env = JSON.parse(w.__adobe_cep__?.getHostEnvironment?.() ?? 'null') as { appName?: string } | null;
    return env?.appName ?? 'AEFT';
  } catch {
    return 'AEFT';
  }
}

/** Sends a message to every extension of this bundle that listens for `type` (the windows do not share memory). */
export function sendEvent(type: string, data: unknown): void {
  try {
    w.__adobe_cep__?.dispatchEvent?.({ type, scope: 'APPLICATION', appId: appId(), extensionId: extensionId(), data: JSON.stringify(data) });
  } catch {
    // Nobody hears it.
  }
}

/** Listens for messages sent with sendEvent. CEP hands the data over as text or, when it looks like JSON, already read. */
export function onEvent<T>(type: string, listener: (data: T) => void): void {
  try {
    w.__adobe_cep__?.addEventListener?.(type, (event?: { data?: unknown }) => {
      let data = event?.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      if (data && typeof data === 'object') listener(data as T);
    });
  } catch {
    // Without events the windows cannot talk; each shows what it knows.
  }
}
