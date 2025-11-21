import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { storeUploadConfig } from "@/utils/uploadConfig";

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
  }>();
  const router = useRouter();
  const [hasRedirected, setHasRedirected] = useState(false);

  // Debug logging for deeplink parameters
  console.log("🔗 Deeplink params:", params);

  // Store server and token when provided in deeplink, then redirect
  useEffect(() => {
    const handleDeeplink = async () => {
      if (params.mode === "upload") {
        // Store server and token if provided
        if (params.server && params.token) {
          try {
            await storeUploadConfig(params.server, params.token);
            console.log("✅ Stored upload config from deeplink");
          } catch (error) {
            console.error("❌ Failed to store upload config:", error);
          }
        }

        // Build redirect URL with all parameters
        const redirectParams: Record<string, string> = {
          mode: "upload",
        };

        if (params.draftId && isUUIDv4(params.draftId)) {
          redirectParams.draftId = params.draftId;
        }

        // Include server and token in URL (they're also stored in AsyncStorage)
        if (params.server) {
          redirectParams.server = params.server;
        }
        if (params.token) {
          redirectParams.token = params.token;
        }

        // Redirect to shorts screen
        if (!hasRedirected) {
          setHasRedirected(true);
          router.push({
            pathname: "/(camera)/shorts",
            params: redirectParams,
          });
        }
      }
    };

    handleDeeplink();
  }, [params.mode, params.draftId, params.server, params.token, router, hasRedirected]);

  // Handle upload mode - redirect happens in useEffect
  if (params.mode === "upload") {
    // Show nothing while processing (or a loading indicator)
    return null;
  }

  // Default to tabs
  return <Redirect href="/(tabs)" />;
}

