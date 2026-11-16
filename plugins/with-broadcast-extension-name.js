const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

/**
 * Names the screen recorder's broadcast extension after the app. iOS lists broadcast extensions
 * by name in the broadcast sheet and in Control Center's Screen Recording list, and
 * react-native-nitro-screen-recorder's template sets both the display name and the bundle name to
 * the target's product name, "BroadcastExtension". The product name itself stays: the extension's
 * module and principal class are derived from it.
 *
 * It must be listed BEFORE `react-native-nitro-screen-recorder` in app.json: dangerous mods run
 * last-registered-first, so registering earlier makes this edit run after the library has copied
 * the extension's files into ios/.
 */
const TARGET = 'BroadcastExtension';

module.exports = function withBroadcastExtensionName(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const plist = path.join(cfg.modRequest.platformProjectRoot, TARGET, `${TARGET}-Info.plist`);
      if (!fs.existsSync(plist)) return cfg;
      const xml = fs.readFileSync(plist, 'utf8');
      let named = xml;
      for (const key of ['CFBundleDisplayName', 'CFBundleName']) {
        const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
        if (!pattern.test(named)) {
          throw new Error(`[with-broadcast-extension-name] no ${key} in ${plist}`);
        }
        named = named.replace(pattern, `$1${cfg.name}$2`);
      }
      fs.writeFileSync(plist, named);
      return cfg;
    },
  ]);
};
