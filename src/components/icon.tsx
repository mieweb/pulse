import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import {
  ArrowDownToLine,
  ArrowRight,
  AudioWaveform,
  Camera,
  Captions,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  CircleX,
  Columns3,
  Contrast,
  Copy,
  Crop,
  Download,
  Ellipsis,
  Film,
  FlipHorizontal2,
  Folder,
  GripHorizontal,
  Info,
  Link,
  Lock,
  type LucideIcon,
  Merge,
  Mic,
  MicOff,
  Minus,
  Moon,
  Pause,
  Orbit,
  Pencil,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  RotateCcwSquare,
  RotateCw,
  Scissors,
  Share,
  Sparkles,
  Sun,
  SwitchCamera,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  Video,
  Volume2,
  VolumeX,
  WandSparkles,
  X,
  Zap,
  ZapOff,
} from 'lucide-react-native';
import { Platform, type StyleProp, type ViewStyle } from 'react-native';

import { useTextScale } from '@/hooks/use-text-scale';

export type IconName = SymbolViewProps['name'];
type SymbolWeight = SymbolViewProps['weight'];

/**
 * SF Symbol → Lucide glyph. SF Symbols (expo-symbols) are Apple-only, so on Android we
 * render the closest Lucide equivalent. Keep this in sync with every `name` passed to <Icon>.
 */
const ANDROID_GLYPHS: Partial<Record<string, LucideIcon>> = {
  'arrow.clockwise': RotateCw,
  'arrow.counterclockwise': RotateCcw,
  'arrow.left.and.right.righttriangle.left.righttriangle.right': FlipHorizontal2,
  'arrow.down.to.line': ArrowDownToLine,
  'arrow.right': ArrowRight,
  'arrow.triangle.merge': Merge,
  'arrow.triangle.2.circlepath.camera': SwitchCamera,
  'arrow.uturn.backward': Undo2,
  'arrow.uturn.forward': Redo2,
  'bolt.fill': Zap,
  'bolt.slash.fill': ZapOff,
  'camera.fill': Camera,
  'captions.bubble': Captions,
  'captions.bubble.fill': Captions,
  checkmark: Check,
  'checkmark.circle.fill': CircleCheck,
  'chevron.compact.left': ChevronLeft,
  'chevron.compact.right': ChevronRight,
  'chevron.up': ChevronUp,
  circle: Circle,
  'circle.lefthalf.filled': Contrast,
  'circle.slash': CircleSlash,
  crop: Crop,
  'doc.on.doc': Copy,
  ellipsis: Ellipsis,
  exclamationmark: CircleAlert,
  'exclamationmark.circle.fill': CircleAlert,
  'exclamationmark.triangle.fill': TriangleAlert,
  film: Film,
  folder: Folder,
  gyroscope: Orbit,
  'info.circle': Info,
  'info.circle.fill': Info,
  'line.3.horizontal': GripHorizontal,
  link: Link,
  'lock.fill': Lock,
  'mic.fill': Mic,
  'mic.slash.fill': MicOff,
  minus: Minus,
  'moon.fill': Moon,
  pencil: Pencil,
  'pause.fill': Pause,
  'play.fill': Play,
  plus: Plus,
  'rectangle.split.3x1': Columns3,
  'rotate.left': RotateCcwSquare,
  scissors: Scissors,
  'speaker.slash.fill': VolumeX,
  'speaker.wave.2.fill': Volume2,
  sparkles: Sparkles,
  'square.and.arrow.down': Download,
  'square.and.arrow.up': Share,
  'sun.max.fill': Sun,
  trash: Trash2,
  'trash.fill': Trash2,
  'icloud.and.arrow.up': Upload,
  'video.badge.plus': Video,
  'video.fill': Video,
  'wand.and.stars': WandSparkles,
  waveform: AudioWaveform,
  xmark: X,
  'xmark.circle.fill': CircleX,
};

// SF Symbol weights don't map 1:1 to stroke width; approximate so heavier glyphs read bolder.
function strokeWidthFor(weight?: SymbolWeight): number {
  switch (weight) {
    case 'bold':
    case 'heavy':
    case 'black':
    case 'semibold':
      return 2.5;
    case 'medium':
      return 2.25;
    case 'light':
    case 'thin':
    case 'ultraLight':
      return 1.5;
    default:
      return 2;
  }
}

type IconProps = {
  name: IconName;
  size?: number;
  weight?: SymbolWeight;
  tintColor?: string;
  style?: StyleProp<ViewStyle>;
  /**
   * An icon beside text grows with it, as SF Symbols in iOS text do: `true` up to the app's text
   * ceiling, or a number for the lower cap of the text it sits with (a toast, a pill). Controls
   * (toolbar, camera, close and icon-only buttons) leave it off and keep their size.
   */
  scalesWithText?: boolean | number;
};

/**
 * Cross-platform icon. Renders a native SF Symbol on iOS and the mapped Lucide glyph on
 * Android (where SF Symbols don't exist). Drop-in for the props we used on <Icon>.
 */
export function Icon({
  name,
  size: baseSize = 24,
  weight,
  tintColor,
  style,
  scalesWithText,
}: IconProps) {
  const textScale = useTextScale(typeof scalesWithText === 'number' ? scalesWithText : undefined);
  const size = scalesWithText ? Math.round(baseSize * textScale) : baseSize;
  if (Platform.OS === 'ios') {
    return (
      <SymbolView name={name} size={size} weight={weight} tintColor={tintColor} style={style} />
    );
  }

  // `name` can also be the { ios, android, web } per-platform form, which isn't a valid map key.
  const Glyph = ANDROID_GLYPHS[name as string];
  if (!Glyph) {
    if (__DEV__) {
      console.warn(
        `[Icon] No Android mapping for SF Symbol "${String(name)}" — add it to ANDROID_GLYPHS.`,
      );
    }
    return (
      <Circle
        size={size}
        color={tintColor ?? '#888'}
        strokeWidth={strokeWidthFor(weight)}
        style={style}
      />
    );
  }
  return (
    <Glyph
      size={size}
      color={tintColor ?? '#000'}
      strokeWidth={strokeWidthFor(weight)}
      style={style}
    />
  );
}
