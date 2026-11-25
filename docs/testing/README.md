# Notes for a local test build

For phone handoffs with local or uncommitted changes, set `PULSE_TEST_NOTES_FILE`
to a JSON file containing this app's version, a `YYYY-MM-DD` date and a nonempty
`notes` array. Use concrete app paths, actions, expected results and relevant
limitations so the user can test from **About → Release notes**.

For example, prepare the Summary build with:

```sh
PULSE_TEST_NOTES_FILE=docs/testing/summary-test-notes.json npx expo config --type public --json
PULSE_TEST_NOTES_FILE=docs/testing/summary-test-notes.json npx expo export:embed --platform ios --dev false --entry-file node_modules/expo-router/entry.js --bundle-output /path/to/Pulse.app/main.jsbundle --assets-dest /path/to/Pulse.app
```

Use the same setting when generating the app bundle and the Expo config copied
into a reused native shell. Inspect that final app's `EXConstants.bundle/app.config`
and check the notes in the simulator before signing and installing it.

The explicit file replaces only the current build's notes; earlier release
history is retained. Missing, malformed or wrong-version input fails configuration
instead of silently shipping stale notes. Without the setting, notes continue to
come from Git. CI ignores the local override and uses the normal release notes.
