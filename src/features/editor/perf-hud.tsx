import { useEffect } from 'react';
import { StyleSheet, TextInput } from 'react-native';
import Animated, {
  useAnimatedProps,
  useFrameCallback,
  useSharedValue,
} from 'react-native-reanimated';

const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

/**
 * Spike only: the UI thread's frame rate and worst frame over the last half second, and the JS
 * thread's frame rate, over the editor's preview. Measured on the threads themselves (a frame
 * callback on the UI thread, requestAnimationFrame on JS), shown without re-rendering React.
 */
export function PerfHud() {
  const uiFrames = useSharedValue(0);
  const uiWorst = useSharedValue(0);
  const uiLast = useSharedValue(0);
  const windowStart = useSharedValue(0);
  const jsFrames = useSharedValue(0);
  const text = useSharedValue('UI — fps · JS — fps');

  useFrameCallback(({ timestamp }) => {
    if (uiLast.get() > 0) {
      const dt = timestamp - uiLast.get();
      if (dt > uiWorst.get()) uiWorst.set(dt);
    }
    uiLast.set(timestamp);
    uiFrames.set(uiFrames.get() + 1);
    if (windowStart.get() === 0) windowStart.set(timestamp);
    const span = timestamp - windowStart.get();
    if (span >= 500) {
      const ui = Math.round((uiFrames.get() * 1000) / span);
      const js = Math.round((jsFrames.get() * 1000) / span);
      text.set(`UI ${ui} fps · worst ${Math.round(uiWorst.get())} ms · JS ${js} fps`);
      uiFrames.set(0);
      uiWorst.set(0);
      jsFrames.set(0);
      windowStart.set(timestamp);
    }
  });

  useEffect(() => {
    let id = 0;
    const tick = () => {
      jsFrames.set(jsFrames.get() + 1);
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [jsFrames]);

  const props = useAnimatedProps(() => {
    const t = text.get();
    return { text: t, defaultValue: t } as object;
  });
  return (
    <AnimatedTextInput
      editable={false}
      pointerEvents="none"
      underlineColorAndroid="transparent"
      style={styles.hud}
      animatedProps={props}
      defaultValue="UI — fps · JS — fps"
    />
  );
}

const styles = StyleSheet.create({
  hud: {
    position: 'absolute',
    top: 4,
    left: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: 'rgba(0,0,0,0.65)',
    color: '#7CFC00',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
});
