import { Stack } from "expo-router";
import React from "react";

export default function RootLayout() {
  return (
    <React.Fragment>
      <Stack>
        <Stack.Screen name="(protected)" options={{ headerShown: false }} />
      </Stack>
    </React.Fragment>
  );
}
