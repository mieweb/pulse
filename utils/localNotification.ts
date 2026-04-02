import { Alert, Platform } from "react-native";

type NotificationsModule = typeof import("expo-notifications");

let notificationSetupDone = false;
let notificationsModuleCache: NotificationsModule | null | undefined;

const BUG_REPORT_NOTIFICATION_CATEGORY = "bug-report-upload";
const BUG_REPORT_OPEN_ACTION = "open-github-ticket";

async function getNotificationsModule(): Promise<NotificationsModule | null> {
  if (notificationsModuleCache !== undefined) {
    return notificationsModuleCache;
  }

  try {
    notificationsModuleCache = await import("expo-notifications");
  } catch (error) {
    notificationsModuleCache = null;
    console.warn(
      "[BugReportNotification] expo-notifications native module unavailable. Rebuild app to enable local notifications.",
      error
    );
  }

  return notificationsModuleCache;
}

async function ensureNotificationSetup(): Promise<boolean> {
  const Notifications = await getNotificationsModule();
  if (!Notifications) {
    return false;
  }

  if (!notificationSetupDone) {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("bug-report-upload", {
        name: "Bug Report Upload",
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }

    await Notifications.setNotificationCategoryAsync(BUG_REPORT_NOTIFICATION_CATEGORY, [
      {
        identifier: BUG_REPORT_OPEN_ACTION,
        buttonTitle: "Open GitHub",
        options: {
          opensAppToForeground: true,
        },
      },
    ]);

    notificationSetupDone = true;
  }

  const currentPermissions = await Notifications.getPermissionsAsync();
  if (currentPermissions.granted || currentPermissions.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) {
    return true;
  }

  const requestResult = await Notifications.requestPermissionsAsync();
  return (
    requestResult.granted ||
    requestResult.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
  );
}

export async function notifyBackgroundBugReportResult(
  success: boolean,
  issueUrl?: string | null
): Promise<void> {
  try {
    const ready = await ensureNotificationSetup();
    if (!ready) {
      Alert.alert(
        success
          ? "Bug report uploaded successfully."
          : "Bug report upload failed. Please try again."
      );
      return;
    }

    const Notifications = await getNotificationsModule();
    if (!Notifications) {
      Alert.alert(
        success
          ? "Bug report uploaded successfully."
          : "Bug report upload failed. Please try again."
      );
      return;
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title: "Bug Report Upload",
        body: success
          ? "Bug report uploaded successfully."
          : "Bug report upload failed. Please try again.",
        data: issueUrl ? { issueUrl } : undefined,
        categoryIdentifier: success && issueUrl ? BUG_REPORT_NOTIFICATION_CATEGORY : undefined,
      },
      trigger: null,
    });
  } catch (error) {
    console.error("[BugReportNotification] Failed to show local notification", error);
  }
}

export async function openBugReportNotificationUrl(issueUrl?: string | null): Promise<void> {
  if (!issueUrl) return;

  try {
    const canOpen = await import("expo-linking").then((mod) => mod.canOpenURL(issueUrl));
    if (!canOpen) {
      Alert.alert("Unable to open GitHub ticket.");
      return;
    }

    await import("expo-linking").then((mod) => mod.openURL(issueUrl));
  } catch (error) {
    console.error("[BugReportNotification] Failed to open GitHub URL", error);
    Alert.alert("Unable to open GitHub ticket.");
  }
}

export const BUG_REPORT_NOTIFICATION_OPEN_ACTION = BUG_REPORT_OPEN_ACTION;
