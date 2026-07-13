// Key-spec parser for the protocol `key` command and type-submit. It returns the
// CDP Input.dispatchKeyEvent field bundle.
//
// Grammar — tokens are split on "+" and trimmed; the trailing token is the key
// and the leading tokens are modifiers:
//
//   spec     := (modifier "+")* key
//   modifier := Ctrl | Control | Alt | Option | Shift
//             | Meta | Cmd | Command | Super | Win            (case-insensitive)
//   key      := a named key — Enter, Tab, Escape, Backspace, Delete,
//               ArrowUp / ArrowDown / ArrowLeft / ArrowRight (or Up/Down/Left/
//               Right), Home, End (case-insensitive) —
//               OR a single printable character ("a", "A", "7", "?").
//
// Examples: "Enter", "Ctrl+Enter", "Ctrl+Shift+A", "a", "Shift+a".
// The literal "+" key is the separator and is not addressable (out of scope).
//
// `modifiers` is the CDP bitmask Alt=1, Ctrl=2, Meta=4, Shift=8. `text` is set
// only for a printable key with no command modifier (Ctrl/Alt/Meta) held — a
// shifted letter yields its uppercase text; named and control-combo keys carry
// none.

export interface ParsedKey {
  modifiers: number;
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

const MOD_ALT = 1;
const MOD_CTRL = 2;
const MOD_META = 4;
const MOD_SHIFT = 8;

const MODIFIER_BITS: Record<string, number> = {
  alt: MOD_ALT,
  option: MOD_ALT,
  ctrl: MOD_CTRL,
  control: MOD_CTRL,
  meta: MOD_META,
  cmd: MOD_META,
  command: MOD_META,
  super: MOD_META,
  win: MOD_META,
  shift: MOD_SHIFT,
};

interface NamedKey {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
}

const NAMED_KEYS: Record<string, NamedKey> = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  return: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  del: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  up: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  down: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  left: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  right: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
};

export function parseKeys(spec: string): ParsedKey {
  const tokens = spec.split("+").map((token) => token.trim());
  const keyToken = tokens.pop();
  if (keyToken === undefined || keyToken === "") {
    throw new Error(`Invalid key spec: "${spec}"`);
  }

  let modifiers = 0;
  for (const mod of tokens) {
    const bit = MODIFIER_BITS[mod.toLowerCase()];
    if (bit === undefined) {
      throw new Error(`Unknown modifier "${mod}" in key spec: "${spec}"`);
    }
    modifiers |= bit;
  }

  const named = NAMED_KEYS[keyToken.toLowerCase()];
  if (named !== undefined) {
    return {
      modifiers,
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.windowsVirtualKeyCode,
    };
  }

  if (keyToken.length !== 1) {
    throw new Error(`Unrecognized key "${keyToken}" in key spec: "${spec}"`);
  }

  const shift = (modifiers & MOD_SHIFT) !== 0;
  const isLetter = /^[a-zA-Z]$/.test(keyToken);
  const key = shift && isLetter ? keyToken.toUpperCase() : keyToken;

  let code = "";
  let windowsVirtualKeyCode = 0;
  if (isLetter) {
    const upper = keyToken.toUpperCase();
    code = `Key${upper}`;
    windowsVirtualKeyCode = upper.charCodeAt(0);
  } else if (/^[0-9]$/.test(keyToken)) {
    code = `Digit${keyToken}`;
    windowsVirtualKeyCode = keyToken.charCodeAt(0);
  }

  const result: ParsedKey = { modifiers, key, code, windowsVirtualKeyCode };

  // Command modifiers (Alt/Ctrl/Meta) turn the keystroke into a shortcut rather
  // than text input, so only a plain (optionally Shift-ed) printable carries text.
  const hasCommandModifier = (modifiers & (MOD_ALT | MOD_CTRL | MOD_META)) !== 0;
  if (!hasCommandModifier) result.text = key;

  return result;
}
