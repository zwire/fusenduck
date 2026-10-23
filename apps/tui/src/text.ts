// Everything shown in the terminal that came from the file (cells, column names, the path, an
// error that quotes a value) is untrusted text. A terminal acts on control characters: an escape
// sequence can move the cursor, rewrite earlier lines, set the window title or put text on the
// clipboard (OSC 52). So the UI shows a control character as a placeholder, never as itself.

const NEWLINE = /[\n\r\u2028\u2029]/g;
// C0 and C1 controls (ESC, CSI and OSC introducers included), DEL, and the bidirectional overrides
// and isolates (which reorder what follows them on screen), zero-width and invisible format
// characters, and the tag characters, which show nothing and can hide text.
// eslint-disable-next-line no-control-regex -- the point of this pattern is to match control characters
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u061c\u200b-\u200d\u2060-\u2064\u206a-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu;

/** `text` made safe to print on one line. */
export function plain(text: string): string {
  return text.replace(NEWLINE, "⏎").replace(/\t/g, " ").replace(CONTROL, "�");
}
