import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { storeUploadConfigForDraft } from "@/utils/uploadConfig";
import { addDestination } from "@/utils/uploadDestinations";

// Simple UUID v4 validation (basic format check)
const isUUIDv4 = (uuid: string) => {
  const uuidv4Regex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidv4Regex.test(uuid);
};

export default function Index() {
  const params = useLocalSearchParams<{
    mode?: string;
    draftId?: string;
    server?: string;
    token?: string;
    name?: string;
    serverNotSetupForUpload?: string;
  }>();
  const router = useRouter();
  const [hasRedirected, setHasRedirected] = useState(false);

  const hasValidDraftId = params.draftId && isUUIDv4(params.draftId);
  const serverNotSetupForUpload =
    params.serverNotSetupForUpload === "true" ||
    (params.mode === "upload" &&
      (params.server != null || params.token != null) &&
      !hasValidDraftId);

  // Debug logging for deeplink parameters
  console.log("🔗 Deeplink params:", params);

  // configure_destination: add upload destination and go to profile (cold start)
  useEffect(() => {
    if (
      params.mode === "configure_destination" &&
      params.server &&
      params.token &&
      !hasRedirected
    ) {
      setHasRedirected(true);
      addDestination(
        params.server,
        params.token,
        params.name ?? undefined
      ).then(() => {
        router.replace({
          pathname: "/(tabs)/profile",
          params: { destinationAdded: "true" },
        });
      });
    }
  }, [
    params.mode,
    params.server,
    params.token,
    params.name,
    hasRedirected,
    router,
  ]);

  // When we have a valid draftId: store config and redirect to shorts
  useEffect(() => {
    const handleDeeplink = async () => {
      if (
        params.mode === "upload" &&
        hasValidDraftId &&
        params.server &&
        params.token
      ) {
        try {
          await storeUploadConfigForDraft(
            params.draftId!,
            params.server,
            params.token
          );
          console.log("✅ Stored upload config for draft", params.draftId);
        } catch (error) {
          console.error("❌ Failed to store upload config:", error);
        }
        if (!hasRedirected) {
          setHasRedirected(true);
          router.push({
            pathname: "/(camera)/shorts",
            params: {
              mode: "upload",
              draftId: params.draftId,
              server: params.server,
              token: params.token,
            },
          });
        }
      }
    };

    handleDeeplink();
  }, [
    params.mode,
    params.draftId,
    params.server,
    params.token,
    hasValidDraftId,
    router,
    hasRedirected,
  ]);

  // Server not set up for upload (e.g. Pulse Clip QR with no draftId): show message here
  if (serverNotSetupForUpload) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Server not set up for upload</Text>
        <Text style={styles.message}>
          Server is not properly set up for upload.
        </Text>
        <TouchableOpacity
          style={styles.button}
          onPress={() => router.replace("/(tabs)")}
          activeOpacity={0.8}
        >
          <Text style={styles.buttonText}>Go to home</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Valid upload with draftId: show loading until redirect
  if (params.mode === "upload") {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#0a84ff" />
        <Text style={styles.text}>Opening...</Text>
      </View>
    );
  }

  // Default to tabs
  return <Redirect href="/(tabs)" />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#000",
    gap: 12,
    paddingHorizontal: 24,
  },
  title: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
  },
  message: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 16,
    textAlign: "center",
  },
  text: {
    color: "#fff",
    fontSize: 16,
  },
  button: {
    marginTop: 16,
    backgroundColor: "#0a84ff",
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 10,
  },
  buttonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
  },
});

