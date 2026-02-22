import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import { Colors } from "@/constants/Colors";
import { useColorScheme } from "@/hooks/useColorScheme";
import {
  getAllDestinations,
  removeDestination,
  type UploadDestination,
} from "@/utils/uploadDestinations";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useLocalSearchParams } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import {
  Alert,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme() ?? "light";
  const colors = Colors[colorScheme];
  const params = useLocalSearchParams<{ destinationAdded?: string }>();
  const [destinations, setDestinations] = useState<UploadDestination[]>([]);
  const [showAddedMessage, setShowAddedMessage] = useState(false);

  const loadDestinations = useCallback(async () => {
    const list = await getAllDestinations();
    setDestinations(list);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadDestinations();
      if (params.destinationAdded === "true") {
        setShowAddedMessage(true);
        const t = setTimeout(() => setShowAddedMessage(false), 3000);
        return () => clearTimeout(t);
      }
    }, [loadDestinations, params.destinationAdded])
  );

  const handleRemove = useCallback(
    (dest: UploadDestination) => {
      Alert.alert(
        "Remove destination",
        `Remove "${dest.name || dest.server}" from upload destinations?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: async () => {
              await removeDestination(dest.id);
              loadDestinations();
            },
          },
        ]
      );
    },
    [loadDestinations]
  );

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flex: 1,
          backgroundColor: colors.background,
        },
        inner: {
          paddingTop: insets.top + 16,
          paddingHorizontal: 20,
          paddingBottom: 24,
        },
        title: {
          fontSize: 24,
          fontWeight: "bold",
          color: colors.text,
          marginBottom: 4,
        },
        subtitle: {
          fontSize: 16,
          color: colors.secondaryText,
          marginBottom: 24,
        },
        addedBanner: {
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: colors.selection + "20",
          padding: 12,
          borderRadius: 8,
          marginBottom: 16,
          gap: 8,
        },
        sectionTitle: {
          fontSize: 18,
          fontWeight: "600",
          color: colors.text,
          marginBottom: 12,
        },
        card: {
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: colors.surface,
          borderRadius: 12,
          padding: 16,
          marginBottom: 10,
          borderWidth: 1,
          borderColor: colors.border,
        },
        cardContent: {
          flex: 1,
        },
        cardName: {
          fontSize: 16,
          fontWeight: "600",
          color: colors.text,
        },
        cardServer: {
          fontSize: 12,
          color: colors.secondaryText,
          marginTop: 4,
        },
        cardExpiry: {
          fontSize: 11,
          color: colors.secondaryText,
          marginTop: 2,
        },
        removeBtn: {
          padding: 8,
        },
        empty: {
          paddingVertical: 24,
          alignItems: "center",
        },
        emptyText: {
          fontSize: 15,
          color: colors.secondaryText,
          textAlign: "center",
        },
      }),
    [colors, insets.top]
  );

  return (
    <ThemedView style={styles.container}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.inner}
        showsVerticalScrollIndicator={false}
      >
        <ThemedText style={styles.title}>Profile</ThemedText>
        <ThemedText style={styles.subtitle}>
          Manage your upload destinations
        </ThemedText>

        {showAddedMessage && (
          <View style={styles.addedBanner}>
            <MaterialIcons name="check-circle" size={22} color={colors.selection} />
            <ThemedText style={{ flex: 1, color: colors.text }}>
              Upload destination added. You can choose it when uploading a video.
            </ThemedText>
          </View>
        )}

        <ThemedText style={styles.sectionTitle}>Upload destinations</ThemedText>
        {destinations.length === 0 ? (
          <View style={styles.empty}>
            <ThemedText style={styles.emptyText}>
              No upload destinations yet.{"\n"}
              Scan a &quot;Setup your app&quot; QR from a Pulse Vault upload page to add one.
            </ThemedText>
          </View>
        ) : (
          destinations.map((dest) => (
            <View key={dest.id} style={styles.card}>
              <View style={styles.cardContent}>
                <ThemedText style={styles.cardName} numberOfLines={1}>
                  {dest.name || dest.server}
                </ThemedText>
                <ThemedText style={styles.cardServer} numberOfLines={2}>
                  {dest.server}
                </ThemedText>
                <ThemedText style={styles.cardExpiry}>
                  Expires: {new Date(dest.expiresAt).toLocaleDateString()}
                </ThemedText>
              </View>
              <TouchableOpacity
                style={styles.removeBtn}
                onPress={() => handleRemove(dest)}
                accessibilityLabel="Remove destination"
              >
                <MaterialIcons name="delete-outline" size={22} color={colors.error} />
              </TouchableOpacity>
            </View>
          ))
        )}
      </ScrollView>
    </ThemedView>
  );
}
