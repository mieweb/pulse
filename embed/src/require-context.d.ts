// Metro's `require.context` (Expo enables it), which `pulse-app.tsx` uses to load the app's routes.
declare namespace NodeJS {
  interface Require {
    context(
      directory: string,
      recursive?: boolean,
      filter?: RegExp,
    ): import('expo-router/build/types').RequireContext;
  }
}
