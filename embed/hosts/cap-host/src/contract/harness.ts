/**
 * A tiny test runner for the phone: describe / it / expect, enough for runPulseContract (it takes
 * the framework's functions, and uses only `toBe` and `toEqual`). Tests run one after another, in
 * the order they were declared.
 */

export type Outcome = { name: string; ok: boolean; ms: number; error?: string };

type Test = { name: string; run: () => Promise<void> | void };

/** Deep equality for JSON values: what jest's toEqual means for them. */
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    equal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

const show = (v: unknown) => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

export function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (!Object.is(actual, expected)) {
        throw new Error(`expected ${show(expected)}, got ${show(actual)}`);
      }
    },
    toEqual(expected: unknown) {
      if (!equal(actual, expected)) {
        throw new Error(`expected ${show(expected)}, got ${show(actual)}`);
      }
    },
  };
}

export function createHarness() {
  const tests: Test[] = [];
  const path: string[] = [];
  return {
    describe(name: string, body: () => void) {
      path.push(name);
      try {
        body();
      } finally {
        path.pop();
      }
    },
    it(name: string, run: () => Promise<void> | void) {
      tests.push({ name: [...path, name].join(' › '), run });
    },
    expect,
    /** The declared tests' names, in order. */
    names: () => tests.map((t) => t.name),
    /** Runs every test, reporting each as it ends. */
    async run(report: (o: Outcome) => void): Promise<Outcome[]> {
      const out: Outcome[] = [];
      for (const t of tests) {
        const started = Date.now();
        let o: Outcome;
        try {
          await t.run();
          o = { name: t.name, ok: true, ms: Date.now() - started };
        } catch (e) {
          const error = e instanceof Error ? e.message : show(e);
          o = { name: t.name, ok: false, ms: Date.now() - started, error };
        }
        out.push(o);
        report(o);
      }
      return out;
    },
  };
}
