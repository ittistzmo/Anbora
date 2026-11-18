import { useEffect } from "react";
import Svg, { Path, Circle } from "react-native-svg";
import Animated, { useSharedValue, useAnimatedProps, useAnimatedStyle, withTiming, withRepeat, withSequence, Easing, useReducedMotion } from "react-native-reanimated";
import { palette } from "../theme/tokens";

const AP = Animated.createAnimatedComponent(Path);
const AC = Animated.createAnimatedComponent(Circle);
const LEN = 200;

/** Two people whose arms form a heart (the negative space), cradled by a protective arc. */
export function AnboraMark({ size = 120, animate = true, breathing = false, mono }: { size?: number; animate?: boolean; breathing?: boolean; mono?: string }) {
  const reduce = useReducedMotion();
  const draw = useSharedValue(animate && !reduce ? 0 : 1);
  const breath = useSharedValue(1);
  useEffect(() => { if (animate && !reduce) draw.value = withTiming(1, { duration: 1400, easing: Easing.out(Easing.cubic) }); }, [animate, reduce]);
  useEffect(() => {
    breath.value = breathing && !reduce
      ? withRepeat(withSequence(withTiming(1.04, { duration: 2200 }), withTiming(1, { duration: 2200 })), -1) : 1;
  }, [breathing, reduce]);
  const line = useAnimatedProps(() => ({ strokeDashoffset: LEN * (1 - draw.value) }));
  const head = useAnimatedProps(() => ({ r: 9 * draw.value }));
  const wrap = useAnimatedStyle(() => ({ transform: [{ scale: breath.value }] }));
  const [a, b, c] = mono ? [mono, mono, mono] : [palette.teal, palette.coral, palette.mint];
  const p = { strokeWidth: 9, strokeLinecap: "round" as const, fill: "none", strokeDasharray: LEN };
  return (
    <Animated.View style={wrap} accessible accessibilityRole="image" accessibilityLabel="ANBORA logo">
      <Svg width={size} height={size} viewBox="0 0 120 120">
        <AP d="M16 66 A44 44 0 0 0 104 66" stroke={c} {...p} strokeWidth={4} animatedProps={line} />
        <AP d="M60 92 C34 76 26 58 40 50 C50 44 58 52 60 58" stroke={a} {...p} animatedProps={line} />
        <AP d="M60 92 C86 76 94 58 80 50 C70 44 62 52 60 58" stroke={b} {...p} animatedProps={line} />
        <AC cx={40} cy={31} fill={a} animatedProps={head} />
        <AC cx={80} cy={31} fill={b} animatedProps={head} />
      </Svg>
    </Animated.View>
  );
}
