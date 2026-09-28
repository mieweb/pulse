import * as Clipboard from 'expo-clipboard';

/** Put `text` on the clipboard; whether it got there. Never throws. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    return await Clipboard.setStringAsync(text);
  } catch {
    return false;
  }
}
