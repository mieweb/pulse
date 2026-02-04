/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

const tintColorLight = "#0a7ea4";
const tintColorDark = "#fff";

export const Colors = {
  light: {
    text: "#11181C",
    background: "#fff",
    tint: tintColorLight,
    icon: "#687076",
    tabIconDefault: "#687076",
    tabIconSelected: tintColorLight,
    tabBarButtonColor: "#0C0C0C",
    tabBarButtonColorBg: "#EDEDED",
    appPrimary: "#F01E21",
    success: "#4CAF50",
    error: "#F44336",
    /** Card/surface background (home drafts list, buttons) */
    surface: "#F2F2F7",
    /** Card and control borders */
    border: "#C6C6C8",
    /** Secondary text (subtitles, dates) */
    secondaryText: "#6B6B70",
    /** Input background */
    inputBackground: "#E5E5EA",
    /** Selected/highlight border (e.g. draft selection) */
    selection: "#0A84FF",
  },
  dark: {
    text: "#ECEDEE",
    background: "#000",
    tint: tintColorDark,
    icon: "#9BA1A6",
    tabBarButtonColor: "#FFFFFF",
    tabBarButtonColorBg: "#2E2E2E",
    tabIconDefault: "#9BA1A6",
    tabIconSelected: tintColorDark,
    appPrimary: "#F01E21",
    success: "#4CAF50",
    error: "#F44336",
    /** Card/surface background (home drafts list, buttons) */
    surface: "#1C1C1E",
    /** Card and control borders */
    border: "#38383A",
    /** Secondary text (subtitles, dates) */
    secondaryText: "#8E8E93",
    /** Input background */
    inputBackground: "#2C2C2E",
    /** Selected/highlight border (e.g. draft selection) */
    selection: "#0A84FF",
  },
};
