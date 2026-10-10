import { useWindowDimensions } from 'react-native';

import { MaxTextScale } from '@/constants/theme';

/**
 * How much the system text size scales text right now, up to `cap`: the app's ceiling
 * (`MaxTextScale`) by default, or a surface's own lower cap. For sizes that should keep pace with
 * the text beside them (an icon in a row, a box a line of text centres on).
 */
export function useTextScale(cap: number = MaxTextScale): number {
  return Math.min(useWindowDimensions().fontScale, cap);
}
