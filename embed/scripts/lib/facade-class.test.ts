import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { FACADE_CLASS_SYMBOL, slicesMissingFacadeClass } from './facade-class.mjs';

// Trimmed from `nm -gU` on a local PulseKit build (with the facade) and on pulsekit-v0.1.0-rc.4's
// PulseKit (without it).
const WITH_FACADE = `0000000001473e10 S _OBJC_CLASS_$_PulseKit
000000000142b390 S _OBJC_CLASS_$__TtC8PulseKit22ReactNativeHostManager
0000000001438a08 S _OBJC_CLASS_$_PodsDummy_Pods_Pulse_PulseKit
`;
const WITHOUT_FACADE = `0000000001432ce8 S _OBJC_CLASS_$_HybridPulsePreviewComponent
0000000001438a08 S _OBJC_CLASS_$_PodsDummy_Pods_Pulse_PulseKit
000000000142b390 S _OBJC_CLASS_$__TtC8PulseKit22ReactNativeHostManager
`;
const LOOKALIKE = `0000000001473e10 S _OBJC_CLASS_$_PulseKitPresenter
0000000001473e18 S _OBJC_CLASS_$_PulseKitInfo
`;

const DEVICE = { id: 'ios-arm64', binaryPath: 'PulseKit.framework/PulseKit' };
const SIMULATOR = { id: 'ios-arm64-simulator', binaryPath: 'PulseKit.framework/PulseKit' };
const pulseKit = {
  name: 'PulseKit.xcframework',
  dir: '/in/PulseKit.xcframework',
  keep: [DEVICE, SIMULATOR],
};
const react = {
  name: 'React.xcframework',
  dir: '/in/React.xcframework',
  keep: [{ id: 'ios-arm64', binaryPath: 'React.framework/React' }],
};

/** An `inspect` that answers `nm` per binary path, and records what it was asked. */
function nmBy(outputs: Record<string, string | null>) {
  const calls: string[] = [];
  const inspect = (cmd: string, args: readonly string[]) => {
    expect(cmd).toBe('nm');
    expect(args[0]).toBe('-gU');
    calls.push(args[1]);
    return outputs[args[1]] ?? null;
  };
  return { inspect, calls };
}

const deviceBinary = '/in/PulseKit.xcframework/ios-arm64/PulseKit.framework/PulseKit';
const simulatorBinary = '/in/PulseKit.xcframework/ios-arm64-simulator/PulseKit.framework/PulseKit';

describe('slicesMissingFacadeClass', () => {
  it('passes when every kept PulseKit slice exports the facade class', () => {
    const { inspect, calls } = nmBy({
      [deviceBinary]: WITH_FACADE,
      [simulatorBinary]: WITH_FACADE,
    });
    expect(slicesMissingFacadeClass([pulseKit], inspect)).toEqual([]);
    expect(calls).toEqual([deviceBinary, simulatorBinary]);
  });

  it('names the device slice when only it lacks the class', () => {
    const { inspect } = nmBy({ [deviceBinary]: WITHOUT_FACADE, [simulatorBinary]: WITH_FACADE });
    expect(slicesMissingFacadeClass([pulseKit], inspect)).toEqual([
      'PulseKit.xcframework/ios-arm64',
    ]);
  });

  it('names the simulator slice when only it lacks the class', () => {
    const { inspect } = nmBy({ [deviceBinary]: WITH_FACADE, [simulatorBinary]: WITHOUT_FACADE });
    expect(slicesMissingFacadeClass([pulseKit], inspect)).toEqual([
      'PulseKit.xcframework/ios-arm64-simulator',
    ]);
  });

  it("doesn't count a class whose name only starts with PulseKit", () => {
    const { inspect } = nmBy({ [deviceBinary]: LOOKALIKE, [simulatorBinary]: WITH_FACADE });
    expect(slicesMissingFacadeClass([pulseKit], inspect)).toEqual([
      'PulseKit.xcframework/ios-arm64',
    ]);
  });

  it('reads nothing but PulseKit', () => {
    const { inspect, calls } = nmBy({
      [deviceBinary]: WITH_FACADE,
      [simulatorBinary]: WITH_FACADE,
    });
    slicesMissingFacadeClass([react, pulseKit], inspect);
    expect(calls).toEqual([deviceBinary, simulatorBinary]);
  });

  it('reports nothing in a dry run, where inspect has no output to read', () => {
    const { inspect, calls } = nmBy({});
    expect(slicesMissingFacadeClass([pulseKit], inspect)).toEqual([]);
    expect(calls).toEqual([deviceBinary, simulatorBinary]);
  });

  it('looks for the facade class by its exact name', () => {
    expect(FACADE_CLASS_SYMBOL).toBe('_OBJC_CLASS_$_PulseKit');
  });
});

describe('package-ios.mjs', () => {
  it('refuses a framework without the facade class before it removes an earlier run’s output', () => {
    const source = readFileSync(path.join(__dirname, '..', 'package-ios.mjs'), 'utf8');
    const gate = source.indexOf('slicesMissingFacadeClass(jobs');
    const removal = source.indexOf('runner.remove(out)');
    expect(gate).toBeGreaterThan(-1);
    expect(removal).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(removal);
  });
});
