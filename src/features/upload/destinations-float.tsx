import { useMemo, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme, useThemeMode } from '@/hooks/use-theme';
import { hostOf } from '@/utils/format';

import { useDestinations } from './use-destinations';

/** Drag past this (pt), or fling faster than this (pt/s), and the sheet closes on release. */
const DISMISS_DISTANCE = 80;
const DISMISS_VELOCITY = 800;

/** The home screen's + FAB (`styles.fab` in app/index.tsx): 60pt wide, `Spacing.four` from the right. */
const FAB_CLEARANCE = Spacing.four + 60 + Spacing.three;
/** Longest the pill gets on wide screens, so it stays a pill rather than a bar. */
const PILL_MAX_WIDTH = 280;

/**
 * A floating pill on the home screen surfacing the device-wide pool of paired upload destinations
 * (§ destination pool). Tapping it opens a sheet to *view and delete* every non-expired
 * destination — its host and expiry. View/delete only; picking *which* one to
 * upload to happens later, on the export screen. Renders nothing when the pool is empty, so it
 * only appears once at least one server is paired, and disappears as destinations are consumed by
 * finished uploads, deleted here, or expire.
 */
export function DestinationsFloat() {
  const theme = useTheme();
  const mode = useThemeMode();
  // No dimmed backdrop, so the sheet has to separate from the home screen on its own: in dark
  // mode it sits on the elevated surface (a black sheet over the black home screen would vanish)
  // and its rows step up one more level — same elevation as the On-device AI sheet.
  const sheetSurface = mode === 'dark' ? theme.backgroundElement : theme.background;
  const onSheetSurface = mode === 'dark' ? theme.backgroundSelected : theme.backgroundElement;
  const insets = useSafeAreaInsets();
  const { destinations, deleteDestination } = useDestinations();
  const [open, setOpen] = useState(false);

  // Swipe-down-to-close from the grabber/header, matching the native On-device AI sheet. Only the
  // header region drags, so the destination list keeps its own scrolling.
  const dragY = useSharedValue(0);
  const dragStyle = useAnimatedStyle(() => ({ transform: [{ translateY: dragY.get() }] }));
  const dismissPan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetY(8)
        .onUpdate((e) => {
          dragY.set(Math.max(0, e.translationY));
        })
        .onEnd((e) => {
          if (e.translationY > DISMISS_DISTANCE || e.velocityY > DISMISS_VELOCITY) {
            runOnJS(setOpen)(false);
          } else {
            dragY.set(withSpring(0, { damping: 20, stiffness: 300 }));
          }
        }),
    [dragY],
  );
  const openSheet = () => {
    dragY.set(0);
    setOpen(true);
  };

  if (destinations.length === 0) return null;

  const confirmDelete = (id: string, host: string) => {
    Alert.alert('Remove destination?', `Stop uploading to “${host}” from this device.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void deleteDestination(id) },
    ]);
  };

  return (
    <>
      {/* The lane runs from the left margin to just short of the + FAB, so a long host truncates
          instead of sliding under it; taps outside the pill fall through to the list. */}
      <View
        pointerEvents="box-none"
        style={[styles.lane, { bottom: insets.bottom + Spacing.four }]}>
        <Pressable
          onPress={openSheet}
          accessibilityRole="button"
          accessibilityLabel={`${destinations.length} upload ${
            destinations.length === 1 ? 'destination' : 'destinations'
          }`}
          style={({ pressed }) => [
            styles.pill,
            {
              backgroundColor: theme.backgroundElement,
              borderColor: theme.border,
              opacity: pressed ? 0.85 : 1,
            },
          ]}>
          <Icon name="icloud.and.arrow.up" size={18} tintColor={theme.text} />
          {/* Middle truncation keeps the domain's end (e.g. "…mieweb.org") visible. */}
          <ThemedText
            type="smallBold"
            numberOfLines={1}
            ellipsizeMode="middle"
            style={styles.pillLabel}>
            {destinations.length === 1
              ? hostOf(destinations[0].server)
              : `${destinations.length} destinations`}
          </ThemedText>
        </Pressable>
      </View>

      {/* Deliberately undimmed: the dark scrim slid up with the sheet and greyed out the whole
          home screen. Tapping anywhere outside the sheet still closes it. */}
      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        {/* A Modal is its own native root, so gestures inside it need their own root view. */}
        <GestureHandlerRootView style={styles.backdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setOpen(false)}
            accessibilityLabel="Close"
          />
          <Animated.View
            style={[
              styles.sheet,
              {
                backgroundColor: sheetSurface,
                borderColor: theme.border,
                paddingBottom: insets.bottom + Spacing.three,
              },
              dragStyle,
            ]}>
            <GestureDetector gesture={dismissPan}>
              <View style={styles.dragZone}>
                <View style={[styles.grabber, { backgroundColor: theme.textSecondary }]} />
                <View style={styles.header}>
                  <View style={styles.headerText}>
                    <ThemedText type="subtitle">Upload destinations</ThemedText>
                    <ThemedText type="small" themeColor="textSecondary">
                      Servers this device is paired with. Pick one when you upload a pulse; remove
                      any you no longer need.
                    </ThemedText>
                  </View>
                  <Pressable
                    onPress={() => setOpen(false)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Close"
                    style={({ pressed }) => pressed && styles.pressed}>
                    <Icon name="xmark.circle.fill" size={28} tintColor={theme.textSecondary} />
                  </Pressable>
                </View>
              </View>
            </GestureDetector>

            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {destinations.map((d) => {
                const host = hostOf(d.server);
                return (
                  <View
                    key={d.id}
                    style={[
                      styles.row,
                      { backgroundColor: onSheetSurface, borderColor: theme.border },
                    ]}>
                    <View style={styles.rowText}>
                      <ThemedText type="smallBold" numberOfLines={1} ellipsizeMode="middle">
                        {host}
                      </ThemedText>
                      <ThemedText type="caption1" themeColor="textSecondary">
                        {d.expiryLabel}
                      </ThemedText>
                    </View>
                    <Pressable
                      onPress={() => confirmDelete(d.id, host)}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${host}`}
                      style={({ pressed }) => [styles.delete, pressed && styles.pressed]}>
                      <Icon name="trash" size={20} tintColor={theme.accent} />
                    </Pressable>
                  </View>
                );
              })}
            </ScrollView>
          </Animated.View>
        </GestureHandlerRootView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  lane: {
    position: 'absolute',
    left: Spacing.four,
    right: FAB_CLEARANCE,
    height: 44,
    alignItems: 'flex-start',
  },
  pill: {
    maxWidth: PILL_MAX_WIDTH,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    height: 44,
    paddingHorizontal: Spacing.three,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  // Shrinks below its text width so `numberOfLines` can truncate inside the pill.
  pillLabel: { flexShrink: 1 },
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -4 },
    elevation: 24,
    paddingTop: Spacing.two,
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
  },
  dragZone: { gap: Spacing.three },
  // iOS-style sheet grabber (36×5), the handle the header drags by.
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 5,
    borderRadius: 2.5,
    opacity: 0.5,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.three },
  headerText: { flex: 1, gap: Spacing.half },
  list: { maxHeight: 360 },
  listContent: { gap: Spacing.two, paddingBottom: Spacing.two },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.three,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1, gap: Spacing.half },
  delete: { padding: Spacing.one },
  pressed: { opacity: 0.6 },
});
