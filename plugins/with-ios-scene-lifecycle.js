const { withAppDelegate, withInfoPlist } = require('@expo/config-plugins');

/**
 * SDK 27 builds abort at launch on iOS 27 without the scene lifecycle. Expo 57
 * supplies the scene delegate, but its prebuild template still starts React
 * Native from AppDelegate. Keep the migration here so clean prebuilds retain it.
 */
module.exports = function withIosSceneLifecycle(config) {
  config = withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error('[with-ios-scene-lifecycle] expected a Swift Expo AppDelegate');
    }
    let source = cfg.modResults.contents;
    const declaration = /class AppDelegate:\s*ExpoAppDelegate([^{]*)\{/;
    const match = source.match(declaration);
    if (!match) {
      throw new Error('[with-ios-scene-lifecycle] expected AppDelegate to extend ExpoAppDelegate');
    }
    const usesSceneFactory = match[1].includes('ExpoReactNativeFactoryProvider');
    if (!usesSceneFactory) {
      source = source.replace(
        declaration,
        (_, protocols) =>
          `class AppDelegate: ExpoAppDelegate${protocols.trimEnd()}, ExpoReactNativeFactoryProvider {`,
      );
    }

    const legacyStart =
      /#if os\(iOS\) \|\| os\(tvOS\)\s+window = UIWindow\(frame: UIScreen\.main\.bounds\)\s+factory\.startReactNative\(\s+withModuleName: "main",\s+in: window,\s+launchOptions: launchOptions\)\s+#endif/;
    if (legacyStart.test(source)) {
      source = source.replace(
        legacyStart,
        "    // ExpoAppSceneDelegate creates the scene's window and starts React Native.",
      );
    } else if (!usesSceneFactory || source.includes('factory.startReactNative(')) {
      throw new Error('[with-ios-scene-lifecycle] unrecognized React Native startup block');
    }
    cfg.modResults.contents = source;
    return cfg;
  });

  return withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: 'EXExpoAppSceneDelegate',
          },
        ],
      },
    };
    return cfg;
  });
};
