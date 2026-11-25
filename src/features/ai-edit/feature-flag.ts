export type DeveloperFeatures = {
  developerBuild?: boolean;
  aiEditing?: boolean;
};

/** Store builds have neither development mode nor an explicitly marked developer build. */
export function aiEditingEnabled(development: boolean, flags?: DeveloperFeatures): boolean {
  return flags?.aiEditing !== false && (development || flags?.developerBuild === true);
}
