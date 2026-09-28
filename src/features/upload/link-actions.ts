import * as Linking from 'expo-linking';
import { Platform, Share } from 'react-native';

/**
 * Opens an uploaded video in the browser. Not an in-app browser: tapped from a menu that's still
 * closing, iOS would close that along with the menu.
 */
export async function watchUpload(url: string): Promise<void> {
  await Linking.openURL(url);
}

/**
 * Offers an upload's link in the system share sheet, which has Copy alongside Messages, AirDrop
 * and the rest. iOS takes the link as a URL; Android only shares text, so it gets the link as text.
 */
export async function shareUploadLink(url: string, title?: string): Promise<void> {
  await Share.share(Platform.OS === 'ios' ? { url } : { message: url, title }, {
    dialogTitle: title,
    subject: title,
  });
}
