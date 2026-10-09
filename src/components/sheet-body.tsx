import type { ReactNode } from 'react';
import { ScrollView, type StyleProp, View, type ViewStyle } from 'react-native';

/**
 * A sheet's content: a plain view the sheet sizes to, or a scroll view when it doesn't fit
 * (`tallSheetFits`, with the route at full height). The scroll view is the sheet's first subview,
 * as a form sheet expects for scrolling.
 */
export function SheetBody({
  scrolls,
  style,
  children,
}: {
  scrolls: boolean;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return scrolls ? (
    <ScrollView contentContainerStyle={style}>{children}</ScrollView>
  ) : (
    <View style={style}>{children}</View>
  );
}
