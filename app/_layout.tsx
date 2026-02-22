import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider,
} from "@react-navigation/native";
import { useFonts } from "expo-font";
import { useRouter } from "expo-router";
import { Stack } from "expo-router";
import * as Linking from "expo-linking";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "react-native-reanimated";

import { PermissionMonitor } from "@/components/PermissionMonitor";
import { useColorScheme } from "@/hooks/useColorScheme";
import { storeUploadConfigForDraft } from "@/utils/uploadConfig";
import { addDestination } from "@/utils/uploadDestinations";

const isUUIDv4 = (uuid: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const router = useRouter();
  const [loaded] = useFonts({
    "Roboto-Regular": require("../assets/fonts/Roboto-Regular.ttf"),
    "Roboto-Bold": require("../assets/fonts/Roboto-Bold.ttf"),
  });

  // Handle deeplinks: upload (per-draft) or configure_destination (add upload destination)
  useEffect(() => {
    const handleUrl = async (event: { url: string }) => {
      const url = event.url;
      const q = url.includes("?") ? url.split("?")[1] : "";
      const search = new URLSearchParams(q);
      const mode = search.get("mode");
      const server = search.get("server");
      const token = search.get("token");
      const name = search.get("name");

      if (mode === "configure_destination" && server && token) {
        try {
          await addDestination(server, token, name ?? undefined);
          console.log("[Deeplink] Added upload destination:", server);
        } catch (e) {
          console.warn("[Deeplink] Failed to add destination:", e);
        }
        router.replace({
          pathname: "/(tabs)/profile",
          params: { destinationAdded: "true" },
        });
        return;
      }

      if (mode !== "upload") return;
      const draftId = search.get("draftId");
      const hasValidDraftId = draftId && isUUIDv4(draftId);
      if (hasValidDraftId && server && token) {
        try {
          await storeUploadConfigForDraft(draftId, server, token);
        } catch (e) {
          console.warn("[Deeplink] Failed to store upload config:", e);
        }
        router.replace({
          pathname: "/(camera)/shorts",
          params: { mode: "upload", draftId, server, token },
        });
      } else {
        router.replace({
          pathname: "/",
          params: {
            mode: "upload",
            ...(server && { server }),
            ...(token && { token }),
            serverNotSetupForUpload: "true",
          },
        });
      }
    };

    const subscription = Linking.addEventListener("url", handleUrl);
    return () => subscription.remove();
  }, [router]);

  // Cold start: app opened via deeplink when closed
  useEffect(() => {
    let cancelled = false;
    Linking.getInitialURL().then((url) => {
      if (cancelled || !url) return;
      const q = url.includes("?") ? url.split("?")[1] : "";
      const search = new URLSearchParams(q);
      const mode = search.get("mode");
      if (mode === "configure_destination") {
        const server = search.get("server");
        const token = search.get("token");
        const name = search.get("name");
        if (server && token) {
          addDestination(server, token, name ?? undefined).then(() => {
            if (!cancelled) {
              router.replace({
                pathname: "/(tabs)/profile",
                params: { destinationAdded: "true" },
              });
            }
          });
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!loaded) {
    // Async font loading only occurs in development.
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
        <Stack
          screenOptions={{
            headerShown: false,
          }}
        >
          <Stack.Screen
            name="(tabs)"
            options={{
              headerShown: false,
              presentation: "fullScreenModal",
              animation: "none",
            }}
          />
          <Stack.Screen name="+not-found" />
          <Stack.Screen
            name="onboarding"
            options={{
              headerShown: false,
              presentation: "fullScreenModal",
              animation: "fade",
            }}
          />
          <Stack.Screen
            name="(camera)"
            options={{
              headerShown: false,
              presentation: "fullScreenModal",
              animation: "slide_from_bottom",
            }}
          />
          <Stack.Screen
            name="preview-new"
            options={{
              headerShown: false,
              presentation: "fullScreenModal",
              animation: "none",
            }}
          />
          <Stack.Screen
            name="reordersegments"
            options={{
              headerShown: false,
              presentation: "fullScreenModal",
              animation: "none",
            }}
          />
          <Stack.Screen
            name="trim-segment"
            options={{
              headerShown: false,
              presentation: "fullScreenModal",
              animation: "slide_from_bottom",
            }}
          />
          <Stack.Screen
            name="merged-video"
            options={{
              headerShown: false,
              presentation: "fullScreenModal",
              animation: "none",
            }}
          />
        </Stack>
        <StatusBar style="auto" />
        <PermissionMonitor />
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
