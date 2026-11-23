// The value type plist.mjs reads and writes. It lives here because a JSDoc @typedef can't refer to
// itself, and plist.mjs is type-checked (// @ts-check).
export type PlistValue =
  | string
  | number
  | bigint
  | boolean
  | { real: string }
  | { date: string }
  | { data: string }
  | PlistValue[]
  | Map<string, PlistValue>;
