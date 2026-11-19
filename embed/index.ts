import { registerRootComponent } from 'expo';

import { EmbedRoot } from './src/embed-root';

// The component the host's PulseKit presents (module name "main").
registerRootComponent(EmbedRoot);
