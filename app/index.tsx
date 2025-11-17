import { Redirect, useLocalSearchParams } from "expo-router";

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
    token?: string; // Secure upload token
  }>();

  // Debug logging for deeplink parameters
  console.log("🔗 Deeplink params:", params);

  // Handle upload mode with UUID validation
  if (params.mode === "upload") {
    // Build query params for redirect
    const queryParams = new URLSearchParams();
    if (params.draftId && isUUIDv4(params.draftId)) {
      queryParams.set("draftId", params.draftId);
    }
    queryParams.set("mode", "upload");
    if (params.server) {
      queryParams.set("server", params.server);
    }
    // Include secure token if present
    if (params.token) {
      queryParams.set("token", params.token);
    }

    return (
      <Redirect
        href={`/(camera)/shorts?${queryParams.toString()}`}
      />
    );
  }

  // Default to tabs
  return <Redirect href="/(tabs)" />;
}
