import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { getCalendars } from 'expo-localization';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { CardShadow, Opacity, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

import { formatSummaryDate, shiftSummaryDate, todayDate } from './summary-dates';

type Props = {
  startDate: string;
  endDate: string;
  onChange: (startDate: string, endDate: string) => void;
  disabled?: boolean;
};

const dayNumbers = new Intl.NumberFormat();

function firstWeekday(): number {
  try {
    return (getCalendars()[0]?.firstWeekday ?? 1) - 1;
  } catch {
    return 0;
  }
}

function moveMonth(month: string, delta: number): string {
  const date = new Date(`${month}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}

/** Calendar days, not clock times: From is inclusive and Through includes the entire day. */
export function SummaryDateRange({ startDate, endDate, onChange, disabled = false }: Props) {
  const theme = useTheme();
  const [editing, setEditing] = useState<'start' | 'end' | null>(null);
  const [month, setMonth] = useState(startDate.slice(0, 7));
  const firstDay = `${month}-01`;
  const weekStarts = firstWeekday();
  const monthDate = new Date(`${firstDay}T12:00:00Z`);
  const leading = (monthDate.getUTCDay() - weekStarts + 7) % 7;
  monthDate.setUTCMonth(monthDate.getUTCMonth() + 1, 0);
  const daysInMonth = monthDate.getUTCDate();
  const cells = Array.from({ length: Math.ceil((leading + daysInMonth) / 7) * 7 }, (_, index) => {
    const day = index - leading + 1;
    return day >= 1 && day <= daysInMonth ? `${month}-${String(day).padStart(2, '0')}` : null;
  });
  const monthTitle = formatSummaryDate(firstDay, { month: 'long', year: 'numeric' });

  const edit = (field: 'start' | 'end') => {
    if (editing === field) {
      setEditing(null);
      return;
    }
    setMonth((field === 'start' ? startDate : endDate).slice(0, 7));
    setEditing(field);
  };

  const choose = (value: string) => {
    if (editing === 'start') {
      onChange(value, endDate);
      setEditing('end');
    } else {
      onChange(startDate, value);
      setEditing(null);
    }
  };

  const shortcut = (offset: number) => {
    const date = shiftSummaryDate(todayDate(Date.now()), offset);
    onChange(date, date);
    setMonth(date.slice(0, 7));
    setEditing(null);
  };

  return (
    <View style={styles.section}>
      <View style={[styles.card, { backgroundColor: theme.card }]}>
        {(
          [
            ['start', 'From', startDate],
            ['end', 'Through', endDate],
          ] as const
        ).map(([field, label, value], index) => (
          <Pressable
            key={field}
            onPress={() => edit(field)}
            disabled={disabled}
            testID={`summary.range.${field}`}
            accessibilityRole="button"
            accessibilityLabel={`${label} date, ${formatSummaryDate(value, { dateStyle: 'full' })}`}
            accessibilityHint="Opens a calendar to choose the date"
            accessibilityState={{ disabled, expanded: editing === field }}
            style={({ pressed }) => [
              styles.field,
              index > 0 && {
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: theme.border,
              },
              (pressed || editing === field) && { backgroundColor: theme.backgroundSelected },
            ]}>
            <ThemedText type="subheadline" themeColor="textSecondary">
              {label}
            </ThemedText>
            <ThemedText type="subheadlineEmphasized" style={styles.value}>
              {formatSummaryDate(value)}
            </ThemedText>
          </Pressable>
        ))}
        {editing && (
          <View style={styles.calendar}>
            <View style={styles.monthHeader}>
              <Pressable
                onPress={() => setMonth(moveMonth(month, -1))}
                disabled={disabled || month === '0001-01'}
                accessibilityRole="button"
                accessibilityLabel="Previous month"
                accessibilityState={{ disabled: disabled || month === '0001-01' }}
                style={({ pressed }) => [styles.monthArrow, pressed && styles.pressed]}>
                <Icon name="chevron.left" size={18} tintColor={theme.accent} />
              </Pressable>
              <ThemedText
                type="subheadlineEmphasized"
                accessibilityRole="header"
                style={styles.month}>
                {monthTitle}
              </ThemedText>
              <Pressable
                onPress={() => setMonth(moveMonth(month, 1))}
                disabled={disabled || month === '9999-12'}
                accessibilityRole="button"
                accessibilityLabel="Next month"
                accessibilityState={{ disabled: disabled || month === '9999-12' }}
                style={({ pressed }) => [styles.monthArrow, pressed && styles.pressed]}>
                <Icon name="chevron.compact.right" size={18} tintColor={theme.accent} />
              </Pressable>
            </View>
            <ThemedText type="footnote" themeColor="textSecondary" style={styles.calendarHint}>
              {editing === 'start' ? 'Choose the first day' : 'Choose the last day'}
            </ThemedText>
            <View
              style={styles.week}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants">
              {Array.from({ length: 7 }, (_, index) => (
                <ThemedText
                  key={index}
                  type="caption1"
                  themeColor="textSecondary"
                  style={styles.weekday}>
                  {formatSummaryDate(shiftSummaryDate('2026-11-22', weekStarts + index), {
                    weekday: 'narrow',
                  })}
                </ThemedText>
              ))}
            </View>
            {Array.from({ length: cells.length / 7 }, (_, week) => (
              <View key={week} style={styles.week}>
                {cells.slice(week * 7, week * 7 + 7).map((value, column) => {
                  if (!value) return <View key={column} style={styles.day} />;
                  const endpoint = value === startDate || value === endDate;
                  const inRange = startDate <= value && value <= endDate;
                  return (
                    <Pressable
                      key={value}
                      onPress={() => choose(value)}
                      disabled={disabled}
                      accessibilityRole="button"
                      accessibilityLabel={formatSummaryDate(value, { dateStyle: 'full' })}
                      accessibilityState={{ disabled, selected: endpoint }}
                      accessibilityHint={inRange ? 'In the selected date range' : undefined}
                      style={({ pressed }) => [
                        styles.day,
                        {
                          backgroundColor: endpoint
                            ? theme.accent
                            : inRange || pressed
                              ? theme.backgroundSelected
                              : 'transparent',
                        },
                      ]}>
                      <ThemedText
                        type="subheadline"
                        style={{ color: endpoint ? theme.onAccent : theme.text }}>
                        {dayNumbers.format(Number(value.slice(8)))}
                      </ThemedText>
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>
        )}
      </View>
      <View style={styles.shortcuts}>
        {(['Today', 'Yesterday'] as const).map((label, index) => (
          <Pressable
            key={label}
            onPress={() => shortcut(-index)}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityHint={`Selects ${label.toLowerCase()} for both dates`}
            accessibilityState={{ disabled }}
            style={({ pressed }) => [
              styles.shortcut,
              { backgroundColor: theme.card },
              pressed && styles.pressed,
            ]}>
            <ThemedText type="subheadlineEmphasized" themeColor="accent">
              {label}
            </ThemedText>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: Spacing.two },
  card: { borderRadius: Radius.card, borderCurve: 'continuous', overflow: 'hidden', ...CardShadow },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 52,
    padding: Spacing.three,
    gap: Spacing.three,
  },
  value: { flex: 1, textAlign: 'right' },
  calendar: { paddingHorizontal: Spacing.two, paddingBottom: Spacing.two },
  monthHeader: { flexDirection: 'row', alignItems: 'center' },
  monthArrow: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  month: { flex: 1, textAlign: 'center' },
  calendarHint: { paddingHorizontal: Spacing.two, marginBottom: Spacing.two },
  week: { flexDirection: 'row' },
  weekday: { flex: 1, textAlign: 'center', paddingVertical: Spacing.one },
  day: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.row,
  },
  shortcuts: { flexDirection: 'row', gap: Spacing.two, flexWrap: 'wrap' },
  shortcut: {
    minHeight: 44,
    paddingHorizontal: Spacing.three,
    paddingVertical: 12,
    borderRadius: Radius.row,
  },
  pressed: { opacity: Opacity.pressed },
});
