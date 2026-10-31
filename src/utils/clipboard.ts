/**
 * Copies text to the clipboard. Rejects if it could not be copied, so callers can tell the user instead of showing "Copied".
 *
 * `navigator.clipboard` only exists in a secure context (HTTPS or localhost). An on-premises or air-gapped install is
 * often reached over plain http://<ip>:3000, where it is undefined and a bare navigator.clipboard.writeText(...) throws.
 * In that case this falls back to selecting the text in a hidden field and running the legacy copy command, which works
 * everywhere as long as it happens inside a user gesture (a click).
 */
export async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // permission denied or the document lost focus: try the legacy path below
    }
  }

  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.setAttribute('aria-hidden', 'true');
  field.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(field);
  let copied = false;
  try {
    field.focus();
    field.select();
    field.setSelectionRange(0, text.length);
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    field.remove();
    previous?.focus();
  }
  if (!copied) throw new Error('The browser blocked copying to the clipboard');
}

/**
 * Copies text and reports whether it worked: true when copied, false when the browser refused.
 * Never throws and never logs: the text can be an invitation link or CUI, and the error tells the user nothing useful.
 * Call it straight from the click handler (no await before it) so the legacy fallback still runs inside the user gesture.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await copyToClipboard(text);
    return true;
  } catch {
    return false;
  }
}
