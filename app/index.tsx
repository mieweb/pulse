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
  }>();

  // Debug logging for deeplink parameters
  console.log("🔗 Deeplink params:", params);

  // Handle upload mode with UUID validation
  if (params.mode === "upload") {
    if (params.draftId && isUUIDv4(params.draftId)) {
      return <Redirect href={`/upload?draftId=${params.draftId}`} />;
    } else {
      // Could redirect to upload screen without draftId for new recording
      // return <Redirect href="/upload" />;
    }
  }

  // Default to tabs
  return <Redirect href="/(tabs)" />;
}
